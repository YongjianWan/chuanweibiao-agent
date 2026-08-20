"""S2: 评审点/评分项 -> 章节定位。

打分基于 IDF 加权的词命中，而不是词覆盖率。
理由：评审点名称切出来的词里，"设计/方案/管理/措施"这类通用词在任何一份标书里
都遍地都是，用覆盖率算会让每个评审点都匹配上一堆无关章节。IDF 让通用词权重自动
归零、领域特征词（深基坑/冬雨季/TN-S）权重拉满，同时省掉了手工停用词表。

允许未命中：投标文件里确实没写这项，就该是零证据 -> 该项直接判 0 分。
这比硬凑一段不相关的原文喂给模型要安全得多。

输出每项一个证据包，字数受 budget 硬约束 —— 这是整个方案的算力开关。
"""
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import yaml

from build_points import build_terms

W_TITLE = 3.0      # 命中标题链 = 命中正文的 3 倍权重
# hit 标记前缀：大写=完整短语命中，小写=单词命中；T/t=命中标题链，B/b=命中正文
# 词的区分度用 DF 占比衡量，不用 IDF 绝对值：IDF 绝对值随语料篇数变化，
# 同一个词在 20 篇语料和 2000 篇语料里能差一倍，阈值就成了随语料漂移的魔数。
MAX_DF_RATIO = 0.22       # 出现在超过 22% 章节里的词无区分度，打分时丢弃
ANCHOR_DF_RATIO = 0.05    # 出现在不到 5% 章节里的词才算领域特征词，可当锚点
MIN_SCORE = 8.0           # 证据门槛，低于此视为未命中
BUDGET = 3000
MAX_SEC = 6


def build_idf(sections, vocab):
    """在本次文档集内计算 DF -> IDF。词表只算评审点用到的词，不做全量。"""
    df = defaultdict(int)
    for sec in sections:
        blob = sec["text"] + " " + " ".join(sec["path"])
        for w in vocab:
            if w in blob:
                df[w] += 1
    n = len(sections)
    return {w: math.log((n + 1) / (df[w] + 1)) for w in vocab}, df


def score_section(sec, phrases, terms, idf, df, n):
    title = " ".join(sec["path"])
    body = sec["text"]
    s, hit = 0.0, []

    for ph in phrases:                       # 完整短语命中：强信号，按其最罕见成分计权
        w = max((idf.get(t, 0) for t in terms if t in ph), default=0)
        if ph in title:
            s += (w + 2.0) * W_TITLE
            hit.append(f"T:{ph}")
        elif ph in body:
            s += w + 2.0
            hit.append(f"B:{ph}")

    for t in terms:                          # 单词命中：按 IDF 计权
        w = idf.get(t, 0)
        if df.get(t, 0) > n * MAX_DF_RATIO:   # 通用词，没有区分度
            continue
        if t in title:
            s += w * W_TITLE
            hit.append(f"t:{t}")
        elif t in body:
            s += w
            hit.append(f"b:{t}")

    if s and sec["char_len"] > 8000:
        s *= 0.5
    return s, hit


def anchor(terms, df, n, pool_text=None):
    """该评审点的领域锚点 = 最罕见的那一个词，也就是最能区分它的词。

    取最罕见的一个而不是一批：取一批再 any() 命中，等于最通用的那个词说了算，闸门失效。

    锚点 DF 为 0 时不换词。DF=0 意味着这份投标文件里根本没有这个概念，
    这是「该项未写」的最强信号，应当直接导向未命中。
    退而求其次挑个次罕见的词接着找，只会放行一堆无关内容——实测中「平面布置」DF=0，
    换成「布置」（DF=9，出现在"布置任务"之类）后，命中了完全无关的验收交付章节。

    GUID 绑定后检索池收窄到单个 PDF，全局最罕见的词可能不在当前池内。
    此时允许换成当前池内存在的罕见词（仍须满足 ANCHOR_DF_RATIO），否则该池内
    确实找不到该主题的任何章节。DF=0 的词仍然不换，守住「概念不存在」的最强信号。

    评审点用词与标书用词不同（「四新技术」对「新技术、新工艺」）属于同义词问题，
    解法是在映射配置里补同义词，不是让检索去猜。

    名称全是通用词的评审点没有锚点（返回 None），此时不设闸。
    """
    cands = [t for t in terms if df.get(t, 0) <= n * ANCHOR_DF_RATIO]
    if not cands:
        return None

    rarest = min(cands, key=lambda x: df.get(x, 0))

    # GUID 绑定路径下 pool_text 是当前 PDF 的全部文本。
    # 若全局最罕见词不在当前池内，但在全局 DF>0（说明投标人写过这个概念，
    # 只是用词落在当前池的其他罕见词上），则改用池内存在的罕见词，避免误杀。
    if (
        pool_text is not None
        and df.get(rarest, 0) > 0
        and rarest not in pool_text
    ):
        pool_cands = [t for t in cands if df.get(t, 0) > 0 and t in pool_text]
        if pool_cands:
            return min(pool_cands, key=lambda x: df.get(x, 0))

    return rarest


def _rank(sections, phrases, terms, idf, df, n=None):
    """在 sections 里排出候选块。

    `n` 是 DF 的统计基大小，默认等于检索池大小。评分表路径下两者不同：
    检索池收窄到单个 PDF，而 DF 仍按该家全部 20 个 PDF 统计（README §3.2 红线一），
    此时必须显式传入 n，否则 MAX_DF_RATIO / ANCHOR_DF_RATIO 会按几百块去判占比，
    通用词过滤和锚点闸门一起失效。
    """
    n = len(sections) if n is None else n
    pool_text = " ".join(
        sec["text"] + " " + " ".join(sec["path"]) for sec in sections
    )
    anc = anchor(terms, df, n, pool_text)
    if anc is not None and df.get(anc, 0) == 0:
        return []          # 该主题在本文件中不存在，直接未命中
    out = []
    for sec in sections:
        if anc:  # 领域锚点没出现 -> 这章根本不是在讲这件事
            if anc not in sec["text"] and anc not in " ".join(sec["path"]):
                continue
        s, hit = score_section(sec, phrases, terms, idf, df, n)
        if s >= MIN_SCORE:
            out.append((s, hit, sec))
    out.sort(key=lambda x: -x[0])
    return out


def unit_key(sec):
    """证据单元的键 = 文件 + 该章节块的直接父章节路径。

    检索在细粒度章节块上做，收取时按整个父章节收。原因：章节块中位数只有 300 字，
    一个评分项的内容常横跨十几个相邻小节；逐块收会收到一堆互不相邻的碎片，
    喂给模型的上下文是跳跃的。按父章节收，拿到的是连贯的一整节，和人读标书的方式一致。

    用「直接父章节」而不是固定的第 N 级：投标文件的标题深度各不相同，固定层级会把
    深层小节归并到大章之下，单元过大，排序被大单元里的偶然高分块带偏（实测发生过）。
    父章节这个粒度随文档结构自适应，也省掉一个需要调的参数。
    """
    return (sec["file"], tuple(sec["path"][:-1]) or tuple(sec["path"]))


def pick_units(scored, by_unit, budget, with_page=False):
    """把候选块按证据单元归并、按 budget 收取，返回 (picked, 已用字数, 单元数)。

    单元得分取组内最高分；收取时收下该单元的全部章节块，保持文档原顺序（§3.3）。
    `with_page=True` 时透传 `page` 字段——评分表路径需要它给页面⑤跳转 PDF 页用，
    旧的评审点路径跑在 docx 样例上、没有该字段，故默认不带。
    """
    units, best = {}, {}
    for sc, hit, sec in scored:
        k = unit_key(sec)
        if sc > best.get(k, -1):
            best[k] = sc
            units.setdefault(k, {})["top"] = (sc, hit, sec)
    order = sorted(units, key=lambda k: -best[k])[:MAX_SEC]

    picked, used = [], 0
    for k in order:
        if used >= budget:
            break
        sc, hit, _ = units[k]["top"]
        members = [x for x in by_unit.get(k, []) if used < budget]
        for sec in members:
            if used >= budget:
                break
            take = min(sec["char_len"], budget - used)
            row = {
                "section_id": sec["id"], "file": sec["file"], "path": sec["path"],
                "unit": list(k[1]), "match_score": round(sc, 1), "hit": hit[:6],
                "chars": take, "truncated": take < sec["char_len"],
            }
            if with_page:
                row["page"] = sec.get("page")
            picked.append(row)
            used += take
    return picked, used, len(order)


def locate(sections, cats, budget=BUDGET):
    vocab = set()
    for c in cats:
        vocab |= set(c["terms"])
        for p in c["points"]:
            vocab |= set(p["terms"])
    idf, df = build_idf(sections, vocab)

    by_unit = {}
    for sec in sections:
        by_unit.setdefault(unit_key(sec), []).append(sec)

    results = []
    for cat in cats:
        for p in cat["points"]:
            scored = _rank(sections, p["phrases"], p["terms"], idf, df)
            fallback = False
            if not scored:
                scored = _rank(sections, cat["phrases"], cat["terms"], idf, df)
                fallback = bool(scored)

            picked, used, n_units = pick_units(scored, by_unit, budget)
            results.append({
                "point_id": p["id"], "cat": cat["name"], "name": p["name"],
                "candidates": len(scored), "units": n_units, "fallback": fallback,
                "picked": picked, "evidence_chars": used,
            })
    return results, idf, df

# ===== 评分表路径（T8）：按评分项检索，检索范围收窄到单个 PDF =====
#
# 与上面的评审点路径的区别，见 README §2.1：评分项与投标 PDF 由文件名尾部的 GUID
# 一一绑定，所以「从 87 万字的标书里找某评分项的证据」降级成「打开对应的那一个 PDF」。
# 跨文件定位不再需要算法，S2 只负责单个 PDF 内部的压缩。
#
# 两条路径共用 build_idf / _rank / anchor / score_section / unit_key / pick_units，
# README §3.2 的三条红线因此对两条路径同时生效，由 tests/test_s2_regression.py 守住。

BUDGET_MIN, BUDGET_MAX = 1500, 6000


def budget_for(max_score, total_score, n_items, base=BUDGET):
    """证据字数上限按分值分配，不是全项统一常数。算式与理由见 docs/data-contract.md §5。

    基准 3000、19 项、总分 100 时：20 分项得 6000（触上限），4 分项得 2280，3 分项得 1710。
    上下限防止 3 分项被压到无法判断、20 分项一项吃掉大半预算。
    """
    raw = base * n_items * max_score / total_score
    return int(min(max(raw, BUDGET_MIN), BUDGET_MAX))


def search_terms(entries):
    """检索词条目列表 -> (phrases, terms)。

    条目 = 评分表里的一条 `aspects` 或 `synonyms`，整条即「短语」；
    切分后的成分是「单词」。两级的含义与 hit 前缀的对应关系见 docs/data-contract.md §5。
    """
    phrases, terms = [], []
    for entry in entries:
        if not entry:
            continue
        ph, tm = build_terms(str(entry))
        for x in ph:
            if x not in phrases:
                phrases.append(x)
        for x in tm:
            if x not in terms:
                terms.append(x)
    return phrases, terms


def locate_items(sections, items, base_budget=BUDGET):
    """一家投标人 × 全部评分项 -> 证据包列表（docs/data-contract.md §5）。

    `sections` 必须是该家**全部** 20 个 PDF 的章节块：DF 统计基取全部（红线一），
    而每个评分项的检索池按 `item_guid` 收窄到它对应的那一个 PDF。
    """
    total_score = sum(float(it["max_score"]) for it in items)
    n_items = len(items)

    vocab = set()
    prepared = []
    for it in items:
        ph, tm = search_terms(list(it.get("aspects") or []) + list(it.get("synonyms") or []))
        fb_ph, fb_tm = search_terms([it["name"]])
        prepared.append((it, ph, tm, fb_ph, fb_tm))
        vocab |= set(tm) | set(fb_tm)
    idf, df = build_idf(sections, vocab)
    n_df = len(sections)                      # DF 基 = 该家全部 20 个 PDF

    by_guid = {}
    for sec in sections:
        by_guid.setdefault((sec.get("item_guid") or "").lower(), []).append(sec)

    results = []
    for it, ph, tm, fb_ph, fb_tm in prepared:
        pool = by_guid.get(str(it["guid"]).lower(), [])
        by_unit = {}
        for sec in pool:
            by_unit.setdefault(unit_key(sec), []).append(sec)

        scored = _rank(pool, ph, tm, idf, df, n_df)
        fallback = False
        if not scored:                        # aspects 级检索不到，退到评分项名级
            scored = _rank(pool, fb_ph, fb_tm, idf, df, n_df)
            fallback = bool(scored)

        budget = budget_for(float(it["max_score"]), total_score, n_items, base_budget)
        picked, used, n_units = pick_units(scored, by_unit, budget, with_page=True)
        results.append({
            "item_id": it["id"], "item_guid": str(it["guid"]).lower(), "name": it["name"],
            "candidates": len(scored), "units": n_units, "fallback": fallback,
            "evidence_chars": used, "budget": budget, "pool_sections": len(pool),
            "picked": picked,
        })
    return results


def run_project(project_dir, scoring_path, base_budget=BUDGET):
    """遍历 data/projects/<slug>/sections/<bidder>/，每家产出一份 located.json。

    `bidder` 取投标文件所在的一级目录名，原样照抄（README §2 术语表）——
    它是报告数据 matrix/totals 的键，12 家写法必须完全一致。
    """
    project_dir = Path(project_dir)
    items = yaml.safe_load(Path(scoring_path).read_text(encoding="utf-8"))["items"]
    sec_root = project_dir / "sections"
    bidders = sorted(d.name for d in sec_root.iterdir() if (d / "sections.json").is_file())
    if not bidders:
        sys.exit(f"{sec_root} 下没有投标人目录，先按 README §10.1 跑 S1")

    summary = []
    for bidder in bidders:
        sections = json.loads((sec_root / bidder / "sections.json").read_text(encoding="utf-8"))
        res = locate_items(sections, items, base_budget)
        for r in res:
            r["bidder"] = bidder
        out = project_dir / "evidence" / bidder / "located.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
        summary.append((bidder, res, len(sections)))
    return summary


def main(sections_path, points_path, out_path):
    sections = json.loads(Path(sections_path).read_text(encoding="utf-8"))
    cats = yaml.safe_load(Path(points_path).read_text(encoding="utf-8"))

    res, idf, df = locate(sections, cats)
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps(res, ensure_ascii=False, indent=1),
                              encoding="utf-8")

    raw = sum(s["char_len"] for s in sections)
    ev = sum(r["evidence_chars"] for r in res)
    direct = [r for r in res if r["picked"] and not r["fallback"]]
    fb = [r for r in res if r["fallback"]]
    miss = [r for r in res if not r["picked"]]
    print(f"评审点 {len(res)}   原文 {raw:,} 字   章节 {len(sections):,}")
    print(f"直接命中 {len(direct)}   降级命中 {len(fb)}   未命中 {len(miss)}")
    print(f"证据 {ev:,} 字  平均 {ev//max(len(res),1):,} 字/项  压缩 {raw/max(ev,1):.0f}x")
    dropped = [w for w in idf if df[w] > len(sections) * MAX_DF_RATIO]
    print(f"IDF 过滤掉的通用词 {len(dropped)}/{len(idf)}: {' '.join(sorted(dropped)[:12])}")
    if miss:
        print("未命中(投标文件确实没写 -> 该项判0分):")
        for m in miss[:14]:
            print(f"   {m['point_id']:6s} {m['name'][:34]}")
    print(f"-> {out_path}")


if __name__ == "__main__":
    main(*sys.argv[1:4])

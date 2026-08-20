"""S2: 评审点/评分项 -> 章节定位。

打分基于 IDF 加权的词命中，而不是词覆盖率。
理由：评审点名称切出来的词里，"设计/方案/管理/措施"这类通用词在任何一份标书里
都遍地都是，用覆盖率算会让每个评审点都匹配上一堆无关章节。IDF 让通用词权重自动
归零、领域特征词（深基坑/冬雨季/TN-S）权重拉满，同时省掉了手工停用词表。

允许未命中：投标文件里确实没写这项，就该是零证据 -> 该项直接判 0 分。
这比硬凑一段不相关的原文喂给模型要安全得多。

输出每项一个证据包，字数受 budget 硬约束 —— 这是整个方案的算力开关。

T8 起支持两种输入：
- 旧版：评审点格式（config/review_points.yaml），见 locate() / main_legacy()，
  保留给 tests/test_s2_regression.py 守住 §3.2 三条红线。
- 新版：项目评分表格式（config/projects/<项目>.yaml），见 load_scoring_table() /
  locate_project() / locate_bidder()。检索范围收窄到评分项 GUID 对应的单个 PDF，
  DF/IDF 统计基仍取该投标人全部章节块（README §3.2 红线一）。
"""
import argparse
import json
import math
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import yaml

W_TITLE = 3.0      # 命中标题链 = 命中正文的 3 倍权重
# hit 标记前缀：大写=完整短语命中，小写=单词命中；T/t=命中标题链，B/b=命中正文
# 词的区分度用 DF 占比衡量，不用 IDF 绝对值：IDF 绝对值随语料篇数变化，
# 同一个词在 20 篇语料和 2000 篇语料里能差一倍，阈值就成了随语料漂移的魔数。
MAX_DF_RATIO = 0.22       # 出现在超过 22% 章节里的词无区分度，打分时丢弃
ANCHOR_DF_RATIO = 0.05    # 出现在不到 5% 章节里的词才算领域特征词，可当锚点
MIN_SCORE = 8.0           # 证据门槛，低于此视为未命中
BUDGET = 3000
MAX_SEC = 6


def _match_text(text):
    """返回仅供检索的文本副本，不改动章节块里的原始 ``text``。

    PyMuPDF 抽取的是视觉行，S1 会把每一行用 ``\\n`` 拼进章节块；
    Windows/其他来源还可能带 ``\\r\\n``。S2 的短语、词和锚点都是
    子串匹配，换行会把本来连续的中文词拆开，进而造成 DF=0、分数下降，
    甚至把已有内容误判成未命中。

    这里只在匹配副本中移除换行符：证据包最终仍按原始 ``text`` 截取，
    因而不会改变引用原文、``char_len`` 或页面定位。
    """
    return text.replace("\r", "").replace("\n", "")


def build_idf(sections, vocab):
    """在本次文档集内计算 DF -> IDF。词表只算评审点用到的词，不做全量。"""
    df = defaultdict(int)
    for sec in sections:
        blob = _match_text(sec["text"]) + " " + " ".join(sec["path"])
        for w in vocab:
            if w in blob:
                df[w] += 1
    n = len(sections)
    return {w: math.log((n + 1) / (df[w] + 1)) for w in vocab}, df


def score_section(sec, phrases, terms, idf, df, n):
    title = " ".join(sec["path"])
    # 匹配副本去掉 PDF 视觉折行（文本内部可能含 \r\n 或 \n）；原始 text 保留给证据引用。
    body = sec["text"].replace("\r", "").replace("\n", "")
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


def anchor(terms, df, n):
    """该评审点的领域锚点 = 最罕见的那一个词，也就是最能区分它的词。

    取最罕见的一个而不是一批：取一批再 any() 命中，等于最通用的那个词说了算，闸门失效。

    锚点 DF 为 0 时不换词。DF=0 意味着这份投标文件里根本没有这个概念，
    这是「该项未写」的最强信号，应当直接导向未命中。
    退而求其次挑个次罕见的词接着找，只会放行一堆无关内容——实测中「平面布置」DF=0，
    换成「布置」（DF=9，出现在"布置任务"之类）后，命中了完全无关的验收交付章节。

    评审点用词与标书用词不同（「四新技术」对「新技术、新工艺」）属于同义词问题，
    解法是在映射配置里补同义词，不是让检索去猜。

    名称全是通用词的评审点没有锚点（返回 None），此时不设闸。
    """
    cands = [t for t in terms if df.get(t, 0) <= n * ANCHOR_DF_RATIO]
    return min(cands, key=lambda x: df.get(x, 0)) if cands else None


def _rank(sections, phrases, terms, idf, df, df_n=None):
    """Rank candidate sections using DF statistics from a separate corpus.

    ``sections`` is the candidate pool (one PDF in T8); ``df_n`` is the
    number of sections in the corpus used by ``build_idf`` (all PDFs for
    that bidder).  The legacy caller omits it and therefore uses its own
    candidate corpus size.
    """
    n = len(sections) if df_n is None else df_n
    anc = anchor(terms, df, n)
    if anc is not None and df.get(anc, 0) == 0:
        return []          # 该主题在本文件中不存在，直接未命中
    out = []
    for sec in sections:
        if anc:  # 领域锚点没出现 -> 这章根本不是在讲这件事
            if anc not in _match_text(sec["text"]) and anc not in " ".join(sec["path"]):
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

            # 命中的块按证据单元归并，单元得分取组内最高分
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
                # 收下该单元的全部章节块，保持文档原顺序
                members = [x for x in by_unit.get(k, []) if used < budget]
                for sec in members:
                    if used >= budget:
                        break
                    take = min(sec["char_len"], budget - used)
                    picked.append({
                        "section_id": sec["id"], "file": sec["file"], "path": sec["path"],
                        "unit": list(k[1]), "match_score": round(sc, 1), "hit": hit[:6],
                        "chars": take, "truncated": take < sec["char_len"],
                    })
                    used += take
            results.append({
                "point_id": p["id"], "cat": cat["name"], "name": p["name"],
                "candidates": len(scored), "units": len(order), "fallback": fallback,
                "picked": picked, "evidence_chars": used,
            })
    return results, idf, df


# ── T8：项目评分表格式 ──────────────────────────────────────────────────

@dataclass
class ScoringItem:
    item_id: str
    guid: str
    name: str
    max_score: float
    tiers: list[dict]
    aspects: list[str]
    synonyms: list[str]


@dataclass
class EvidencePackage:
    item_id: str
    item_guid: str
    bidder: str
    name: str
    candidates: int
    units: int
    fallback: bool
    evidence_chars: int
    budget: int
    picked: list[dict]

    def as_dict(self):
        return vars(self)


def load_scoring_table(path):
    """读取项目评分表 YAML，返回 19 个 ScoringItem。guid 统一转小写。"""
    data = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    items = []
    for it in data.get("items", []):
        items.append(ScoringItem(
            item_id=it["id"],
            guid=str(it.get("guid", "")).strip().lower(),
            name=it["name"],
            max_score=float(it["max_score"]),
            tiers=it.get("tiers", []) or [],
            aspects=list(it.get("aspects", []) or []),
            synonyms=list(it.get("synonyms", []) or []),
        ))
    return items


def calc_budget(max_score, total_score=100.0, n_items=19,
                base_budget=3000, lo=1500, hi=6000):
    """按分值分配预算（data-contract.md §5）。

    budget_i = clamp(基准预算 × 项数 × max_score_i / 总分, 1500, 6000)
    20 分项触上限 6000，4 分项 2280，3 分项 1710。
    """
    raw = base_budget * n_items * float(max_score) / total_score
    return max(lo, min(hi, int(raw)))


def _tokenize(text):
    """切词：优先 jieba，失败退化为 2-gram。"""
    try:
        import jieba
        jieba.setLogLevel(20)
        return [w.strip() for w in jieba.cut(text) if len(w.strip()) >= 2]
    except ImportError:
        return [text[i:i + 2] for i in range(max(0, len(text) - 1))]


def _terms(phrases):
    out = set()
    for ph in phrases:
        if ph:
            out.update(_tokenize(ph))
    return out


def _empty_package(item, budget, bidder=""):
    return EvidencePackage(
        item_id=item.item_id, item_guid=item.guid, bidder=bidder, name=item.name,
        candidates=0, units=0, fallback=False, evidence_chars=0,
        budget=budget, picked=[])


def locate_item(sections_all, item, budget=None, bidder=None):
    """在评分项 GUID 对应的单个 PDF 内定位证据。

    - 候选池：sections_all 中 item_guid == item.guid 的块（单个 PDF）
    - DF/IDF 统计基：sections_all 全部块（该投标人全部 20 个 PDF，红线一）
    - 每个 aspect / synonym 是独立检索维度，各自算锚点（红线二）。
      一个维度的锚点 DF=0 只让该维度落空，不连累其他维度。
    - 全部维度落空才退到评分项名级，标 fallback=True（data-contract §5）。

    ``bidder`` 可由直接调用者显式传入；省略时尝试从章节块读取。
    """
    budget = calc_budget(item.max_score) if budget is None else budget
    scoped = [s for s in sections_all
              if str(s.get("item_guid", "")).lower() == item.guid]
    if not scoped:
        return _empty_package(item, budget, bidder or "")

    bidder = bidder or next((s.get("bidder") for s in scoped
                             if s.get("bidder")), "")

    dimensions = [ph for ph in item.aspects if ph]
    for syn in item.synonyms:
        if syn and syn not in dimensions:
            dimensions.append(syn)

    vocab = (_terms(dimensions) | _terms([item.name])) if dimensions else set()
    idf, df = build_idf(sections_all, vocab)

    # 每个维度独立检索，命中的块按单元键取最高分合并去重
    merged = {}
    candidate_count = 0
    for dim in dimensions:
        dim_terms = _terms([dim])
        dim_scored = _rank(scoped, [dim], dim_terms, idf, df,
                           df_n=len(sections_all))
        candidate_count += len(dim_scored)
        for sc, hit, sec in dim_scored:
            k = unit_key(sec)
            if sc > merged.get(k, (float("-inf"),))[0]:
                merged[k] = (sc, hit, sec)
    scored = list(merged.values())

    fallback = False
    if not scored and item.name:
        name_terms = _terms([item.name])
        scored = _rank(scoped, [item.name], name_terms, idf, df,
                       df_n=len(sections_all))
        fallback = bool(scored)

    # 按证据单元归并
    by_unit = {}
    for sec in scoped:
        by_unit.setdefault(unit_key(sec), []).append(sec)
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
            picked.append({
                "section_id": sec["id"], "file": sec["file"], "path": sec["path"],
                "unit": list(k[1]), "page": sec.get("page"),
                "match_score": round(sc, 1), "hit": hit[:6],
                "chars": take, "truncated": take < sec["char_len"],
            })
            used += take

    return EvidencePackage(
        item_id=item.item_id, item_guid=item.guid, bidder=bidder, name=item.name,
        candidates=candidate_count, units=len(order), fallback=fallback,
        evidence_chars=used, budget=budget, picked=picked)


def locate_project(sections, scoring, bidder=None):
    """对一家投标人的全部评分项定位证据，返回 dict 列表（JSON 可序列化）。

    scoring 可以是 load_scoring_table() 返回的 ScoringItem 列表。
    """
    if bidder is None:
        bidder = next((s.get("bidder") for s in sections if s.get("bidder")), "")
    results = []
    for item in scoring:
        pkg = locate_item(sections, item)
        pkg.bidder = bidder
        results.append(pkg.as_dict())
    return results


def locate_bidder(sections_path, scoring_path, output_path, bidder_id):
    """读单家 sections.json + 项目评分表，输出 located.json。"""
    sections = json.loads(Path(sections_path).read_text(encoding="utf-8"))
    if not isinstance(sections, list):
        raise ValueError(f"{sections_path} 顶层必须是数组（单家 sections.json）")
    for s in sections:
        s["bidder"] = bidder_id

    scoring = load_scoring_table(scoring_path)
    results = locate_project(sections, scoring, bidder_id)

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    Path(output_path).write_text(
        json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")

    evidence = sum(r["evidence_chars"] for r in results)
    miss = sum(1 for r in results if not r["picked"])
    fb = sum(1 for r in results if r["fallback"])
    print(f"{bidder_id}: {len(results)} 项  未命中 {miss}  降级 {fb}  证据 {evidence:,} 字")
    return results


# ── CLI ────────────────────────────────────────────────────────────────

def main_legacy(sections_path, points_path, out_path):
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


def main_cli(argv):
    parser = argparse.ArgumentParser(description="S2：评分项证据定位")
    parser.add_argument("--sections", help="单家 sections.json 路径")
    parser.add_argument("--scoring-table", "--scoring", required=True,
                        help="项目评分表 YAML 路径")
    parser.add_argument("--output", help="单家 located.json 输出路径")
    parser.add_argument("--bidder", help="投标人目录名（单家模式必填）")
    parser.add_argument("--project", help="项目目录，批量处理 manifest 里全部投标人")
    parser.add_argument("--evidence-dir", help="批量证据输出目录（默认 <project>/evidence）")
    args = parser.parse_args(argv)

    if args.project:
        project = Path(args.project)
        manifest_path = project / "manifest.json"
        if not manifest_path.exists():
            parser.error(f"项目目录缺少 manifest.json: {project}")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        bidders = [b["id"] for b in manifest.get("bidders", [])]
        evidence_dir = (Path(args.evidence_dir) if args.evidence_dir
                        else project / "evidence")
        for bidder_id in bidders:
            sections_path = project / "sections" / bidder_id / "sections.json"
            if not sections_path.exists():
                print(f"[跳过] {bidder_id}: 缺少 sections.json")
                continue
            locate_bidder(sections_path, args.scoring_table,
                          evidence_dir / bidder_id / "located.json", bidder_id)
        return

    if not (args.sections and args.output and args.bidder):
        parser.error("单家模式需要 --sections、--output、--bidder")
    locate_bidder(args.sections, args.scoring_table, args.output, args.bidder)


if __name__ == "__main__":
    if len(sys.argv) >= 4 and not sys.argv[1].startswith("-"):
        main_legacy(sys.argv[1], sys.argv[2], sys.argv[3])
    else:
        main_cli(sys.argv[1:])

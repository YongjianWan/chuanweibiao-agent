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


def _rank(sections, phrases, terms, idf, df):
    n = len(sections)
    anc = anchor(terms, df, n)
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

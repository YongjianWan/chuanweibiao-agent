"""评审点.md -> config/review_points.yaml

md 里每个评审点的正文是同一段模板换名词，没有信息量，全部丢弃。
只保留名称，并生成两级检索词：
  phrases — 完整词组，用于标题链精确匹配（高权重）
  terms   — jieba 切出的实词，用于正文覆盖率匹配（低权重）
两级是必要的：评审点名称都是"施工组织总体设计，方案针对性及施工段划分"这种
长复合短语，整串在正文里几乎不会原样出现，必须降到词一级才匹配得上。
"""
import re
import sys
from pathlib import Path

import jieba
import yaml

CAT = re.compile(r"^([①-⑳])(.+?)(?:智能评审)?$")
SUB = re.compile(r"^(\d+)[）)]\s*(.+)$")
SPLIT = re.compile(r"[、，,和及与（）()]+")
# 全领域高频虚词，单独出现没有区分度
STOP = {"要求", "内容", "计划", "管理", "体系", "建设", "工程", "项目", "进行",
        "以及", "对应", "相关", "各种", "有关", "并", "的", "等", "及"}


def build_terms(name: str):
    phrases = [p.strip() for p in SPLIT.split(name) if len(p.strip()) >= 2]
    if name not in phrases:
        phrases.insert(0, name)
    terms = []
    for ph in phrases:
        for w in jieba.cut(ph):
            w = w.strip()
            if len(w) >= 2 and w not in STOP and w not in terms:
                terms.append(w)
    return phrases, terms


def main(md_path, out_path):
    lines = Path(md_path).read_text(encoding="utf-8").splitlines()
    cats, cur = [], None
    for ln in lines:
        t = ln.strip()
        if not t:
            continue
        m = CAT.match(t)
        if m:
            cur = {"mark": m.group(1), "name": m.group(2).strip(), "points": []}
            cats.append(cur)
            continue
        m = SUB.match(t)
        if m and cur is not None:
            name = m.group(2).strip()
            ph, tm = build_terms(name)
            cur["points"].append({
                "id": f"{cur['mark']}-{m.group(1)}", "name": name,
                "phrases": ph, "terms": tm,
            })

    # 大类名也生成检索词，作为子项全未命中时的降级兜底
    for c in cats:
        c["phrases"], c["terms"] = build_terms(c["name"])

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(
        yaml.safe_dump(cats, allow_unicode=True, sort_keys=False), encoding="utf-8")

    n = sum(len(c["points"]) for c in cats)
    for c in cats:
        print(f"{c['mark']} {c['name'][:22]:24s} {len(c['points']):3d} 项")
    print(f"\n{len(cats)} 大类 / {n} 评审点 -> {out_path}")
    print("注意: ② 出现两次(7项/31项)、④ 疑为③的子项被误提为大类 —— 待出题人确认")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

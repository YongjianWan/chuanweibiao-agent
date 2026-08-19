"""探针：真实投标 PDF 有没有可用的结构信号，用来定 S1 的切分策略。

回答三个问题：
1. 字号能不能区分标题和正文（有没有明显的多峰分布）
2. 加粗标记可不可靠（PyMuPDF 的 span flags 第 4 位）
3. 编号模式覆盖多少行，哪种编号体系占主导

不改任何东西，只输出统计。结论写进 docs/findings-pdf切分探针.md。
"""
import collections
import os
import re
import sys

import fitz

BASE = "原始资料/实际测试工程文件/济阳区实验高级中学项目工程总承包（EPC） 2"

# 编号模式。顺序即优先级：先匹配上的算这一类。
PATTERNS = [
    ("第N章/节", re.compile(r"^第[一二三四五六七八九十百\d]+[章节篇部分]")),
    ("N.N.N",   re.compile(r"^\d+\.\d+\.\d+")),
    ("N.N",     re.compile(r"^\d+\.\d+(?!\d)")),
    ("N、/N.",  re.compile(r"^\d{1,2}[、.](?!\d)")),
    ("中文数字、", re.compile(r"^[一二三四五六七八九十]{1,3}[、.]")),
    ("（N）",    re.compile(r"^[（(][一二三四五六七八九十\d]{1,3}[）)]")),
]


def probe(path):
    doc = fitz.open(path)
    sizes = collections.Counter()
    bold_lines = 0
    lines = []
    for pg in doc:
        for blk in pg.get_text("dict")["blocks"]:
            for ln in blk.get("lines", []):
                spans = ln["spans"]
                if not spans:
                    continue
                txt = "".join(sp["text"] for sp in spans).strip()
                if not txt:
                    continue
                # 一行的字号取其最大 span，标题行常整行同号
                sz = round(max(sp["size"] for sp in spans), 1)
                bold = any(sp["flags"] & 16 for sp in spans)
                sizes[sz] += 1
                bold_lines += bold
                lines.append((txt, sz, bold))
    doc.close()
    return sizes, bold_lines, lines


def classify(lines):
    hit = collections.Counter()
    samples = collections.defaultdict(list)
    for txt, sz, bold in lines:
        for name, pat in PATTERNS:
            if pat.match(txt):
                hit[name] += 1
                if len(samples[name]) < 3:
                    samples[name].append(txt[:38])
                break
    return hit, samples


def main():
    base = BASE if os.path.exists(BASE) else BASE.replace("实际测试工程文件", "实际测试文件")
    targets = []
    for bidder, kw in [("中冶建工集团有限公司8010856", "施工方案及技术措施"),
                       ("中国建筑第五工程局有限公司8002423", "进度管理方案"),
                       ("济南一建集团有限公司8008754", "服务采购管理方案")]:
        d = os.path.join(base, bidder)
        for dp, _, fs in os.walk(d):
            for f in fs:
                if f.startswith(kw) and f.lower().endswith(".pdf"):
                    targets.append((bidder[:12], kw, os.path.join(dp, f)))
    if not targets:
        sys.exit(f"找不到目标 PDF，检查 {base}")

    for bidder, kw, path in targets:
        sizes, bold_lines, lines = probe(path)
        total = sum(sizes.values())
        print(f"\n{'='*72}\n{bidder} · {kw}\n共 {total:,} 行")

        print("  字号分布（占比 >1%）:")
        for sz, n in sizes.most_common():
            if n / total > 0.01:
                print(f"    {sz:>5}pt  {n:>6,} 行  {n/total:6.1%}")
        print(f"  加粗行: {bold_lines:,} ({bold_lines/total:.1%})")

        hit, samples = classify(lines)
        cov = sum(hit.values())
        print(f"  编号行合计 {cov:,} ({cov/total:.1%})")
        for name, n in hit.most_common():
            print(f"    {name:<10} {n:>5,} 行   例: {' | '.join(samples[name])}")


if __name__ == "__main__":
    main()

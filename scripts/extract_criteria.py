"""从招标文件抽 19 项「评审标准原文」（criteria），写回 config/projects/<项目>.yaml。

为什么是 criteria 而不是 tiers[].desc
------------------------------------
`docs/data-contract.md` 早先设计了 `tiers[].desc`（每档一条档位描述原文），
那是照软件类样例标书的形态定的。**本项目的招标文件里不存在这一层**：
19 项统一写「评委根据投标文件情况分为一般、良、优，分别酌情得 X-Y 分、
Y-Z 分、Z-W 分」，三档共用一段评审标准，没有逐档描述
（p33~38 全文「优：」「良：」「一般：」各出现 0 次）。
硬造三档描述等于我方杜撰判分依据，撞 README §1 的 P1「判分有据可查」，
故改为抽 item 级的 `criteria`，逐字来自招标文件。

抽取原则
--------
**只把 PDF 排版断开的行接回去，不改动任何正文字符**——
行内空格（如「10-14 分」）原样保留，只丢弃行首尾空白与整行噪声。

三类噪声在原文里各自独占整行，因此全部在行级别剔除：

1. 水印行：整行等于文档水印 GUID（6 行）
2. 左列跨页续行误入右列：表格左列项名的续行插在区间数字与「分」之间。
   全文 1 处（T-10），检测规则是「区间数字与其『分』字之间夹了非空白非数字文本」，
   不硬编字符串。**这就是 scripts/verify_scoring_table.py 报 18/19 的那一条**，
   也是 docs/findings-原始资料缺陷.md 第 6 条那个坑的真身——
   记录里写的是「分字落到下一页」，实际是左列文字插进了右列数字中间。
3. 其他列文字（汇总规则等）：由「相关标书内容在…中体现」这个固定句尾切掉。

验证
----
跑完自动做两项，任一不达标即非零退出：

- 逐字回原文：criteria 去空白后必须是招标文件 p33~38 去空白全文的子串。
  **预期 18/19**——T-10 不命中是正确的，它那句话在原文里本来就被左列文字劈开。
- 区间反解：从 criteria 正则解出的三档区间必须与 yaml 已有 tiers 完全一致，
  预期 19/19。这条防张冠李戴：抽错项会立刻暴露。

用法
----
    python scripts/extract_criteria.py            # 写回 yaml
    python scripts/extract_criteria.py --check    # 只验证不写
"""
import argparse
import re
import sys

import fitz
import yaml

PDF = ('原始资料/实际测试工程文件/济阳区实验高级中学项目工程总承包（EPC） 2/'
       '招标文件.pdf')
YAML = 'config/projects/济阳区实验高级中学.yaml'
WATERMARK = '3972508f-de35-4e7a-9728-5de0fcbdd53d'
PAGES = range(32, 38)          # 0-based，评标办法技术标部分 p33~p38
END = re.compile(r'相关标书内容在.*?中体现[。；;]')
# 区间数字与其「分」字之间夹了非空白文本 = 左列续行误入。
# 插入片段要求含非空白字符，否则正常的「10-14 分」也会被误伤。
CONTAM = re.compile(r'(\d+(?:\.\d+)?-\d+(?:\.\d+)?)([^\d分\s]{1,40}?)(\s*分)')
RANGE = re.compile(r'([\d.]+)-([\d.]+)\s*分')


def load_clean_text(pdf=PDF):
    """读评标办法各页，剔除两类整行噪声，把 PDF 排版断行接回去。

    返回 (清洗后文本, 剔除的水印行数, 剔除的左列续行片段列表)。
    正文字符不做改动，行内空格（如「10-14 分」）原样保留。
    scripts/verify_scoring_table.py 复用本函数——两处的清洗规则必须是同一份，
    各写一遍会在改动时静默漂移。
    """
    doc = fitz.open(pdf)
    lines = [ln.strip() for pg in PAGES for ln in doc[pg].get_text().splitlines()]
    dropped = sum(1 for ln in lines if ln == WATERMARK)
    text = ''.join(ln for ln in lines if ln and ln != WATERMARK)
    contam = [m.group(2) for m in CONTAM.finditer(text)]
    return CONTAM.sub(r'\1\3', text), dropped, contam


def extract(items):
    """返回 {item_id: criteria 原文}，以及清理统计。"""
    text, dropped, contam = load_clean_text()

    # 定位用无空白副本，取文本时映射回原串，从而保留行内空格
    compact, back = [], []
    for i, ch in enumerate(text):
        if not ch.isspace():
            compact.append(ch)
            back.append(i)
    compact = ''.join(compact)

    starts = [compact.find(it['name']) for it in items]
    if not (all(p >= 0 for p in starts) and starts == sorted(starts)):
        sys.exit('项名在招标文件中定位失败，评分表与招标文件可能不是同一个项目')

    out = {}
    for i, it in enumerate(items):
        lo = starts[i]
        hi = starts[i + 1] if i + 1 < len(items) else len(compact)
        seg = compact[lo:hi]
        # 项名可能出现三次：左列表头、正文开头、句尾「相关标书内容在…」。
        # 取满足「其后含评委根据且能闭合」的最靠后一次 = 正文开头，甩掉左列表头与分值。
        for cand in reversed([m.start() for m in re.finditer(re.escape(it['name']), seg)] or [0]):
            m = END.search(seg[cand:])
            if m and '评委根据' in seg[cand:cand + m.end()]:
                out[it['id']] = text[back[lo + cand]:back[lo + cand + m.end() - 1] + 1]
                break
    return out, dropped, contam


def verify(items, criteria):
    """逐字回原文 + 区间反解。返回 (逐字命中数, 区间一致数, 失败明细)。"""
    doc = fitz.open(PDF)
    pdf_compact = re.sub(
        r'\s+', '', ''.join(doc[i].get_text() for i in PAGES)
    ).replace(WATERMARK, '')

    verbatim = tiers_ok = 0
    problems = []
    for it in items:
        text = criteria.get(it['id'], '')
        hit = re.sub(r'\s+', '', text) in pdf_compact
        got = [(float(a), float(b)) for a, b in RANGE.findall(text)][:3]
        exp = sorted((float(t['min']), float(t['max'])) for t in it['tiers'])
        verbatim += hit
        tiers_ok += got == exp
        if got != exp:
            problems.append(f"{it['id']} 区间不一致：yaml={exp} 招标文件={got}")
        elif not hit and it['id'] != 'T-10':
            problems.append(f"{it['id']} 未逐字命中原文")
    return verbatim, tiers_ok, problems


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--check', action='store_true', help='只验证，不写回 yaml')
    args = parser.parse_args()

    doc = yaml.safe_load(open(YAML, encoding='utf-8'))
    items = doc['items']
    criteria, dropped, contam = extract(items)
    print(f'剔除水印 {dropped} 行；剔除左列跨页续行 {len(contam)} 处 {contam}')

    missing = [it['id'] for it in items if it['id'] not in criteria]
    if missing:
        sys.exit(f'以下评分项未抽到 criteria：{missing}')

    verbatim, tiers_ok, problems = verify(items, criteria)
    print(f'逐字回原文 {verbatim}/{len(items)}（T-10 不命中为预期，见模块文档）')
    print(f'区间与 yaml 一致 {tiers_ok}/{len(items)}')
    if problems:
        print('\n'.join(problems))
        sys.exit('验证未通过')
    if verbatim < len(items) - 1 or tiers_ok < len(items):
        sys.exit('验证未通过')

    if args.check:
        print('--check：验证通过，未写回')
        return

    for it in items:
        it['criteria'] = criteria[it['id']]
    with open(YAML, 'w', encoding='utf-8') as fh:
        yaml.safe_dump(doc, fh, allow_unicode=True, sort_keys=False, width=10 ** 6)
    print(f'已写回 {YAML}：{len(items)} 项 criteria')


if __name__ == '__main__':
    main()

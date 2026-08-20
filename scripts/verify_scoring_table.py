"""核对：招标文件 PDF 的评标办法 vs 拆分评审项.xlsx。

产出 docs/findings-招标文件核对.md 里那张 19 行比对表。
回答一个问题：xlsx 里的评分项、分值、三档区间，是不是招标文件原文。

跨页陷阱：招标文件的评标办法表有单元格跨页续行。原先记为
"p35 末尾断在 1.5-2、分 落在 p36 开头"，2026-08-20 抽 criteria 时看清了
真身：是表格**左列**的项名续行（"时间保证措施；"）插进了**右列**正文的
"1.5-2" 和 "分" 之间，加上一行文档水印 GUID。按页取文本再截窗口，
会把下一项的区间读进来，表现为静默的假不一致——本脚本长期报的
"档位一致 18/19" 就是这么来的，那一项（各专业施工图设计…）实际是一致的。

因此这里不再自己拼页，改为复用 extract_criteria.load_clean_text()：
剔除水印行与左列续行，再把排版断行接回去。两处清洗规则必须是同一份，
否则改了一边另一边会静默漂移。
"""
import collections
import os
import re
import sys

import fitz
import openpyxl

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from extract_criteria import load_clean_text  # noqa: E402

BASE = "原始资料/实际测试工程文件/济阳区实验高级中学项目工程总承包（EPC） 2"
XLSX = "原始资料/实际测试工程文件/拆分评审项.xlsx"
PAGES = range(32, 38)   # 0-based，技术标评分表所在页 p33~p38
WINDOW = 420            # 从项名往后取多少字里找档位


def tiers(text):
    """取前三个 X-Y分 区间。三档就是一般/良/优。"""
    return re.findall(r"([\d.]+)-([\d.]+)\s*分", text)[:3]


def main():
    base = BASE if os.path.exists(BASE) else BASE.replace("实际测试工程文件", "实际测试文件")
    xlsx = XLSX if os.path.exists(XLSX) else XLSX.replace("实际测试工程文件", "实际测试文件")
    pdf = os.path.join(base, "招标文件.pdf")
    if not os.path.exists(pdf) or not os.path.exists(xlsx):
        sys.exit(f"找不到源文件：{pdf} 或 {xlsx}")

    text, dropped, contam = load_clean_text(pdf)
    print(f"清洗：剔除水印 {dropped} 行、左列跨页续行 {len(contam)} 处 {contam}")
    raw = re.sub(r"\s+", "", text)

    ws = openpyxl.load_workbook(xlsx, data_only=True)["Sheet1"]
    items = collections.OrderedDict()
    for r in list(ws.iter_rows(values_only=True))[1:]:
        if r[0]:
            items.setdefault(r[0], {"name": r[1], "desc": re.sub(r"\s+", "", str(r[2]))})

    fmt = lambda t: ";".join(f"{a}-{b}" for a, b in t) or "(未匹配)"
    print(f"{'评分项':<26}{'招标文件档位':<34}{'xlsx档位':<34}一致")
    same_cnt = 0
    for it in items.values():
        name = re.sub(r"\s+", "", it["name"])
        i = raw.find(name)
        t_pdf = tiers(raw[i:i + WINDOW]) if i >= 0 else []
        t_xls = tiers(it["desc"])
        same = len(t_pdf) == 3 and t_pdf == t_xls
        same_cnt += same
        print(f"{name[:24]:<26}{fmt(t_pdf):<34}{fmt(t_xls):<34}{'✓' if same else '✗'}")

    print(f"\n档位一致 {same_cnt}/{len(items)}")
    if same_cnt < len(items):
        print("注：不一致项先按跨页续行人工复核，确认是抽取误差还是真差异。")
    return 0 if same_cnt == len(items) else 1


if __name__ == "__main__":
    sys.exit(main())

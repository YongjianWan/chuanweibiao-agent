"""核对：招标文件 PDF 的评标办法 vs 拆分评审项.xlsx。

产出 docs/findings-招标文件核对.md 里那张 19 行比对表。
回答一个问题：xlsx 里的评分项、分值、三档区间，是不是招标文件原文。

跨页陷阱：招标文件的评标办法表有单元格跨页续行（p35 末尾断在
"1.5-2"，"分" 落在 p36 开头）。按页取文本再截窗口，会把下一项的
区间读进来，表现为静默的假不一致。所以这里先把整段页拼成一个
去空白的长串再定位，不按页处理。
"""
import collections
import os
import re
import sys

import fitz
import openpyxl

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

    doc = fitz.open(pdf)
    raw = re.sub(r"\s+", "", "".join(doc[i].get_text() for i in PAGES))

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
    print("注：不一致项先按跨页续行人工复核，确认是抽取误差还是真差异。")
    return 0 if same_cnt >= len(items) - 1 else 1


if __name__ == "__main__":
    sys.exit(main())

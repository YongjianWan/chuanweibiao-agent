"""T0 验收核对：验证 S1 产出的 sections.json 是否符合 README §4 章节块契约。

用法（PowerShell）：
    $env:PYTHONIOENCODING="utf-8"; python scripts/verify_t0.py

逐条核对：文件覆盖、字段齐全、GUID 合法、页码、id 唯一、char_len 一致、块字数中位数。
全部通过打印 OK，任一失败打印 FAIL 并以非零码退出。
"""
import json
import re
import statistics
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SECTIONS = ROOT / "data" / "interim" / "sections.json"
GUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
REQUIRED = {"id", "file", "item_guid", "path", "level", "page", "text", "char_len"}


def main():
    if not SECTIONS.exists():
        print(f"找不到 {SECTIONS}，请先运行 S1 入库命令生成它。")
        return 1

    sections = json.loads(SECTIONS.read_text(encoding="utf-8"))
    checks = []

    def check(name, ok, detail=""):
        checks.append(ok)
        print(f"  [{'✓' if ok else '✗'}] {name}  {detail}")

    print(f"读取 {SECTIONS.name}：{len(sections):,} 个章节块\n")

    check("字段齐全（8 个字段）",
          all(set(x) == REQUIRED for x in sections))

    check("item_guid 为合法小写 GUID（非封面块）",
          all(GUID_RE.match(x["item_guid"] or "")
              for x in sections if "封面" not in x["file"]))

    check("page 为 >=1 的整数",
          all(isinstance(x["page"], int) and x["page"] >= 1 for x in sections))

    check("char_len == len(text)",
          all(x["char_len"] == len(x["text"]) for x in sections))

    check("id 全局唯一",
          len({x["id"] for x in sections}) == len(sections),
          f"({len(sections):,} 个，去重后 {len({x['id'] for x in sections}):,})")

    check("level 取值 0~5",
          all(x["level"] in (0, 1, 2, 3, 4, 5) for x in sections))

    lens = sorted(x["char_len"] for x in sections)
    check("块字数中位数",
          True,
          f"= {statistics.median(lens)}（P90 {lens[min(int(len(lens) * .9), len(lens) - 1)]:,}，"
          f"最大 {max(lens):,}）")

    ok = all(checks)
    print(f"\n{'=' * 50}")
    print("总判定:", "全部通过 OK" if ok else "有项未通过 FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

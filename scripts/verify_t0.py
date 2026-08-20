"""T0 验收核对：验证 S1 产出的 sections.json 是否符合 README §4 章节块契约。

用法（PowerShell）：
    $env:PYTHONIOENCODING="utf-8"; python scripts/verify_t0.py <sections.json 路径>

例（目录约定见 data/README.md）：
    python scripts/verify_t0.py data/projects/jiyang-epc/sections/中冶建工集团有限公司8010856/sections.json

**只核对一家投标人的产出。** README §4 已定 `id` 只在单家范围内唯一，
跨投标人引用走 `(bidder, id)` 复合键，所以「id 唯一」这条检查的范围就是一家。

逐条核对：字段齐全、GUID 合法、页码、单家内 id 唯一、char_len 一致、level 取值、块字数中位数。
全部通过打印 OK，任一失败打印 FAIL 并以非零码退出。
"""
import json
import re
import statistics
import sys
from pathlib import Path

GUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
REQUIRED = {"id", "file", "item_guid", "path", "level", "page", "text", "char_len"}


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 1

    sections_path = Path(argv[1])
    if not sections_path.exists():
        print(f"找不到 {sections_path}，请先运行 S1 入库命令生成它。")
        return 1

    sections = json.loads(sections_path.read_text(encoding="utf-8"))

    # 闸门一：sections_all.json 是对象，不是单家的 sections.json，别拿它当单家核对
    if isinstance(sections, dict):
        print("FAIL: %s 顶层是对象，看起来是 sections_all.json（README §4「章节块全量索引」）。"
              % sections_path)
        print("本脚本核对的是**单家**的 sections.json，路径形如")
        print("  data/projects/<slug>/sections/<bidder>/sections.json")
        return 1
    if not isinstance(sections, list):
        print("FAIL: %s 顶层必须是数组" % sections_path)
        return 1

    checks = []

    def check(name, ok, detail=""):
        checks.append(ok)
        print(f"  [{'✓' if ok else '✗'}] {name}  {detail}")

    print(f"读取 {sections_path}：{len(sections):,} 个章节块\n")

    check("字段齐全（8 个字段）",
          all(set(x) == REQUIRED for x in sections))

    check("item_guid 为合法小写 GUID（非封面块）",
          all(GUID_RE.match(x["item_guid"] or "")
              for x in sections if "封面" not in x["file"]))

    check("page 为 >=1 的整数",
          all(isinstance(x["page"], int) and x["page"] >= 1 for x in sections))

    check("char_len == len(text)",
          all(x["char_len"] == len(x["text"]) for x in sections))

    check("id 在本家范围内唯一（README §4：不要求全局唯一）",
          len({x["id"] for x in sections}) == len(sections),
          f"({len(sections):,} 个，去重后 {len({x['id'] for x in sections}):,})")

    # 闸门二：文件序号种类 > 20 说明是多家混跑的产物。README §2.1——每家固定 20 个 PDF，
    # §4——按家分别跑 S1，每家的文件序号都从 1 重新开始。混跑时「单家内 id 唯一」
    # 会因为跨家连号而必然通过，这条检查就成了假绿灯。
    file_keys = {x["id"].split("#")[0] for x in sections}
    check("文件序号种类 <= 20（单家产物，README §2.1 每家固定 20 个 PDF）",
          len(file_keys) <= 20,
          "(实际 %d 种%s)" % (
              len(file_keys),
              "，疑似多家混合输入，S1 应按家分别运行：python src/s1_ingest.py --project ..."
              if len(file_keys) > 20 else ""))

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
    sys.exit(main(sys.argv))

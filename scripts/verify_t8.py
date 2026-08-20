"""T8 验收核对：验证 S2 产出的 located.json 是否符合 data-contract.md §5。

只核对一家投标人的产出（19 项），不做跨家对比。

用法示例：
  python scripts/verify_t8.py data/projects/jiyang-epc/evidence/中冶建工集团有限公司8010856/located.json
  python scripts/verify_t8.py --scoring-table config/projects/济阳区实验高级中学.yaml data/projects/jiyang-epc/evidence/中冶建工集团有限公司8010856/located.json

检查项（任一失败打印 FAIL 并以非零码退出）：
  1. 顶层是 19 项的数组（与评分表一致）
  2. 每项字段齐全（item_id / item_guid / bidder / name / candidates / units / fallback / evidence_chars / budget / picked）
  3. picked[].page 存在且为整数（页面⑤ 跳转依赖）
  4. match_score 字段名正确（不是 score，见 CLAUDE.md 硬规矩）
  5. budget 按 S2 当前分值分配公式可复算（data-contract.md §5）
  6. evidence_chars <= budget
  7. bidder 在 19 项内一致
  8. （可选）与评分表 GUID/名称一致（传 --scoring-table 时才检查）
  9. 告警：全部未命中 / 全部命中（踩 §6 阶段一的三条效果指标）
"""
import argparse
import json
import re
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from s2_locate import calc_budget

GUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
REQUIRED_TOP = {"item_id", "item_guid", "bidder", "name",
                "candidates", "units", "fallback",
                "evidence_chars", "budget", "pool_sections", "picked"}
REQUIRED_PICKED = {"section_id", "file", "path", "unit", "page",
                   "match_score", "hit", "chars", "truncated"}

def main(argv=None):
    parser = argparse.ArgumentParser(description="T8 located.json 验收核对")
    parser.add_argument("located", help="单家 located.json 路径")
    parser.add_argument("--scoring-table", dest="scoring_table",
                        help="项目评分表 YAML 路径（可选，传了则核对 GUID/名称一致）")
    args = parser.parse_args(argv)

    located_path = Path(args.located)
    if not located_path.exists():
        print(f"找不到 {located_path}，请先运行 S2 定位命令生成它。")
        return 1

    data = json.loads(located_path.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        print(f"FAIL: {located_path} 顶层是对象，预期为 19 项的数组（data-contract.md §5）。")
        return 1
    if not isinstance(data, list):
        print(f"FAIL: {located_path} 顶层必须是数组")
        return 1

    scoring_items = None
    if args.scoring_table:
        sp = Path(args.scoring_table)
        if not sp.exists():
            print(f"找不到评分表 {sp}")
            return 1
        y = yaml.safe_load(sp.read_text(encoding="utf-8")) or {}
        scoring_items = {str(it["id"]): it for it in y.get("items", [])}

    checks = []

    def check(name, ok, detail=""):
        checks.append(ok)
        mark = "[OK]" if ok else "[FAIL]"
        print(f"  {mark} {name}  {detail}")

    print(f"读取 {located_path}：{len(data)} 项\n")

    exp_n = len(scoring_items) if scoring_items else 19
    check(f"项数 == {exp_n}（与评分表一致）", len(data) == exp_n,
          f"(实际 {len(data)})")
    # 每项顶层字段齐全
    check("每项字段齐全（11 个字段）",
          all(REQUIRED_TOP <= set(x.keys()) for x in data))
    # 多余字段告警（不判失败，只提示）
    for x in data:
        extra = set(x.keys()) - REQUIRED_TOP
        if extra:
            print(f"    [提示] {x.get('item_id')} 多余字段: {extra}")

    # item_guid 形如小写 GUID
    check("item_guid 为合法小写 GUID",
          all(bool(GUID_RE.match(str(x.get("item_guid") or ""))) for x in data))

    # bidder 一致
    bidders = {x.get("bidder") for x in data}
    check("bidder 在 19 项内一致", len(bidders) == 1,
          f"(实际 {bidders})")

    # budget / evidence_chars
    check("evidence_chars <= budget",
          all(int(x.get("evidence_chars", 0)) <= int(x.get("budget", 0)) for x in data))

    # budget 可复算（有评分表时才严格核对，否则只检查落在 [1500,9000]）
    if scoring_items:
        budget_ok = True
        for x in data:
            it = scoring_items.get(str(x.get("item_id")))
            if it is None:
                budget_ok = False
                break
            exp = calc_budget(float(it["max_score"]))
            if int(x.get("budget", -1)) != exp:
                budget_ok = False
                print(f"    [预算不符] {x['item_id']}: 实际 {x['budget']} 预期 {exp} (max_score={it['max_score']})")
                break
        check("budget 按分值分配公式可复算", budget_ok)
    else:
        check("budget 落在 [1500,9000]",
              all(1500 <= int(x.get("budget", 0)) <= 9000 for x in data))

    picked_ok = True
    page_ok = True
    score_name_ok = True
    for x in data:
        for p in x.get("picked", []):
            if not (REQUIRED_PICKED <= set(p.keys())):
                picked_ok = False
            # page 允许为 int>=1（PDF 路径）或 null（docx 路径，data-contract.md §1）
            pv = p.get("page")
            if pv is not None and (not isinstance(pv, int) or pv < 1):
                page_ok = False
            if "score" in p:
                score_name_ok = False
            if "match_score" not in p:
                score_name_ok = False
    check("picked 字段齐全（9 个字段）", picked_ok)
    check("picked[].page 为 >=1 的整数或 null（docx 允许）", page_ok)
    check("picked[].match_score 字段名正确（不是 score）", score_name_ok)

    # 与评分表 GUID/名称一致
    if scoring_items:
        guid_ok = all(
            str(scoring_items.get(str(x["item_id"]), {}).get("guid", "")).lower()
            == str(x.get("item_guid", "")).lower()
            for x in data if str(x.get("item_id")) in scoring_items
        )
        name_ok = all(
            str(scoring_items.get(str(x["item_id"]), {}).get("name", ""))
            == str(x.get("name", ""))
            for x in data if str(x.get("item_id")) in scoring_items
        )
        check("item_guid 与评分表一致", guid_ok)
        check("name 与评分表一致", name_ok)
        # 覆盖度：评分表里的每一项都在 located.json 里
        check("评分表 19 项全部覆盖",
              set(scoring_items.keys()) == {str(x["item_id"]) for x in data})

    # 告警（不计入判定，只提示）
    miss = sum(1 for x in data if not x.get("picked"))
    fb = sum(1 for x in data if x.get("fallback"))
    direct = sum(1 for x in data if x.get("picked") and not x.get("fallback"))
    print(f"\n  命中统计：直接 {direct}  降级 {fb}  未命中 {miss} / {len(data)}")
    if miss == len(data):
        print("  [告警] 全部未命中 —— 可能是 GUID 未对上或检索词与 PDF 用词完全错位")
    if miss == 0 and direct == len(data):
        print("  [提示] 全部直接命中（无降级、无未命中）—— 少见，确认是否符合 §6 阶段一的非空率预期")
    # §6 阶段一的三条效果指标提示
    total_ev = sum(int(x.get("evidence_chars", 0)) for x in data)
    total_budget = sum(int(x.get("budget", 0)) for x in data)
    print(f"  证据字数合计 {total_ev:,} / 预算合计 {total_budget:,}（超预算即截断）")
    if total_ev > total_budget:
        print("  [告警] 证据字数合计超过预算合计")

    ok = all(checks)
    print(f"\n{'=' * 50}")
    print("总判定:", "全部通过 OK" if ok else "有项未通过 FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

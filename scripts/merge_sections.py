"""合并多家投标人的 sections.json 为 sections_all.json。

输入：项目目录（如 data/projects/jiyang-epc/），其下
  sections/<bidder>/sections.json  —— S1 为每家投标人产出的章节块
输出：项目目录下的 sections_all.json

合并规则：
- 每个章节块注入 bidder 字段，便于跨投标人引用
- id 保持原样，不全局重写；外部引用时以 (bidder, id) 为复合键
- 生成统计信息：总章节数、总字数、按投标人分布
- **产出是确定性的**：不含时间戳，输入不变则重跑零 diff（见 issue #5 第 1 条）

这是 S1 -> S4 的汇总节点：S2 仍按单个投标人独立跑，但报告层需要
知道全部章节来自哪些文件、哪些投标人。
"""
import argparse
import json
import sys
from pathlib import Path


def load_sections(bidder_dir: Path, bidder_id: str):
    """读取一家投标人的 sections.json，给每个块注入 bidder 字段。"""
    path = bidder_dir / "sections.json"
    if not path.exists():
        raise FileNotFoundError(f"{bidder_id} 缺少 sections.json: {path}")

    sections = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(sections, dict):
        raise ValueError(
            f"{path} 顶层是对象，看起来是 sections_all.json（README §4「章节块全量索引」）。"
            f"本脚本读的是单家 sections.json，不能把合并产物再合并一次。"
        )
    if not isinstance(sections, list):
        raise ValueError(f"{path} 顶层必须是数组")

    # 单家内 id 唯一 —— 这是 (bidder, id) 复合键成立的唯一前提（README §4）。
    # 撞了不能静默通过，否则错误会一路传到页面⑤的原文定位。
    seen = {}
    for sec in sections:
        seen[sec["id"]] = seen.get(sec["id"], 0) + 1
    dup = {k: v for k, v in seen.items() if v > 1}
    if dup:
        detail = "、".join(f"{k} x{v}" for k, v in sorted(dup.items())[:5])
        raise ValueError(
            f"{bidder_id} 的 sections.json 内 id 重复 {len(dup)} 个：{detail}"
            f"{'…' if len(dup) > 5 else ''}。"
            f"README §4 要求 id 在单家范围内唯一，S1 应按家分别运行。"
        )

    for sec in sections:
        existing = sec.get("bidder")
        if existing is not None and existing != bidder_id:
            raise ValueError(
                f"{path} 中块 {sec['id']} 已带 bidder={existing!r}，"
                f"与目录名 {bidder_id!r} 不一致。不静默覆盖，请先确认数据来源。"
            )
        sec["bidder"] = bidder_id
    return sections


def merge_project(project_dir: str, out_name: str = "sections_all.json"):
    project = Path(project_dir)
    manifest_path = project / "manifest.json"
    if not manifest_path.exists():
        sys.exit(f"项目目录缺少 manifest.json: {project}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    bidders = [b["id"] for b in manifest.get("bidders", [])]
    if not bidders:
        sys.exit(f"manifest.json 中未声明任何 bidder")

    sections_dir = project / manifest.get("artifacts", {}).get("sections_dir", "sections")
    all_sections, by_bidder = [], {}

    for bidder_id in bidders:
        bidder_dir = sections_dir / bidder_id
        secs = load_sections(bidder_dir, bidder_id)
        total_chars = sum(s.get("char_len", 0) for s in secs)
        by_bidder[bidder_id] = {"sections": len(secs), "chars": total_chars}
        all_sections.extend(secs)

    total_chars = sum(s.get("char_len", 0) for s in all_sections)

    output = {
        "project": manifest.get("project", project.name),
        "project_slug": manifest.get("project_slug", project.name),
        "schema_version": manifest.get("data_schema_version", "1.0"),
        "bidders": bidders,
        "sections": all_sections,
        "stats": {
            "total_sections": len(all_sections),
            "total_chars": total_chars,
            "by_bidder": by_bidder,
        },
    }

    out_path = project / out_name
    out_path.write_text(json.dumps(output, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"合并 {len(bidders)} 家投标人 / {len(all_sections):,} 章节 / {total_chars:,} 字")
    for bidder_id, st in by_bidder.items():
        print(f"  {bidder_id:20s} {st['sections']:5d} 章  {st['chars']:8,d} 字")
    print(f"-> {out_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="合并 sections.json 为 sections_all.json")
    parser.add_argument("project_dir", help="项目目录，如 data/projects/jiyang-epc")
    parser.add_argument("-o", "--output", default="sections_all.json",
                        help="输出文件名（默认 sections_all.json）")
    args = parser.parse_args()
    merge_project(args.project_dir, args.output)

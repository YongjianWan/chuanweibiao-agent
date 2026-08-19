"""合并多家投标人的 sections.json 为 sections_all.json。

输入：项目目录（如 data/projects/jiyang-epc/），其下
  sections/<bidder>/sections.json  —— S1 为每家投标人产出的章节块
输出：项目目录下的 sections_all.json

合并规则：
- 每个章节块注入 bidder 字段，便于跨投标人引用
- id 保持原样，不全局重写；外部引用时以 (bidder, id) 为复合键
- 生成统计信息：总章节数、总字数、按投标人分布

这是 S1 -> S4 的汇总节点：S2 仍按单个投标人独立跑，但报告层需要
知道全部章节来自哪些文件、哪些投标人。
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def load_sections(bidder_dir: Path, bidder_id: str):
    """读取一家投标人的 sections.json，给每个块注入 bidder 字段。"""
    path = bidder_dir / "sections.json"
    if not path.exists():
        raise FileNotFoundError(f"{bidder_id} 缺少 sections.json: {path}")

    sections = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(sections, list):
        raise ValueError(f"{path} 顶层必须是数组")

    for sec in sections:
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
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S%z"),
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

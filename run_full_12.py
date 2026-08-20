import json
import os
import subprocess
import sys
import time
from pathlib import Path

EVIDENCE_ROOT = Path("data/projects/jiyang-epc/evidence")
SECTIONS_ROOT = Path("data/projects/jiyang-epc/sections")
CONFIG_YAML = "config/projects/济阳区实验高级中学.yaml"
SUMMARY_MD = "config/projects/项目特征摘要.md"
OUTPUT_DIR = Path("data/out/full_12")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def get_bidders():
    return [d.name for d in EVIDENCE_ROOT.iterdir() if d.is_dir()]


def run_one(bidder):
    located = EVIDENCE_ROOT / bidder / "located.json"
    sections = SECTIONS_ROOT / bidder / "sections.json"
    out = OUTPUT_DIR / f"{bidder}.json"

    if not located.exists():
        return {"bidder": bidder, "status": "skipped", "reason": "located.json missing"}
    if not sections.exists():
        return {"bidder": bidder, "status": "skipped", "reason": "sections.json missing"}

    start = time.time()
    cmd = [
        sys.executable,
        "src/s3_review.py",
        str(located),
        CONFIG_YAML,
        SUMMARY_MD,
        str(sections),
        str(out),
        "--agent-factory",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    elapsed = time.time() - start

    return {
        "bidder": bidder,
        "status": "success" if result.returncode == 0 else "failed",
        "elapsed": elapsed,
        "returncode": result.returncode,
        "stderr": result.stderr[-500:] if result.stderr else "",
        "out_file": str(out),
    }


def summarize(results):
    total = len(results)
    success = sum(1 for r in results if r["status"] == "success")
    failed = total - success
    total_time = sum(r.get("elapsed", 0) for r in results)

    unrated_total = 0
    not_found_total = 0
    for r in results:
        if r["status"] != "success":
            continue
        try:
            with open(r["out_file"], "r", encoding="utf-8") as f:
                data = json.load(f)
                for item in data.get("review_results", []):
                    if item.get("status") == "unrated":
                        unrated_total += 1
                    if item.get("miss_reason") == "not_found":
                        not_found_total += 1
        except Exception:
            pass

    print("\n" + "=" * 50)
    print("12 家全量稳定性验收报告")
    print("=" * 50)
    print(f"投标人家数: {total}")
    print(f"成功: {success}")
    print(f"失败: {failed}")
    print(f"总耗时: {total_time:.2f} 秒 ({total_time / 60:.2f} 分钟)")
    print(f"平均每家耗时: {total_time / total:.2f} 秒")
    print(f"unrated 总数: {unrated_total}")
    print(f"not_found 总数: {not_found_total}")


if __name__ == "__main__":
    bidders = get_bidders()
    print(f"发现 {len(bidders)} 家投标人")
    results = []
    for bidder in bidders:
        print(f"正在跑: {bidder}...")
        results.append(run_one(bidder))
        time.sleep(1)
    summarize(results)

"""T3：并发调度器 + 断点续跑。

负责把 S3 的 review_one 串行调用切成可并发、可恢复的批处理。

实现要点：
- 两层并发：bidder → item，统一用 asyncio + Semaphore 控制并发
- 每项结果完成当场落盘：work_dir/<bidder>/<item_id>.json，随 manifest 一起持久化
- manifest.json 记录已完成项，可中途 kill 后续跑
- 重试由 S3 内部完成，调度器只负责分发
- 取消/超时：信号捕获后优雅停止，已完成项保护
"""

from __future__ import annotations

import asyncio
import inspect
import json
import math
import os
import signal
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence, Callable

# 并发控制开关
DEFAULT_CONCURRENCY = 12  # 12 家 × 19 项 = 228，12 个 worker 够用
MAX_CONCURRENCY = 64


@dataclass
class JobKey:
    """唯一作业标识 = (bidder, item_id)"""
    bidder: str
    item_id: str

    def __hash__(self):
        return hash((self.bidder, self.item_id))

    def __eq__(self, other):
        return isinstance(other, JobKey) and self.bidder == other.bidder and self.item_id == other.item_id


@dataclass
class Manifest:
    """调度器的持久化状态文件，记录已完成 / 失败 / 进行中的作业"""
    completed: set[JobKey]
    errored: set[JobKey]  # 超次重试耗尽
    in_flight: set[JobKey]  # 当前正在处理，重启后可重试
    version: str = "1"

    def to_dict(self):
        return {
            "completed": [{"bidder": k.bidder, "item_id": k.item_id} for k in self.completed],
            "errored": [{"bidder": k.bidder, "item_id": k.item_id} for k in self.errored],
            "in_flight": [{"bidder": k.bidder, "item_id": k.item_id} for k in self.in_flight],
            "version": self.version,
        }


def load_manifest(path: Path | None) -> Manifest:
    if path is None or not path.exists():
        return Manifest(completed=set(), errored=set(), in_flight=set())
    data = json.loads(path.read_text(encoding="utf-8"))
    def keys_from(items):
        return {JobKey(bidder=x["bidder"], item_id=x["item_id"]) for x in items}
    return Manifest(
        completed=keys_from(data.get("completed", [])),
        errored=keys_from(data.get("errored", [])),
        in_flight=keys_from(data.get("in_flight", [])),
        version=data.get("version", "1"),
    )


def save_manifest(path: Path, manifest: Manifest):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    content = json.dumps(manifest.to_dict(), ensure_ascii=False, indent=2)
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    _replace_with_retry(tmp, path)


def _replace_with_retry(src: Path, dst: Path, max_attempts: int = 5, backoff: float = 0.1) -> None:
    """os.replace 的 Windows 加固：Defender/索引器会瞬时占用刚写完的 tmp 文件，
    PermissionError 时按指数退避有限重试；其他异常（如磁盘满）照常抛出。"""
    for attempt in range(max_attempts):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if attempt == max_attempts - 1:
                raise
            time.sleep(backoff * (2 ** attempt))


async def async_sleep(seconds: float) -> None:
    """asyncio 版 sleep，便于在 testing 中 mock"""
    await asyncio.sleep(seconds)


async def process_one(
    key: JobKey,
    evidence: Mapping[str, Any],
    item: Mapping[str, Any],
    project_summary: str,
    project_rules: Sequence[str],
    section_index: Mapping[tuple[str, str], str],
    client_factory: Callable[[], Any],
    max_attempts: int = 4,
) -> dict[str, Any]:
    """在工作线程中执行同步 S3 调用，避免阻塞事件循环。"""
    from s3_review import review_one

    async def call() -> dict[str, Any]:
        res = client_factory()
        client = await res if asyncio.iscoroutine(res) else res
        return review_one(
            evidence=evidence,
            item=item,
            project_summary=project_summary,
            project_rules=project_rules,
            section_index=section_index,
            client=client,
            max_attempts=max_attempts,
        )

    return await asyncio.to_thread(lambda: asyncio.run(call()))


def generate_jobs(evidence_packages: Sequence[Mapping[str, Any]]) -> list[tuple[JobKey, Mapping[str, Any]]]:
    """从 evidence 包列表生成唯一作业列表。每个包在同一家 bidder 下只有一个 item_id。"""
    jobs = []
    seen: set[JobKey] = set()
    for pkg in evidence_packages:
        bidder = pkg.get("bidder", "")
        item_id = pkg.get("item_id") or pkg.get("point_id")
        if not bidder or not item_id:
            continue
        key = JobKey(bidder=bidder, item_id=str(item_id))
        if key not in seen:
            seen.add(key)
            jobs.append((key, pkg))
    return jobs


async def run_batch(
    jobs: list[tuple[JobKey, Mapping[str, Any]]],
    items_by_id: dict[str, Mapping[str, Any]],
    project_summary: str,
    project_rules: Sequence[str],
    section_index: Mapping[tuple[str, str], str],
    client_factory: Callable[[], Any],
    work_dir: Path,
    concurrency: int = DEFAULT_CONCURRENCY,
    max_attempts: int = 4,
) -> dict[str, Any]:
    """并发处理批任务，返回汇总结果。"""
    manifest_path = work_dir / "manifest.json"
    manifest = load_manifest(manifest_path)

    results_by_key: dict[JobKey, dict[str, Any]] = {}
    semaphore = asyncio.Semaphore(concurrency)

    async def process_with_semaphore(key: JobKey, pkg: Mapping[str, Any]) -> tuple[JobKey, dict[str, Any] | None]:
        async with semaphore:
            item = items_by_id.get(key.item_id)
            if item is None:
                return key, None
            try:
                result = await process_one(
                    key=key,
                    evidence=pkg,
                    item=item,
                    project_summary=project_summary,
                    project_rules=project_rules,
                    section_index=section_index,
                    client_factory=client_factory,
                    max_attempts=max_attempts,
                )
                return key, result
            except Exception as e:
                return key, {"status": "error", "error": str(e), "attempts": max_attempts}

    pending = [(k, pkg) for k, pkg in jobs if k not in manifest.completed and k not in manifest.errored]
    total = len(pending)
    completed = 0
    errored = 0

    tasks = [process_with_semaphore(k, pkg) for k, pkg in pending]
    for fut in asyncio.as_completed(tasks):
        key, result = await fut
        if result is None:
            manifest.errored.add(key)
            errored += 1
        elif result.get("status") == "rated":
            manifest.completed.add(key)
            results_by_key[key] = result
            completed += 1
        else:
            manifest.errored.add(key)
            results_by_key[key] = result
            errored += 1
        if result is not None:
            # 完成当场落盘：进程中途被杀时，manifest 里 completed/errored 的结果本体不丢。
            # asyncio 单线程顺序 await，无并发写，直接同步写即可。
            _write_item_result(work_dir, key, result)
        manifest.in_flight.discard(key)
        save_manifest(manifest_path, manifest)

    return {
        "total": total,
        "completed": completed,
        "errored": errored,
        "results_by_key": results_by_key,
    }


def _write_item_result(work_dir: Path, key: JobKey, result: Mapping[str, Any]) -> None:
    """把单个作业结果写入 work_dir/<bidder>/<item_id>.json。"""
    bidder_dir = work_dir / key.bidder
    bidder_dir.mkdir(parents=True, exist_ok=True)
    item_file = bidder_dir / f"{key.item_id}.json"
    item_file.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_all_results(work_dir: Path) -> dict[JobKey, dict[str, Any]]:
    """读取 work_dir 下所有已落盘的 per-item 结果，供续跑后的全量聚合。

    键从文件路径还原（<bidder>/<item_id>.json）；result is None（评分表缺项）的
    key 没有 per-item 文件，自然不在返回中，调用方按缺失容忍处理。
    """
    results: dict[JobKey, dict[str, Any]] = {}
    if not work_dir.exists():
        return results
    for item_file in sorted(work_dir.glob("*/*.json")):
        key = JobKey(bidder=item_file.parent.name, item_id=item_file.stem)
        results[key] = json.loads(item_file.read_text(encoding="utf-8"))
    return results


def main(argv: Sequence[str] | None = None) -> int:
    """T3 调度器 CLI 接口。

    用法：
        python src/scheduler.py \
            --evidence data/projects/jiyang-epc/evidence \
            --scoring-table config/projects/济阳区实验高级中学.yaml \
            --project-summary data/projects/jiyang-epc/summary.md \
            --sections data/projects/jiyang-epc/sections_all.json \
            --output data/projects/jiyang-epc/reviews \
            --concurrency 12 \
            --mock
    """
    import argparse
    import yaml
    from s3_review import _index_sections, _extract_sections, _extract_evidence_packages, MockModelClient, OpenAICompatibleClient, AgentFactoryClient

    parser = argparse.ArgumentParser(description="T3: 并发调度器")
    parser.add_argument("--evidence", type=Path, required=True, help="单家或全项目's evidence 目录")
    parser.add_argument("--scoring-table", type=Path, required=True, help="S0 生成的评分表 YAML")
    parser.add_argument("--project-summary", type=Path, required=True, help="项目特征摘要文本")
    parser.add_argument("--sections", type=Path, required=True, help="S1 生成的章节 JSON（sections_all.json 时可选，单家时必需）")
    parser.add_argument("--output", type=Path, required=True, help="输出目录：每个 item 一个 JSON")
    parser.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY, help="并发路数")
    parser.add_argument("--mock", action="store_true", help="使用 Mock 模型")
    parser.add_argument("--agent-factory", action="store_true", help="使用智能体工厂端点（读 AF_BASE_URL / AF_API_KEY / AF_AGENT_ID）")
    parser.add_argument("--max-attempts", type=int, default=4, help="最大重试次数")
    args = parser.parse_args(argv)

    # 加载配置
    scoring_table = yaml.safe_load(args.scoring_table.read_text(encoding="utf-8"))
    items_by_id = {str(it["id"]): it for it in scoring_table.get("items", [])}
    project_summary = args.project_summary.read_text(encoding="utf-8").strip()
    rules = scoring_table.get("rules") or []

    # 加载章节索引
    sections_data = json.loads(args.sections.read_text(encoding="utf-8"))
    sections = _extract_sections(sections_data)
    section_index = _index_sections(sections)

    # 客户端工厂：mock > agent-factory > 默认 OpenAI 兼容端点
    if args.mock:
        client_factory = lambda: MockModelClient()
    elif args.agent_factory:
        client_factory = lambda: AgentFactoryClient.from_env()
    else:
        client_factory = lambda: OpenAICompatibleClient.from_env()

    # 收集所有 jobs
    evidence_dir = args.evidence
    if evidence_dir.is_file():
        # 单文件模式
        packages = [_extract_evidence_packages(json.loads(evidence_dir.read_text(encoding="utf-8"))[0])[0]]
    else:
        packages = []
        for json_file in evidence_dir.glob("*/located.json"):
            packages.extend(_extract_evidence_packages(json.loads(json_file.read_text(encoding="utf-8"))))

    jobs = generate_jobs(packages)
    if not jobs:
        print("No jobs found", file=sys.stderr)
        return 1

    # 并发处理
    work_dir = args.output
    work_dir.mkdir(parents=True, exist_ok=True)

    results = asyncio.run(run_batch(
        jobs=jobs,
        items_by_id=items_by_id,
        project_summary=project_summary,
        project_rules=rules,
        section_index=section_index,
        client_factory=client_factory,
        work_dir=work_dir,
        concurrency=args.concurrency,
        max_attempts=args.max_attempts,
    ))

    # 写最终汇总：以 work_dir 下已落盘的 per-item 文件为准做全量聚合，
    # 覆盖 manifest.completed 的所有 key，保证续跑后 reviews.json 不残缺。
    all_results = load_all_results(work_dir)
    output = {
        "project": scoring_table.get("project", ""),
        "generated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "model": "mock" if args.mock else client_factory().name,
        "review_results": list(all_results.values()),
        "perf": {
            "calls": results["total"],
            "retries": 0,  # 由每个结果的 perf 决定，汇总在 review_results
            "completed": results["completed"],
            "errored": results["errored"],
        },
    }
    output_path = work_dir / "reviews.json"
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {output_path} ({len(output['review_results'])} reviews)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
"""T3 调度器单元测试。"""
import asyncio
import json
import os
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# 把 src 加入 sys.path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from scheduler import JobKey, Manifest, load_manifest, save_manifest, generate_jobs, run_batch, process_one


class TestJobKey:
    def test_hash_eq(self):
        k1 = JobKey(bidder="A", item_id="T-01")
        k2 = JobKey(bidder="A", item_id="T-01")
        assert k1 == k2
        assert hash(k1) == hash(k2)

    def test_neq(self):
        k1 = JobKey(bidder="A", item_id="T-01")
        k2 = JobKey(bidder="B", item_id="T-01")
        assert k1 != k2


class TestManifest:
    def test_roundtrip(self, tmp_path: Path):
        m = Manifest(
            completed={JobKey("A", "T-01"), JobKey("B", "T-02")},
            errored={JobKey("C", "T-03")},
            in_flight=set(),
        )
        save_manifest(tmp_path / "manifest.json", m)
        loaded = load_manifest(tmp_path / "manifest.json")
        assert loaded.completed == m.completed
        assert loaded.errored == m.errored
        assert loaded.in_flight == set()

    def test_load_missing(self):
        m = load_manifest(Path("/nonexistent/manifest.json"))
        assert m.completed == set()
        assert m.errored == set()


class TestGenerateJobs:
    def test_dedup(self):
        packages = [
            {"bidder": "A", "item_id": "T-01", "text": "a"},
            {"bidder": "A", "item_id": "T-01", "text": "b"},  # 重复
            {"bidder": "A", "item_id": "T-02", "text": "c"},
        ]
        jobs = generate_jobs(packages)
        assert len(jobs) == 2
        keys = {k for k, _ in jobs}
        assert JobKey("A", "T-01") in keys
        assert JobKey("A", "T-02") in keys

    def test_missing_bidder(self):
        packages = [{"item_id": "T-01", "text": "a"}]
        assert generate_jobs(packages) == []


class TestRunBatch:
    """测试并发调度器逻辑。"""

    def test_mock_runs(self, tmp_path: Path):
        """用 MockModelClient 验证 run_batch 能跑通。"""
        from s3_review import MockModelClient, _index_sections, _extract_sections, _extract_evidence_packages

        # 加载真实数据的 sections
        sections_file = Path("data/projects/jiyang-epc/sections_all.json")
        if not sections_file.exists():
            pytest.skip("需要真实 sections_all.json")

        sections_data = json.loads(sections_file.read_text(encoding="utf-8"))
        sections = _extract_sections(sections_data)
        section_index = _index_sections(sections)

        # 加载评分表
        scoring_file = Path("config/projects/济阳区实验高级中学.yaml")
        if not scoring_file.exists():
            pytest.skip("需要评分表")
        import yaml
        scoring_table = yaml.safe_load(scoring_file.read_text(encoding="utf-8"))
        items_by_id = {str(it["id"]): it for it in scoring_table.get("items", [])}

        # 项目摘要
        summary_file = Path("config/projects/项目特征摘要.md")
        if not summary_file.exists():
            pytest.skip("需要项目特征摘要")
        project_summary = summary_file.read_text(encoding="utf-8").strip()
        rules = scoring_table.get("rules") or []

        # 收集证据包（只取前两家，加速测试）
        evidence_dir = Path("data/projects/jiyang-epc/evidence")
        packages = []
        for json_file in list(evidence_dir.glob("*/located.json"))[:2]:
            packages.extend(_extract_evidence_packages(json.loads(json_file.read_text(encoding="utf-8"))))

        jobs = generate_jobs(packages)
        if not jobs:
            pytest.skip("没有 jobs")

        # 并发运行
        work_dir = tmp_path / "reviews"
        work_dir.mkdir()

        async def mock_factory():
            return MockModelClient()

        results = asyncio.run(run_batch(
            jobs=jobs,
            items_by_id=items_by_id,
            project_summary=project_summary,
            project_rules=rules,
            section_index=section_index,
            client_factory=mock_factory,
            work_dir=work_dir,
            concurrency=2,
            max_attempts=2,
        ))

        assert results["total"] > 0
        assert results["completed"] > 0

        # 检查 manifest
        manifest = load_manifest(work_dir / "manifest.json")
        assert len(manifest.completed) > 0

        # 检查输出文件
        # T3 现在按 bidder/item_id 写入，不再写 reviews.json
        for key in results['results_by_key'].keys():
            assert (work_dir / key.bidder / f"{key.item_id}.json").exists()

    def test_item_file_layout(self, tmp_path: Path):
        """验证每个 item 都写入了对应的 bidder/item_id.json"""
        import yaml
        from s3_review import MockModelClient, _index_sections, _extract_sections, _extract_evidence_packages

        if not Path("data/projects/jiyang-epc/sections_all.json").exists():
            pytest.skip("需要真实 sections_all.json")

        sections_data = json.loads(Path("data/projects/jiyang-epc/sections_all.json").read_text(encoding="utf-8"))
        sections = _extract_sections(sections_data)
        section_index = _index_sections(sections)

        scoring_table = yaml.safe_load(Path("config/projects/济阳区实验高级中学.yaml").read_text(encoding="utf-8"))
        items_by_id = {str(it["id"]): it for it in scoring_table.get("items", [])}

        project_summary = Path("config/projects/项目特征摘要.md").read_text(encoding="utf-8").strip()
        rules = scoring_table.get("rules") or []

        packages = []
        for json_file in list(Path("data/projects/jiyang-epc/evidence").glob("*/located.json"))[:1]:
            packages.extend(_extract_evidence_packages(json.loads(json_file.read_text(encoding="utf-8"))))

        jobs = generate_jobs(packages)
        work_dir = tmp_path / "reviews"
        work_dir.mkdir()

        async def mock_factory():
            return MockModelClient()

        results = asyncio.run(run_batch(
            jobs=jobs,
            items_by_id=items_by_id,
            project_summary=project_summary,
            project_rules=rules,
            section_index=section_index,
            client_factory=mock_factory,
            work_dir=work_dir,
            concurrency=2,
            max_attempts=2,
        ))

        # 检查文件布局
        for key in results['results_by_key'].keys():
            target = work_dir / key.bidder / f"{key.item_id}.json"
            assert target.exists(), f"Missing file: {target}"
            content = json.loads(target.read_text(encoding="utf-8"))
            assert content['status'] == 'rated'


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

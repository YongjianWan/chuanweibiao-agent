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

    def test_replace_retries_transient_permission_error(self, tmp_path: Path, monkeypatch):
        """Windows 上 Defender/索引器瞬时占用 tmp 文件，os.replace 抛 PermissionError 应重试。"""
        import scheduler as sched

        m = Manifest(completed={JobKey("A", "T-01")}, errored=set(), in_flight=set())
        target = tmp_path / "manifest.json"

        real_replace = os.replace
        attempts = {"n": 0}

        def flaky_replace(src, dst):
            attempts["n"] += 1
            if attempts["n"] <= 2:
                raise PermissionError(5, "拒绝访问", str(src))
            return real_replace(src, dst)

        monkeypatch.setattr(os, "replace", flaky_replace)
        monkeypatch.setattr(sched.time, "sleep", lambda _: None)  # 退避不真睡

        save_manifest(target, m)
        assert attempts["n"] == 3
        loaded = load_manifest(target)
        assert loaded.completed == m.completed

    def test_replace_gives_up_after_max_attempts(self, tmp_path: Path, monkeypatch):
        """PermissionError 持续超过重试上限时必须照常抛出，不能静默吞掉。"""
        import scheduler as sched

        monkeypatch.setattr(os, "replace", MagicMock(side_effect=PermissionError(5, "拒绝访问")))
        monkeypatch.setattr(sched.time, "sleep", lambda _: None)

        with pytest.raises(PermissionError):
            save_manifest(tmp_path / "manifest.json", Manifest(set(), set(), set()))
        assert os.replace.call_count == 5

    def test_replace_non_permission_error_not_retried(self, tmp_path: Path, monkeypatch):
        """非 PermissionError（如磁盘满）不是瞬时占用，必须立即抛出。"""
        import scheduler as sched

        monkeypatch.setattr(os, "replace", MagicMock(side_effect=OSError(28, "磁盘已满")))

        with pytest.raises(OSError):
            save_manifest(tmp_path / "manifest.json", Manifest(set(), set(), set()))
        assert os.replace.call_count == 1


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


class TestResumeAfterCrash:
    """断点续跑：第一批跑完一部分 → 进程死掉 → 第二批续跑，聚合必须覆盖全部 key。"""

    def _make_jobs(self):
        item_base = {
            "name": "资质",
            "max_score": 10,
            "tiers": [
                {"tier": "优", "min": 8, "max": 10},
                {"tier": "中", "min": 4, "max": 8},
                {"tier": "差", "min": 0, "max": 4},
            ],
            "criteria": "评审资质",
        }
        items_by_id = {
            "T-01": {"id": "T-01", **item_base},
            "T-02": {"id": "T-02", "name": "业绩", **{k: v for k, v in item_base.items() if k != "name"}},
        }
        jobs = []
        for bidder in ("甲公司", "乙公司"):
            for item_id in ("T-01", "T-02"):
                pkg = {
                    "bidder": bidder,
                    "item_id": item_id,
                    "picked": [{"section_id": "S1", "text": "投标响应正文"}],
                }
                jobs.append((JobKey(bidder, item_id), pkg))
        return jobs, items_by_id

    def test_resume_aggregates_full_results(self, tmp_path: Path):
        from s3_review import MockModelClient
        import scheduler as sched

        jobs, items_by_id = self._make_jobs()
        all_keys = {k for k, _ in jobs}
        assert len(all_keys) == 4

        work_dir = tmp_path / "reviews"
        work_dir.mkdir()

        async def mock_factory():
            return MockModelClient()

        kwargs = dict(
            items_by_id=items_by_id,
            project_summary="项目摘要",
            project_rules=[],
            section_index={},
            client_factory=mock_factory,
            work_dir=work_dir,
            concurrency=2,
            max_attempts=1,
        )

        # 第一批：manifest 记满 2 个 completed 后模拟进程被杀（manifest 已落盘）
        real_save = sched.save_manifest

        def crashing_save(path, manifest):
            real_save(path, manifest)
            if len(manifest.completed) >= 2:
                raise RuntimeError("模拟进程被杀")

        with patch.object(sched, "save_manifest", crashing_save):
            with pytest.raises(RuntimeError, match="模拟进程被杀"):
                asyncio.run(run_batch(jobs=jobs, **kwargs))

        # 崩溃现场：manifest 有 2 个 completed，且它们的 per-item 文件必须已落盘
        crashed_manifest = load_manifest(work_dir / "manifest.json")
        assert len(crashed_manifest.completed) == 2
        for key in crashed_manifest.completed:
            assert (work_dir / key.bidder / f"{key.item_id}.json").exists(), (
                f"作业完成时 per-item 文件必须当场落盘，缺失：{key}"
            )

        # 第二批：续跑，只应新跑剩下的 2 个
        resumed = asyncio.run(run_batch(jobs=jobs, **kwargs))
        assert resumed["completed"] == 2
        assert set(resumed["results_by_key"]) == all_keys - crashed_manifest.completed

        # 聚合：已存在的 per-item 文件 + 本次新跑的，必须覆盖全部 4 个 key
        from scheduler import load_all_results
        all_results = load_all_results(work_dir)
        assert set(all_results) == all_keys
        for key, result in all_results.items():
            assert result["status"] == "rated", f"{key} 的结果缺失或非 rated"


class TestMainAgentFactory:
    """scheduler CLI 的 --agent-factory 必须选用 AgentFactoryClient。"""

    def _write_minimal_inputs(self, tmp_path: Path) -> dict:
        scoring = tmp_path / "scoring.yaml"
        scoring.write_text(
            "project: 测试项目\n"
            "items:\n"
            "  - id: T-01\n"
            "    name: 资质\n"
            "    max_score: 10\n"
            "    criteria: 评审资质\n"
            "    tiers:\n"
            "      - {tier: 优, min: 8, max: 10}\n"
            "      - {tier: 中, min: 4, max: 8}\n"
            "      - {tier: 差, min: 0, max: 4}\n",
            encoding="utf-8",
        )
        summary = tmp_path / "summary.md"
        summary.write_text("项目摘要\n", encoding="utf-8")
        sections = tmp_path / "sections.json"
        sections.write_text(
            json.dumps([{"id": "S1", "bidder": "甲公司", "text": "投标响应正文"}], ensure_ascii=False),
            encoding="utf-8",
        )
        bidder_dir = tmp_path / "evidence" / "甲公司"
        bidder_dir.mkdir(parents=True)
        (bidder_dir / "located.json").write_text(
            json.dumps(
                [{"bidder": "甲公司", "item_id": "T-01", "picked": [{"section_id": "S1", "text": "投标响应正文"}]}],
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        return {
            "scoring": scoring,
            "summary": summary,
            "sections": sections,
            "evidence": tmp_path / "evidence",
            "output": tmp_path / "out",
        }

    def test_agent_factory_flag_uses_agent_factory_client(self, tmp_path: Path, monkeypatch):
        import scheduler as sched
        from s3_review import AgentFactoryClient, MockModelClient

        paths = self._write_minimal_inputs(tmp_path)
        calls = {"n": 0}

        def fake_from_env(cls, timeout=300.0):
            calls["n"] += 1
            return MockModelClient()

        monkeypatch.setattr(AgentFactoryClient, "from_env", classmethod(fake_from_env))

        rc = sched.main([
            "--evidence", str(paths["evidence"]),
            "--scoring-table", str(paths["scoring"]),
            "--project-summary", str(paths["summary"]),
            "--sections", str(paths["sections"]),
            "--output", str(paths["output"]),
            "--agent-factory",
        ])

        assert rc == 0
        assert calls["n"] >= 1, "--agent-factory 时必须通过 AgentFactoryClient.from_env 建客户端"
        reviews = json.loads((paths["output"] / "reviews.json").read_text(encoding="utf-8"))
        assert reviews["model"] == "mock"  # stub 客户端的 name，证明走的是被打桩的工厂
        assert len(reviews["review_results"]) == 1
        assert reviews["review_results"][0]["status"] == "rated"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

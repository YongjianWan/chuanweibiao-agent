"""T6 S4 报告生成器单元测试。

合成 2 投标人 × 3 评分项的 reviews 目录 fixture，覆盖：
- matrix 中 null（未评定）与 0（未命中）的严格区分
- audit：某档全部投标人同档触发 no_discrimination
- 专家改判口径（expert_score / expert_overrides）
- 无 expert_reviews 文件时的默认行为
- perf.calls 覆盖度校验位 = 家数 × 项数
"""
import json
import sys
from pathlib import Path

import pytest

# 把 src 加入 sys.path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import s4_report

BIDDER_A = "甲公司A0001"
BIDDER_B = "乙公司B0002"

SCORING_TABLE = """\
project: 测试项目
rules:
- 若此条缺项不得分
items:
- id: T-01
  name: 施工方案
  max_score: 4.0
  tiers:
  - {tier: 优, min: 3.0, max: 4.0}
  - {tier: 良, min: 2.0, max: 3.0}
  - {tier: 一般, min: 1.0, max: 2.0}
- id: T-02
  name: 进度管理方案
  max_score: 3.0
  tiers:
  - {tier: 优, min: 2.5, max: 3.0}
  - {tier: 良, min: 1.7, max: 2.5}
  - {tier: 一般, min: 1.2, max: 1.7}
- id: T-03
  name: 风险管理方案
  max_score: 2.0
  tiers:
  - {tier: 优, min: 1.5, max: 2.0}
  - {tier: 良, min: 0.7, max: 1.5}
  - {tier: 一般, min: 0.2, max: 0.7}
"""


def _review(bidder, item_id, *, status="rated", tier="优", score=3.5,
            miss_reason=None, confidence=1.0, attempts=1, last_error="",
            in_tokens=1000, out_tokens=100, latency_ms=5000):
    return {
        "item_id": item_id,
        "bidder": bidder,
        "status": status,
        "tier": tier,
        "score": score,
        "miss_reason": miss_reason,
        "cite": [0],
        "reason": "测试理由",
        "confidence": confidence,
        "attempts": attempts,
        "last_error": last_error,
        "perf": {"in_tokens": in_tokens, "out_tokens": out_tokens,
                 "latency_ms": latency_ms},
    }


@pytest.fixture
def reviews_dir(tmp_path: Path) -> Path:
    """2 家 × 3 项的 reviews 目录（<bidder>/<item_id>.json 形态）。

    - 甲/T-01：rated 优 3.5，confidence 1.0，attempts 1
    - 甲/T-02：rated 良 2.2，confidence 0.63（进 review_flags），attempts 2
    - 甲/T-03：rated 0 分，miss_reason=not_found（检索未命中），attempts 0
    - 乙/T-01：rated 优 3.8，confidence 1.0，attempts 1
    - 乙/T-02：unrated，score null，attempts 3，last_error 有值
    - 乙/T-03：rated 0 分，miss_reason=no_file（确实没写），attempts 0
    """
    root = tmp_path / "reviews"
    data = [
        _review(BIDDER_A, "T-01", tier="优", score=3.5),
        _review(BIDDER_A, "T-02", tier="良", score=2.2, confidence=0.63,
                attempts=2),
        _review(BIDDER_A, "T-03", tier=None, score=0, miss_reason="not_found",
                confidence=0.5, attempts=0, in_tokens=0, out_tokens=0,
                latency_ms=0),
        _review(BIDDER_B, "T-01", tier="优", score=3.8),
        _review(BIDDER_B, "T-02", status="unrated", tier=None, score=None,
                confidence=0.0, attempts=3, last_error="JSON 解析失败"),
        _review(BIDDER_B, "T-03", tier=None, score=0, miss_reason="no_file",
                confidence=1.0, attempts=0, in_tokens=0, out_tokens=0,
                latency_ms=0),
    ]
    for r in data:
        d = root / r["bidder"]
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{r['item_id']}.json").write_text(
            json.dumps(r, ensure_ascii=False), encoding="utf-8")
    return root


@pytest.fixture
def scoring_table(tmp_path: Path) -> Path:
    p = tmp_path / "scoring.yaml"
    p.write_text(SCORING_TABLE, encoding="utf-8")
    return p


class TestReportStructure:
    """report.json 顶层结构对齐 docs/data-contract.md §7。"""

    def test_顶层字段齐全(self, reviews_dir, scoring_table):
        report = s4_report.build_report(reviews_dir, scoring_table)
        for key in ("project", "generated_at", "bidders", "matrix", "totals",
                    "details", "unrated", "review_flags", "audit",
                    "expert_reviews", "perf", "compute_notes"):
            assert key in report, f"缺顶层字段 {key}"

    def test_generated_at带时区(self, reviews_dir, scoring_table):
        report = s4_report.build_report(reviews_dir, scoring_table)
        from datetime import datetime
        dt = datetime.fromisoformat(report["generated_at"])
        assert dt.tzinfo is not None

    def test_matrix行来自评分表(self, reviews_dir, scoring_table):
        report = s4_report.build_report(reviews_dir, scoring_table)
        assert [r["item_id"] for r in report["matrix"]] == ["T-01", "T-02", "T-03"]
        row = report["matrix"][0]
        assert row["name"] == "施工方案"
        assert row["max_score"] == 4.0
        assert set(row["scores"].keys()) == {BIDDER_A, BIDDER_B}


class TestNullZeroDistinction:
    """matrix：null = 未评定，0 = 未命中/没写，两者不得合并（§7）。"""

    def test_未评定为null_未命中为0(self, reviews_dir, scoring_table):
        report = s4_report.build_report(reviews_dir, scoring_table)
        rows = {r["item_id"]: r["scores"] for r in report["matrix"]}
        assert rows["T-02"][BIDDER_B] is None          # unrated → null
        assert rows["T-03"][BIDDER_A] == 0             # not_found → 0
        assert rows["T-03"][BIDDER_A] is not None
        assert rows["T-03"][BIDDER_B] == 0             # no_file → 0
        assert rows["T-01"][BIDDER_A] == 3.5

    def test_未命中原因在details里可区分(self, reviews_dir, scoring_table):
        report = s4_report.build_report(reviews_dir, scoring_table)
        t03 = {(d["bidder"]): d for d in report["details"] if d["item_id"] == "T-03"}
        assert t03[BIDDER_A]["miss_reason"] == "not_found"
        assert t03[BIDDER_B]["miss_reason"] == "no_file"


class TestTotals:
    def test_score不含未评定项(self, reviews_dir, scoring_table):
        report = s4_report.build_report(reviews_dir, scoring_table)
        # 乙：T-01 3.8 + T-03 0，T-02 未评定不计入
        assert report["totals"][BIDDER_B]["score"] == pytest.approx(3.8)
        assert report["totals"][BIDDER_B]["unrated"] == 1
        # 甲：3.5 + 2.2 + 0
        assert report["totals"][BIDDER_A]["score"] == pytest.approx(5.7)
        assert report["totals"][BIDDER_A]["unrated"] == 0

    def test_无专家文件时expert_score等于score(self, reviews_dir, scoring_table):
        report = s4_report.build_report(reviews_dir, scoring_table)
        for bidder in (BIDDER_A, BIDDER_B):
            t = report["totals"][bidder]
            assert t["expert_score"] == t["score"]
            assert t["expert_score"] is not None
            assert t["expert_overrides"] == 0
        assert report["expert_reviews"] == []


class TestExpertReviews:
    @pytest.fixture
    def expert_file(self, tmp_path: Path) -> Path:
        records = [
            # 乙/T-02：系统未评定，专家改判 1.5（delta 因系统分 null 记 null）
            {"bidder": BIDDER_B, "item_id": "T-02", "action": "改判",
             "system_score": None, "expert_score": 1.5, "delta": None,
             "note": "检索没取到", "reviewed_at": "2026-08-21T14:20:03+08:00"},
            # 甲/T-02：认可，不改判
            {"bidder": BIDDER_A, "item_id": "T-02", "action": "认可",
             "system_score": 2.2, "expert_score": 2.2, "delta": 0,
             "note": "", "reviewed_at": "2026-08-21T14:21:00+08:00"},
        ]
        p = tmp_path / "expert_reviews.json"
        p.write_text(json.dumps(records, ensure_ascii=False), encoding="utf-8")
        return p

    def test_改判口径(self, reviews_dir, scoring_table, expert_file):
        report = s4_report.build_report(reviews_dir, scoring_table,
                                        expert_reviews_path=expert_file)
        # 乙：expert_score = 3.8 + 1.5（改判计入）+ 0；score 仍为 3.8
        assert report["totals"][BIDDER_B]["expert_score"] == pytest.approx(5.3)
        assert report["totals"][BIDDER_B]["score"] == pytest.approx(3.8)
        assert report["totals"][BIDDER_B]["expert_overrides"] == 1
        # 甲只有「认可」记录，不改合计
        assert report["totals"][BIDDER_A]["expert_score"] == pytest.approx(
            report["totals"][BIDDER_A]["score"])
        assert report["totals"][BIDDER_A]["expert_overrides"] == 0
        assert len(report["expert_reviews"]) == 2

    def test_同一项多条记录取最新(self, reviews_dir, scoring_table, tmp_path):
        records = [
            {"bidder": BIDDER_A, "item_id": "T-01", "action": "改判",
             "system_score": 3.5, "expert_score": 3.9, "delta": 0.4,
             "note": "第一次", "reviewed_at": "2026-08-21T10:00:00+08:00"},
            {"bidder": BIDDER_A, "item_id": "T-01", "action": "认可",
             "system_score": 3.5, "expert_score": 3.5, "delta": 0,
             "note": "第二次撤回改判", "reviewed_at": "2026-08-21T11:00:00+08:00"},
        ]
        p = tmp_path / "expert_reviews.json"
        p.write_text(json.dumps(records, ensure_ascii=False), encoding="utf-8")
        report = s4_report.build_report(reviews_dir, scoring_table,
                                        expert_reviews_path=p)
        # 最新一条是「认可」，不生效
        assert report["totals"][BIDDER_A]["expert_overrides"] == 0
        assert report["totals"][BIDDER_A]["expert_score"] == pytest.approx(5.7)


class TestAudit:
    def test_全部同档触发no_discrimination(self, reviews_dir, scoring_table):
        report = s4_report.build_report(reviews_dir, scoring_table)
        audit = {a["item_id"]: a for a in report["audit"]}
        # T-01：两家都判「优」
        assert "T-01" in audit
        assert audit["T-01"]["kind"] == "no_discrimination"
        assert audit["T-01"]["tier_dist"] == {"优": 2, "良": 0, "一般": 0}
        # T-03：两家都 0 分未命中
        assert "T-03" in audit
        # T-02：一良一未评定，不触发
        assert "T-02" not in audit


class TestReviewFlagsAndUnrated:
    def test_低置信度进review_flags(self, reviews_dir, scoring_table):
        report = s4_report.build_report(reviews_dir, scoring_table)
        flags = {(f["bidder"], f["item_id"]): f for f in report["review_flags"]}
        # confidence 0.63 与 0.5（not_found）与 0.0（unrated 不进？）
        assert (BIDDER_A, "T-02") in flags
        assert flags[(BIDDER_A, "T-02")]["confidence"] == 0.63
        assert flags[(BIDDER_A, "T-02")]["why"]
        assert (BIDDER_A, "T-03") in flags
        # 高置信度不进
        assert (BIDDER_A, "T-01") not in flags
        assert (BIDDER_B, "T-03") not in flags
        # unrated 归 unrated 清单，不占 review_flags
        assert (BIDDER_B, "T-02") not in flags

    def test_unrated清单(self, reviews_dir, scoring_table):
        report = s4_report.build_report(reviews_dir, scoring_table)
        assert report["unrated"] == [
            {"bidder": BIDDER_B, "item_id": "T-02",
             "attempts": 3, "last_error": "JSON 解析失败"}]


class TestPerf:
    def test_calls为覆盖度校验位(self, reviews_dir, scoring_table):
        report = s4_report.build_report(reviews_dir, scoring_table)
        assert report["perf"]["calls"] == 2 * 3

    def test_retries按attempts口径(self, reviews_dir, scoring_table):
        report = s4_report.build_report(reviews_dir, scoring_table)
        # attempts: 1,2,0,1,3,0 → 模型调用 7 次 = calls 6 − 未命中 2 + retries 3
        assert report["perf"]["retries"] == 3

    def test_gpu字段不省略不估算(self, reviews_dir, scoring_table):
        report = s4_report.build_report(reviews_dir, scoring_table)
        perf = report["perf"]
        assert perf["gpu"] == "未采集"
        assert perf["vram_peak_gb"] is None
        assert perf["gpu_note"]

    def test_token汇总(self, reviews_dir, scoring_table):
        report = s4_report.build_report(reviews_dir, scoring_table)
        # in_tokens: 1000×3（T-01×2 + 甲T-02 + 乙T-02 unrated 也是 1000）
        # 甲T-01 1000, 甲T-02 1000, 甲T-03 0, 乙T-01 1000, 乙T-02 1000, 乙T-03 0
        assert report["perf"]["in_tokens"] == 4000
        assert report["perf"]["out_tokens"] == 400


class TestComputeNotes:
    def test_占位与method(self, reviews_dir, scoring_table):
        report = s4_report.build_report(reviews_dir, scoring_table)
        cn = report["compute_notes"]
        for key in ("owner", "spec", "model", "method"):
            assert key in cn
        assert "未采集" in cn["owner"]
        assert "未采集" in cn["spec"]
        assert "未采集" in cn["model"]
        assert isinstance(cn["method"], list) and len(cn["method"]) == 2


class TestDetails:
    def test_details按bidder加item_id排序(self, reviews_dir, scoring_table):
        report = s4_report.build_report(reviews_dir, scoring_table)
        keys = [(d["bidder"], d["item_id"]) for d in report["details"]]
        assert keys == sorted(keys)
        assert len(report["details"]) == 6


class TestMarkdown:
    def test_null渲染为横线_0渲染为0(self, reviews_dir, scoring_table):
        report = s4_report.build_report(reviews_dir, scoring_table)
        md = s4_report.render_markdown(report)
        assert "—" in md          # 未评定
        assert "⚠" in md          # 复核清单
        assert BIDDER_A in md and BIDDER_B in md
        assert "未评定" in md

    def test_人读版包含各节(self, reviews_dir, scoring_table):
        report = s4_report.build_report(reviews_dir, scoring_table)
        md = s4_report.render_markdown(report)
        assert "总分排名" in md
        assert "系统判分" in md and "专家判分" in md
        assert "复核" in md
        assert "审计" in md or "告警" in md
        assert "未评定" in md


class TestCli:
    def test_main产出两个文件(self, reviews_dir, scoring_table, tmp_path):
        out = tmp_path / "out"
        rc = s4_report.main([
            "--reviews", str(reviews_dir),
            "--scoring-table", str(scoring_table),
            "--output", str(out),
        ])
        assert rc == 0
        report = json.loads((out / "report.json").read_text(encoding="utf-8"))
        assert report["project"] == "测试项目"
        md = (out / "report.md").read_text(encoding="utf-8")
        assert "总分排名" in md

    def test_main可选expert_reviews(self, reviews_dir, scoring_table, tmp_path):
        out = tmp_path / "out"
        rc = s4_report.main([
            "--reviews", str(reviews_dir),
            "--scoring-table", str(scoring_table),
            "--output", str(out),
            "--expert-reviews", str(tmp_path / "不存在的文件.json"),
        ])
        assert rc == 0
        report = json.loads((out / "report.json").read_text(encoding="utf-8"))
        assert report["expert_reviews"] == []

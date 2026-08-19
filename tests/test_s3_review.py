"""S3 模型侧回归测试。

本文件只会在开发人员执行 pytest 时运行，线上 ``s3_review.py`` 不会导入或执行它。
测试用于守住重试、引用校验、未评定、分数区间和置信度等已经确定的业务规则。
"""

import json
from collections import deque

import pytest

from src.s3_review import ModelResponse, MockModelClient, review_all, review_one


ITEM = {
    "id": "T-02",
    "guid": "test-guid",
    "name": "进度管理方案",
    "max_score": 4.0,
    "tiers": [
        {"tier": "优", "min": 3.0, "max": 4.0, "desc": "内容完整且有针对性"},
        {"tier": "良", "min": 2.0, "max": 3.0, "desc": "内容基本完整"},
        {"tier": "一般", "min": 1.0, "max": 2.0, "desc": "内容一般"},
    ],
    "factors": [
        {"name": "计划完整性", "weight": 0.6},
        {"name": "项目针对性", "weight": 0.4},
    ],
}

EVIDENCE = {
    "item_id": "T-02",
    "item_guid": "test-guid",
    "bidder": "测试投标人001",
    "fallback": False,
    "picked": [
        {
            "section_id": "1#1",
            "file": "进度管理方案.pdf",
            "path": ["第一章", "进度计划"],
            "chars": 20,
            "truncated": False,
        }
    ],
}

SECTIONS = {("测试投标人001", "1#1"): "本项目设置关键路径、里程碑和进度纠偏机制。"}


def model_payload(*, tier="良", cite=None, values=(0.5, 0.75)):
    return json.dumps(
        {
            "tier": tier,
            "factor_scores": [
                {"name": "计划完整性", "value": values[0]},
                {"name": "项目针对性", "value": values[1]},
            ],
            "cite": [0] if cite is None else cite,
            "reason": "包含关键路径和进度纠偏机制。",
        },
        ensure_ascii=False,
    )


class SequenceClient:
    name = "sequence"

    def __init__(self, responses):
        self.responses = deque(responses)
        self.messages = []

    def complete(self, messages):
        self.messages.append(messages)
        value = self.responses.popleft()
        if isinstance(value, Exception):
            raise value
        return ModelResponse(value, in_tokens=10, out_tokens=2, latency_ms=50)


def test_review_one_builds_score_citations_and_perf():
    client = SequenceClient([model_payload()])

    result = review_one(EVIDENCE, ITEM, "EPC 教学楼工程", ["缺项不得分"], SECTIONS, client)

    assert result["status"] == "rated"
    assert result["tier"] == "良"
    assert result["score"] == 2.6
    assert result["cite"] == [0]
    assert result["confidence"] == 1.0
    assert result["attempts"] == 1
    assert result["perf"] == {"in_tokens": 10, "out_tokens": 2, "latency_ms": 50}
    request = json.loads(client.messages[0][-1]["content"])
    assert request["evidence"][0]["text"].startswith("本项目设置关键路径")


def test_empty_evidence_is_zero_without_calling_model():
    client = SequenceClient([])
    evidence = {**EVIDENCE, "picked": []}

    result = review_one(evidence, ITEM, "摘要", [], SECTIONS, client)

    assert result["status"] == "rated"
    assert result["score"] == 0
    assert result["tier"] is None
    assert result["attempts"] == 0
    assert client.messages == []


def test_invalid_json_retries_and_includes_previous_error():
    client = SequenceClient(["not json", model_payload()])
    sleeps = []

    result = review_one(EVIDENCE, ITEM, "摘要", [], SECTIONS, client, sleep=sleeps.append)

    assert result["status"] == "rated"
    assert result["attempts"] == 2
    assert result["confidence"] == 0.9
    assert result["confidence_factors"] == ["重试"]
    assert sleeps == [2.0]
    retry_request = json.loads(client.messages[1][-1]["content"])
    assert "JSON 解析失败" in retry_request["previous_error"]


def test_out_of_range_citation_exhausts_to_unrated():
    client = SequenceClient([model_payload(cite=[1])] * 4)
    sleeps = []

    result = review_one(EVIDENCE, ITEM, "摘要", [], SECTIONS, client, sleep=sleeps.append)

    assert result["status"] == "unrated"
    assert result["score"] is None
    assert result["attempts"] == 4
    assert "越界" in result["last_error"]
    assert sleeps == [2.0, 4.0, 8.0]


def test_endpoint_failures_exhaust_to_unrated():
    client = SequenceClient([TimeoutError("timeout")] * 4)

    result = review_one(EVIDENCE, ITEM, "摘要", [], SECTIONS, client, sleep=lambda _: None)

    assert result["status"] == "unrated"
    assert result["score"] is None
    assert result["last_error"] == "timeout"


def test_confidence_applies_fallback_truncation_retry_and_conflict():
    evidence = {
        **EVIDENCE,
        "fallback": True,
        "picked": [{**EVIDENCE["picked"][0], "truncated": True}],
    }
    client = SequenceClient(["bad", model_payload(tier="优", values=(0.1, 0.2))])

    result = review_one(evidence, ITEM, "摘要", [], SECTIONS, client, sleep=lambda _: None)

    assert result["confidence_factors"] == ["降级", "截断", "重试", "打架"]
    assert result["confidence"] == 0.397


def test_non_highest_score_cannot_round_into_next_tier():
    client = SequenceClient([model_payload(tier="良", values=(1.0, 1.0))])

    result = review_one(EVIDENCE, ITEM, "摘要", [], SECTIONS, client)

    assert result["score"] == 2.9


def test_missing_section_text_fails_before_model_call():
    client = SequenceClient([model_payload()])

    with pytest.raises(ValueError, match="找不到章节正文"):
        review_one(EVIDENCE, ITEM, "摘要", [], {}, client)
    assert client.messages == []


def test_factor_schema_mismatch_is_retried():
    invalid = json.dumps(
        {"tier": "良", "factor_scores": [], "cite": [0], "reason": "理由"},
        ensure_ascii=False,
    )
    client = SequenceClient([invalid] * 4)

    result = review_one(EVIDENCE, ITEM, "摘要", [], SECTIONS, client, sleep=lambda _: None)

    assert result["status"] == "unrated"
    assert "factor_scores 与配置不一致" in result["last_error"]


def test_review_all_aggregates_results_and_perf():
    scoring_table = {"project": "测试项目", "rules": [], "items": [ITEM]}
    sections = [
        {"bidder": "测试投标人001", "id": "1#1", "text": "正文", "path": []}
    ]

    output = review_all([EVIDENCE], scoring_table, "摘要", sections, MockModelClient())

    assert output["project"] == "测试项目"
    assert output["model"] == "mock"
    assert len(output["review_results"]) == 1
    assert output["perf"]["calls"] == 1


def test_model_output_must_have_non_empty_citation():
    client = SequenceClient([model_payload(cite=[])] * 4)

    result = review_one(EVIDENCE, ITEM, "摘要", [], SECTIONS, client, sleep=lambda _: None)

    assert result["status"] == "unrated"
    assert "cite 必须是非空数组" in result["last_error"]


def test_scoring_config_rejects_negative_weights():
    item = {**ITEM, "factors": [{"name": "错误要素", "weight": -0.1}, {"name": "另一要素", "weight": 1.1}]}

    with pytest.raises(ValueError, match="权重不能为负数"):
        review_one(EVIDENCE, item, "摘要", [], SECTIONS, SequenceClient([]))

"""merge_sections.py 的回归测试 —— 守住 README §4 的复合键前提。

核心不变量：`id` 只在单家范围内唯一，跨投标人引用走 `(bidder, id)` 复合键。
脚本唯一必须守的就是「单家内 id 唯一」，以及不静默覆盖已有的 `bidder`。
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import merge_sections as M  # noqa: E402


def _block(bid, text="正文", bidder=None):
    b = {"id": bid, "file": "1", "item_guid": None, "path": ["第一章"],
         "level": 1, "page": 1, "text": text, "char_len": len(text)}
    if bidder is not None:
        b["bidder"] = bidder
    return b


def _project(tmp_path, bidders):
    """按 data/README.md 的目录约定造一个最小项目。bidders: {id: [块...]}"""
    (tmp_path / "manifest.json").write_text(json.dumps({
        "project": "测试项目", "project_slug": "test-proj",
        "data_schema_version": "1.0",
        "bidders": [{"id": b} for b in bidders],
    }, ensure_ascii=False), encoding="utf-8")
    for bid, blocks in bidders.items():
        d = tmp_path / "sections" / bid
        d.mkdir(parents=True)
        (d / "sections.json").write_text(
            json.dumps(blocks, ensure_ascii=False), encoding="utf-8")
    return tmp_path


# ────────── 正常合并 ──────────

def test_正常合并并注入bidder(tmp_path):
    p = _project(tmp_path, {"甲公司1001": [_block("1#1"), _block("1#2")],
                            "乙公司1002": [_block("1#1")]})
    M.merge_project(str(p))
    out = json.loads((p / "sections_all.json").read_text(encoding="utf-8"))

    assert out["bidders"] == ["甲公司1001", "乙公司1002"]
    assert [s["bidder"] for s in out["sections"]] == ["甲公司1001", "甲公司1001", "乙公司1002"]
    # 两家都有 1#1，跨家 id 本就重复，复合键才唯一
    keys = {(s["bidder"], s["id"]) for s in out["sections"]}
    assert len(keys) == 3


def test_stats计数与实际一致(tmp_path):
    p = _project(tmp_path, {"甲公司1001": [_block("1#1", "一二三"), _block("1#2", "四五")],
                            "乙公司1002": [_block("1#1", "六")]})
    M.merge_project(str(p))
    out = json.loads((p / "sections_all.json").read_text(encoding="utf-8"))

    assert out["stats"]["total_sections"] == 3
    assert out["stats"]["total_chars"] == 6
    assert out["stats"]["by_bidder"]["甲公司1001"] == {"sections": 2, "chars": 5}
    assert out["stats"]["by_bidder"]["乙公司1002"] == {"sections": 1, "chars": 1}
    assert out["stats"]["total_sections"] == len(out["sections"])


# ────────── 产出确定性（issue #5 第 1 条）──────────

def test_重跑零diff(tmp_path):
    """不含时间戳：输入不变，两次产出逐字节相同。"""
    p = _project(tmp_path, {"甲公司1001": [_block("1#1")]})
    M.merge_project(str(p))
    first = (p / "sections_all.json").read_bytes()
    M.merge_project(str(p))
    assert (p / "sections_all.json").read_bytes() == first


def test_产出不含generated_at(tmp_path):
    p = _project(tmp_path, {"甲公司1001": [_block("1#1")]})
    M.merge_project(str(p))
    out = json.loads((p / "sections_all.json").read_text(encoding="utf-8"))
    assert "generated_at" not in out


# ────────── 必须报错的三种输入 ──────────

def test_单家内id重复报错(tmp_path):
    p = _project(tmp_path, {"甲公司1001": [_block("1#1"), _block("1#1")]})
    with pytest.raises(ValueError, match="id 重复"):
        M.merge_project(str(p))


def test_bidder字段冲突报错不静默覆盖(tmp_path):
    p = _project(tmp_path, {"甲公司1001": [_block("1#1", bidder="乙公司1002")]})
    with pytest.raises(ValueError, match="不一致"):
        M.merge_project(str(p))


def test_bidder字段一致时放行(tmp_path):
    p = _project(tmp_path, {"甲公司1001": [_block("1#1", bidder="甲公司1001")]})
    M.merge_project(str(p))
    out = json.loads((p / "sections_all.json").read_text(encoding="utf-8"))
    assert out["sections"][0]["bidder"] == "甲公司1001"


def test_拒绝把sections_all当单家读入(tmp_path):
    """合并产物是对象，再喂进来必须报错，不能当成一家硬吞。"""
    p = _project(tmp_path, {"甲公司1001": [_block("1#1")]})
    d = p / "sections" / "甲公司1001"
    (d / "sections.json").write_text(json.dumps(
        {"project": "x", "bidders": ["甲公司1001"], "sections": [_block("1#1")]},
        ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ValueError, match="sections_all"):
        M.merge_project(str(p))

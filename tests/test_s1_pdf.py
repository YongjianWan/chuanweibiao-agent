"""S1 PDF 切块的回归测试 —— 守住 README §3.7 的切分规则。

切块核心是纯函数 `_chunk_lines`，直接用 (页码, 文本) 行列表喂入，不渲染 PDF、
不依赖中文字体。真实标的冒烟测试位于文件末尾，缺目录时自动跳过。
"""
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import s1_ingest as S  # noqa: E402


def _long_body():
    """一条满行正文，长度超过 0.8×P90，不会被误判为标题。"""
    return "正文" * 20  # 60 字


# ────────── GUID 提取 ──────────

def test_提取GUID并转小写():
    p = Path("进度管理方案108D538F-85B8-4C7D-B32C-F6ACDAA187B9.pdf")
    assert S._pdf_item_guid(p) == "108d538f-85b8-4c7d-b32c-f6acdaa187b9"


def test_无GUID返回None():
    assert S._pdf_item_guid(Path("任意文件.pdf")) is None


# ────────── 编号识别（纯函数，不依赖行长过滤） ──────────

def test_编号层级识别():
    assert S._pdf_heading_level("第一章 施工组织") == 1
    assert S._pdf_heading_level("一、工程概况") == 2
    assert S._pdf_heading_level("1、编制说明") == 3
    assert S._pdf_heading_level("2.6.1、国家规范、标准") == 4
    assert S._pdf_heading_level("（1）给水系统工艺流程") == 5
    assert S._pdf_heading_level("（一）总体要求") == 5


# ────────── 切块结构 ──────────

def test_五级编号构造路径():
    lines = [
        (1, "第一章 施工组织"), (1, _long_body()),
        (1, "一、工程概况"), (1, _long_body()),
        (1, "1、编制说明"), (1, _long_body()),
        (1, "2.6.1、国家规范、标准"), (1, _long_body()),
        (1, "（1）给水系统工艺流程"), (1, _long_body()),
    ]
    blocks = S._chunk_lines(lines, "1")
    paths = [(b["level"], b["path"]) for b in blocks]
    assert paths == [
        (1, ["第一章 施工组织"]),
        (2, ["第一章 施工组织", "一、工程概况"]),
        (3, ["第一章 施工组织", "一、工程概况", "1、编制说明"]),
        (4, ["第一章 施工组织", "一、工程概况", "1、编制说明", "2.6.1、国家规范、标准"]),
        (5, ["第一章 施工组织", "一、工程概况", "1、编制说明",
             "2.6.1、国家规范、标准", "（1）给水系统工艺流程"]),
    ]


def test_正文伪编号因行长过长被过滤():
    """编号开头的满行正文不应被判标题，应并入前一块。"""
    lines = [
        (1, "第一章 施工"), (1, _long_body()),
        (1, "1.1、采用分段流水施工作业" + "正文" * 30),  # 满行，伪编号
        (1, _long_body()),
    ]
    blocks = S._chunk_lines(lines, "1")
    assert [b["path"] for b in blocks] == [["第一章 施工"]]


def test_无标题前言归入_前言():
    lines = [(1, "第一段"), (1, _long_body()), (1, _long_body())]
    blocks = S._chunk_lines(lines, "1")
    assert len(blocks) == 1
    assert blocks[0]["path"] == ["(前言)"]
    assert blocks[0]["level"] == 0
    assert blocks[0]["page"] == 1
    assert blocks[0]["char_len"] == len(blocks[0]["text"])


def test_跨页标题页码取起始页():
    lines = [
        (1, "第一章 施工组织"), (1, _long_body()),
        (1, _long_body()), (2, _long_body()), (2, _long_body()),
    ]
    blocks = S._chunk_lines(lines, "1")
    assert blocks[0]["page"] == 1
    assert blocks[0]["text"].splitlines()[-1] == _long_body()


def test_空标题块被丢弃():
    """连续两个标题，中间无正文，前一个标题不产生空块。"""
    lines = [
        (1, "第一章 施工组织"), (1, "一、工程概况"),
        (1, _long_body()),
    ]
    blocks = S._chunk_lines(lines, "1")
    assert [b["path"] for b in blocks] == [["第一章 施工组织", "一、工程概况"]]


def test_字段齐全且ID唯一():
    lines = [(1, "第一章 施工"), (1, _long_body()), (1, "一、工程概况"), (1, _long_body())]
    blocks = S._chunk_lines(lines, "3", item_guid="abc-123", file_name="施工方案.pdf")
    ids = [b["id"] for b in blocks]
    assert len(ids) == len(set(ids))
    for b in blocks:
        assert set(b) == {"id", "file", "item_guid", "path", "level", "page", "text", "char_len"}
        assert b["file"] == "施工方案.pdf"
        assert b["item_guid"] == "abc-123"
        assert b["page"] >= 1
        assert b["char_len"] == len(b["text"])


# ────────── P90 自适应阈值 ──────────

def test_阈值随文档行长自适应():
    """同一标题行，在行长不同的文档里可能被判为标题或正文。"""
    short = [(1, "1、标题"), (1, _long_body())]
    assert S._chunk_lines(short, "1")[0]["level"] == 3

    # 文档里全是短行时，P90 很小，短标题也可能超过 0.8×P90 而被判正文
    narrow = [(1, "1、标题"), (1, "短" * 3), (1, "短" * 3)]
    blocks = S._chunk_lines(narrow, "1")
    assert blocks[0]["level"] == 0


# ────────── 真实数据冒烟 ──────────

REAL_BIDDER_ROOT = Path(
    r"D:/Decktop/测试项目/济阳区实验高级中学项目工程总承包（EPC） 2"
)


@pytest.mark.skipif(not REAL_BIDDER_ROOT.exists(), reason="真实资料不在本机")
def test_一家20个PDF字段齐全且ID唯一():
    bidders = [d for d in REAL_BIDDER_ROOT.iterdir() if d.is_dir()]
    assert len(bidders) == 12, f"投标人应 12 家，实际 {len(bidders)}"
    bidder = bidders[0]
    pdfs = sorted(bidder.rglob("*.pdf"))
    assert len(pdfs) == 20
    all_blocks = []
    for i, p in enumerate(pdfs, start=1):
        blocks = S.parse_pdf(p, str(i))
        all_blocks.extend(blocks)
        for b in blocks:
            assert b["page"] >= 1 and isinstance(b["page"], int)
            if "封面" not in p.name:
                assert re.match(
                    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-"
                    r"[0-9a-f]{4}-[0-9a-f]{12}$", b["item_guid"])
            assert b["level"] in (0, 1, 2, 3, 4, 5)
            assert b["char_len"] == len(b["text"])
    ids = [b["id"] for b in all_blocks]
    assert len(ids) == len(set(ids)), "id 必须全局唯一"


@pytest.mark.skipif(not REAL_BIDDER_ROOT.exists(), reason="真实资料不在本机")
def test_全量240个PDF不报错且字段齐全():
    pdfs = sorted(
        p for p in REAL_BIDDER_ROOT.rglob("*.pdf")
        if "招标文件" not in p.name and not p.name.startswith("~$")
    )
    assert len(pdfs) == 240, f"应 240 个投标 PDF，实际 {len(pdfs)}"
    for i, p in enumerate(pdfs, start=1):
        blocks = S.parse_pdf(p, str(i))
        assert blocks, f"{p.name} 切出 0 块"
        for b in blocks:
            assert b["char_len"] == len(b["text"])
            assert b["level"] in (0, 1, 2, 3, 4, 5)


# ────────── 稳定性 ──────────

def test_重复运行结果一致():
    lines = [
        (1, "第一章 施工组织"), (1, "一、工程概况"),
        (1, _long_body()), (2, _long_body()), (2, _long_body()),
    ]
    assert S._chunk_lines(lines, "1") == S._chunk_lines(lines, "1")

"""T8 的单元测试：S2 适配多投标人 + 单文件检索。

守住三条红线在新接口（locate_item / ScoringItem）下仍然成立，并验证：
- 检索范围收窄到评分项 GUID 对应的单个 PDF
- DF/IDF 统计基仍取该投标人全部章节块（不是单个 PDF，红线一）
- 锚点 DF=0 直接判未命中（红线二第二半）
- budget 按分值分配（data-contract.md §5 公式）
- 输出字段齐全（bidder / item_id / item_guid / page）
- 降级：aspects 检索不到退到评分项名级
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import s2_locate as S


def item(item_id="T-01", guid="aaa", name="进度管理方案", max_score=4.0,
         aspects=None, synonyms=None):
    return S.ScoringItem(
        item_id=item_id, guid=guid, name=name, max_score=max_score,
        tiers=[], aspects=aspects or [], synonyms=synonyms or [])


def sec(sid, file, guid, path, text):
    return {"id": sid, "file": file, "item_guid": guid, "path": path,
            "level": len(path), "page": 1, "text": text, "char_len": len(text)}


def 普通语料(n, prefix="2", guid="bbb", file="其他BBB.pdf"):
    """n 块不含领域词的普通章节，用来垫高语料量、压低领域词 DF 占比。"""
    return [sec(f"{prefix}#{i}", file, guid, ["其他章"],
                f"普通施工内容第{i}段，本方案措施完整。")
            for i in range(1, n + 1)]


# ── budget 按分值分配 ───────────────────────────────────────────────────

def test_budget按分值分配():
    # 基准 4500 / 上限 9000（2026-08-20 由 T9 实测标定，见 docs/data-contract.md §5）
    assert S.calc_budget(20.0) == 9000   # 17100 触上限
    assert S.calc_budget(8.0) == 6840    # 4500*19*8/100
    assert S.calc_budget(4.0) == 3420    # 4500*19*4/100
    assert S.calc_budget(3.0) == 2565    # 4500*19*3/100
    assert S.calc_budget(2.0) == 1710    # 4500*19*2/100，不再触下限
    assert S.calc_budget(100.0) == 9000  # 超上限钳到 9000


def test_budget的上限必须高于次高分值项的原始值():
    """防回归：基准调大而上限不动时，8 分项与 20 分项会一起顶到上限，

    「按分值分配」静默失效——20 分项判错一档的代价是 3 分项的 6 倍多，
    却拿到和 8 分项相同的证据量。见 docs/data-contract.md §5。
    """
    assert S.calc_budget(20.0) > S.calc_budget(8.0) > S.calc_budget(4.0)


# ── 检索范围收窄到单 PDF ─────────────────────────────────────────────────

def test_检索只在匹配GUID的单个PDF内():
    sections = [
        sec("1#1", "进度管理方案AAA.pdf", "aaa", ["第1章 总体"],
            "本工程深基坑开挖采用分层分段方式。"),
        sec("2#1", "施工方案BBB.pdf", "bbb", ["第1章 总体"],
            "深基坑开挖支护采用钢板桩。"),
    ] + 普通语料(40)
    it = item(guid="aaa", name="深基坑工程", aspects=["深基坑开挖"])
    pkg = S.locate_item(sections, it)
    assert pkg.picked, "匹配 GUID 的 PDF 里有深基坑，应命中"
    assert all(p["file"].endswith("AAA.pdf") for p in pkg.picked), \
        "证据只能来自匹配 GUID 的那一个 PDF"
    # 匹配 GUID 的 PDF 只有 1 块含「深基坑」，其余 40 块是别的 guid -> candidates=1
    assert pkg.candidates == 1, f"candidates 应为候选块数，实际 {pkg.candidates}"
    assert pkg.bidder == ""  # 章节块未带 bidder 时，显式值由 locate_project/locate_bidder 注入


# ── DF 统计基取全部章节块（红线一）──────────────────────────────────────

def test_DF统计基取全部PDF不是单个PDF():
    """收窄检索范围后，DF 仍算在整份标书（全部 PDF）上。

    构造：目标 PDF 50 块全含「深基坑」，另 950 块不含。全语料 1000 块时
    「深基坑」DF=50（占比 5%），恰好 ≤ ANCHOR_DF_RATIO，是合格锚点。
    若错误地只在单 PDF（50 块）上算，DF=50 占比 100%，会被当通用词丢弃、锚点失效。
    """
    target = [
        sec(f"1#{i}", "目标AAA.pdf", "aaa", ["基坑章"],
            f"深基坑开挖第{i}段采用分层分段方式。")
        for i in range(1, 51)
    ]
    sections = target + 普通语料(950, prefix="2", guid="bbb", file="其他BBB.pdf")
    it = item(guid="aaa", name="深基坑工程", aspects=["深基坑开挖"])
    pkg = S.locate_item(sections, it)
    assert pkg.picked, "「深基坑」在全语料罕见（50/1000），应作为锚点命中目标 PDF"
    assert all(p["file"].endswith("AAA.pdf") for p in pkg.picked)


# ── 锚点 DF=0 直接未命中（红线二第二半）──────────────────────────────────

def test_锚点DF0直接未命中():
    """锚点概念在整份标书里不存在 -> 直接未命中，不换词、不退到弱词。"""
    sections = [
        sec("1#1", "进度管理方案AAA.pdf", "aaa", ["第1章"], "本工程采用常规施工。"),
    ] + 普通语料(30)
    it = item(guid="aaa", name="盾构法专项", aspects=["盾构法专项施工"])
    pkg = S.locate_item(sections, it)
    assert not pkg.picked, "锚点词「盾构法」DF=0，应判未命中，不能换词继续找"


def test_跨换行锚点不误判为DF0():
    """回归 2026-08-20 修复：S1 抽出的 PDF text 保留视觉折行（\\n），
    跨换行的词会被误判为「锚点 DF=0 → 直接未命中」，导致全文件失配。

    修复：匹配时对 text 做 replace("\\n", "")（text 字段本身保留供证据引用）。

    构造：锚点词「路径」被折行拆成「路\\n径」。修复前该词 DF=0 → 该项直接未命中；
    修复后 DF=1 且完整短语「关键路径分析」命中。
    """
    sections = [
        sec("1#1", "进度管理方案AAA.pdf", "aaa", ["第1章"],
            "本工程采用关键路\n径分析安排工期，施工进度计划编制细致。"),
    ] + 普通语料(30)
    it = item(guid="aaa", name="进度管理方案", aspects=["关键路径分析"])
    pkg = S.locate_item(sections, it)
    # 修复前：这一项必然全文件失配（锚点 DF=0 直接判未命中）
    # 修复后：去换行副本能匹配 -> 检索到证据
    assert pkg.picked, "跨换行的完整短语应能命中（匹配时去换行）"
    assert all(p["file"].endswith("AAA.pdf") for p in pkg.picked), \
        "证据只能来自匹配 GUID 的那一个 PDF"
    raw = next(s for s in sections if s["id"] == pkg.picked[0]["section_id"])["text"]
    assert "关键路径分析" not in raw, "原始 text 上短语确实被折行打断，匹配必须去换行"
    assert "关键路径分析" in raw.replace("\r", "").replace("\n", ""), \
        "去换行副本上应能命中，且匹配同时处理 \\r 与 \\n"


# ── 输出字段齐全 ────────────────────────────────────────────────────────

def test_输出字段齐全():
    sections = [
        sec("1#1", "进度管理方案AAA.pdf", "aaa", ["第1章 进度", "1.1 计划编制"],
            "施工进度计划编制采用关键路径分析，深基坑开挖分层分段。"),
    ] + 普通语料(40)
    it = item(guid="aaa", name="进度管理方案", max_score=4.0,
              aspects=["深基坑开挖"])
    pkg = S.locate_item(sections, it, bidder="某投标人")
    d = pkg.as_dict()
    for field in ("item_id", "item_guid", "bidder", "name", "candidates",
                  "units", "fallback", "evidence_chars", "budget", "picked"):
        assert field in d, f"证据包缺字段 {field}"
    # bidder 应被显式传入的值覆盖（直调路径）
    assert d["bidder"] == "某投标人", "直调 locate_item 时 bidder 应取显式传入值"
    # candidates 是「候选章节块总数」而非「单元数」（data-contract.md §5）
    assert d["candidates"] >= 1, "candidates 应为通过门槛的块数"
    if pkg.picked:
        for p in pkg.picked:
            assert "page" in p, "picked 缺 page 字段"
            assert "section_id" in p
            assert "match_score" in p and "score" not in p


def test_docx路径page为null():
    """docx 章节块 page 为 null（data-contract.md §1），S2 应透传 null 不报错。"""
    s = sec("1#1", "技术方案.docx", "aaa", ["第1章"], "本工程深基坑开挖采用分层分段。")
    s["page"] = None
    it = item(guid="aaa", name="进度管理方案", aspects=["深基坑开挖"])
    pkg = S.locate_item([s], it, bidder="某投标人")
    if pkg.picked:
        assert pkg.picked[0]["page"] is None, "docx 路径 page 应透传 null"


# ── 降级：aspects 检索不到退到评分项名 ───────────────────────────────────

def test_降级退到评分项名():
    """aspects 词在目标 PDF 里没出现（但在语料里存在，锚点 DF>0），
    退到评分项名级命中 -> fallback=True。"""
    sections = [
        # 目标 PDF：写了「进度管理方案」，但没写 aspects 的「深基坑」
        sec("1#1", "进度管理方案AAA.pdf", "aaa", ["第1章"],
            "本工程进度管理方案总体安排如下，分三个阶段实施。"),
        # 别的 PDF 有一块含「深基坑」，让锚点 DF=1 > 0，不触发 DF=0 直接未命中
        sec("2#1", "施工方案BBB.pdf", "bbb", ["第1章"],
            "深基坑开挖专项方案。" ),
    ] + 普通语料(20)
    it = item(guid="aaa", name="进度管理方案", aspects=["深基坑"])
    pkg = S.locate_item(sections, it)
    assert pkg.picked and pkg.fallback, "应退到评分项名级命中并标 fallback"

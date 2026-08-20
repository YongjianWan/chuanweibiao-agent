"""S2 检索的回归测试 —— 守住 README §3.2 的三条设计红线。

这三条红线是踩过坑得出的结论，很容易被"简化"回去。每条红线对应一组断言，
改坏了这里就会红。测试用合成语料，不依赖 140 万字的真实标书，跑一次不到一秒。

真实标书上的冒烟测试放在最后，文件不存在时自动跳过。
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import s2_locate as S


def sec(sid, path, text):
    return {"id": sid, "file": "T", "path": path, "level": len(path),
            "text": text, "char_len": len(text)}


@pytest.fixture
def corpus():
    """合成语料：通用词遍地都是，领域特征词各只出现一次。

    这正是真实标书的样子 —— 「方案」「措施」在每一章都有，「深基坑」只在讲深基坑时才有。
    """
    common = "本方案措施完整性好，技术可行性高，内容成熟可靠，风险可控。"
    out = [sec(f"T#{i}", ["技术部分", f"第{i}章 通用"], common) for i in range(1, 21)]
    out.append(sec("T#21", ["技术部分", "第21章 基坑", "21.1 深基坑开挖"],
                   "深基坑开挖采用分层分段方式，" + common))
    out.append(sec("T#22", ["技术部分", "第21章 基坑", "21.2 支护结构"],
                   "支护结构采用钢板桩，" + common))
    out.append(sec("T#23", ["技术部分", "第21章 基坑", "21.3 降水方案"],
                   "降水采用轻型井点，" + common))
    return out


@pytest.fixture
def cats():
    return [{
        "mark": "①", "name": "施工方案", "phrases": ["施工方案"], "terms": ["施工方案"],
        "points": [
            {"id": "①-1", "name": "深基坑工程方案完整性、技术可行性",
             "phrases": ["深基坑工程方案完整性", "技术可行性"],
             "terms": ["深基坑", "完整性", "可行性", "方案"]},
            {"id": "①-2", "name": "冬雨季施工措施",
             "phrases": ["冬雨季施工措施"], "terms": ["冬雨季", "施工", "措施"]},
        ],
    }]


# ── 红线一：词权重必须用 IDF ────────────────────────────────────────────

def test_按DF占比压低通用词_拉高领域词(corpus, cats):
    vocab = {"深基坑", "完整性", "可行性", "方案", "冬雨季"}
    idf, df = S.build_idf(corpus, vocab)
    n = len(corpus)

    # 「方案」在每一章都出现 -> 占比超门槛，打分时被丢弃
    assert df["方案"] == n
    assert df["方案"] > n * S.MAX_DF_RATIO
    # 「深基坑」只在一章出现 -> 占比远低于门槛，且 IDF 更高
    assert df["深基坑"] <= n * S.ANCHOR_DF_RATIO
    assert idf["深基坑"] > idf["可行性"]


def test_阈值不随语料规模漂移(cats):
    """同一个词在小语料和大语料里 IDF 绝对值差一倍，但 DF 占比不变。
    阈值若用 IDF 绝对值，换一批标书就得重调 —— 这正是改用占比的原因。"""
    def 造语料(n):
        out = [sec(f"T#{i}", ["技", f"第{i}章"], "本方案措施完整。") for i in range(n)]
        out.append(sec("X", ["技", "基坑章"], "深基坑开挖。"))
        return out

    小, 大 = 造语料(20), 造语料(400)
    for 语料 in (小, 大):
        idf, df = S.build_idf(语料, {"深基坑", "方案"})
        n = len(语料)
        assert df["深基坑"] <= n * S.ANCHOR_DF_RATIO      # 两种规模下都算领域词
        assert df["方案"] > n * S.MAX_DF_RATIO            # 两种规模下都算通用词


def test_通用词不足以让无关章节命中(corpus, cats):
    """反例复现：若改用词频或覆盖率，满篇通用词的第 1 章会匹配上「深基坑」。"""
    res, idf, _ = S.locate(corpus, cats)
    r = next(x for x in res if x["point_id"] == "①-1")
    命中的章节 = {p["section_id"] for p in r["picked"]}
    无关章节 = {f"T#{i}" for i in range(1, 21)}
    assert not (命中的章节 & 无关章节), "只含通用词的章节不该成为深基坑的证据"


# ── 红线二：锚点词只取 IDF 最高的一个，且必须命中 ──────────────────────

def test_锚点是最罕见但确实出现过的词(corpus, cats):
    vocab = {"深基坑", "完整性", "可行性", "方案"}
    _, df = S.build_idf(corpus, vocab)
    assert S.anchor(["深基坑", "完整性", "可行性", "方案"], df, len(corpus)) == "深基坑"


def test_锚点DF为零时该项直接未命中(corpus):
    """DF=0 意味着这个概念在本文件里根本不存在，是「该项未写」的最强信号。

    回归的是一次错误修复：曾因为担心同义词问题（评审点写「四新技术」、标书写
    「新技术、新工艺」）而把 DF=0 的词排除出锚点候选，结果锚点退到了一个通用词，
    放行了大量无关章节。同义词该在映射配置里补，不该让检索靠换词去猜。
    """
    vocab = {"深基坑", "盾构法"}          # 「盾构法」在语料中完全不存在
    idf, df = S.build_idf(corpus, vocab)
    assert df["盾构法"] == 0
    assert idf["盾构法"] > idf["深基坑"], "DF=0 的词 IDF 最高，正是它会被选为锚点"
    assert S.anchor(["盾构法", "深基坑"], df, len(corpus)) == "盾构法"

    # 且该评审点必须落空，而不是退到「深基坑」继续找
    cats = [{"mark": "①", "name": "X", "phrases": ["X"], "terms": ["X"],
             "points": [{"id": "①-9", "name": "盾构法专项",
                         "phrases": ["盾构法专项"], "terms": ["盾构法", "深基坑"]}]}]
    res, _, _ = S.locate(corpus, cats)
    assert res[0]["picked"] == [], "锚点概念不存在时不该换词继续找"


def test_锚点未命中的章节直接出局(corpus, cats):
    """「可行性」这类次高 IDF 词命中不算数 —— 否则闸门形同虚设。"""
    res, _, _ = S.locate(corpus, cats)
    r = next(x for x in res if x["point_id"] == "①-1")
    for p in r["picked"]:
        块 = next(s for s in corpus if s["id"] == p["section_id"])
        assert "深基坑" in 块["text"] + " ".join(块["path"]) or p["unit"], \
            "进入证据的章节必须来自命中锚点的那个单元"
    assert r["candidates"] >= 1


def test_名称全是通用词时不设闸(corpus):
    """没有高 IDF 词的评审点没有锚点，此时不该把所有章节都挡掉。"""
    vocab = {"方案", "措施"}
    _, df = S.build_idf(corpus, vocab)
    assert S.anchor(["方案", "措施"], df, len(corpus)) is None


# ── 红线三：必须允许未命中 ─────────────────────────────────────────────

def test_语料里没有的主题应当未命中(corpus, cats):
    """①-2「冬雨季施工措施」在语料中完全不存在 -> 零证据，交给 S3 判 0 分。"""
    res, _, _ = S.locate(corpus, cats)
    r = next(x for x in res if x["point_id"] == "①-2")
    assert r["picked"] == [], "投标文件没写的内容不能硬凑证据"
    assert r["evidence_chars"] == 0


def test_未命中由两道独立防线保证(corpus, monkeypatch):
    """红线三有两道防线，缺一不可，这里分别确认它们真的在起作用。

    防线一 = 锚点 DF 为 0（该概念不存在），已由上面的测试覆盖。
    防线二 = MIN_SCORE 分数门槛，挡住「词都出现过但整体不相关」的情况。
    """
    # 所有词都是遍地都是的通用词：过不了 MAX_DF_RATIO，得分为 0
    弱点 = [{"mark": "②", "name": "Y", "phrases": ["Y"], "terms": ["Y"],
             "points": [{"id": "②-1", "name": "可靠可控",
                         "phrases": ["可靠可控"], "terms": ["可靠", "可控"]}]}]

    res, _, _ = S.locate(corpus, 弱点)
    assert res[0]["picked"] == [], "通用词凑不出分数，应被 MIN_SCORE 挡住"

    monkeypatch.setattr(S, "MIN_SCORE", 0.0)
    res, _, _ = S.locate(corpus, 弱点)
    assert res[0]["picked"], "门槛归零后应放行 —— 确认挡住它的确实是 MIN_SCORE"


def test_跨换行匹配():
    """回归 2026-08-20 修复：S1 从 PDF 抽出的 text 保留了视觉折行（\\n），
    跨过换行的短语在原始 text 上匹配不到（\"\\n\" in blob 为 False），
    但在去换行副本上能命中，且原始 text 本身不变。

    这个问题会在 T8 接真实评分表时爆发：
    要素名长度 9~15 字，这个区间的打断率是 27%~40%。
    """
    # 短语「施工工艺落地」被折行打断
    folded = sec("F1", ["技术部分", "施工工艺", "落地措施"],
                 "施工方案中明确了施工工艺\n落地效果以及项目整体履约水平。")
    flat_text = folded["text"].replace("\r", "").replace("\n", "")
    assert "施工工艺落地" not in folded["text"], "原始 text 上应匹配不到"
    assert "施工工艺落地" in flat_text, "去换行副本上应能命中"

    # 用完整语料验证 locate 能在含折行的块上检索到
    corpus = [folded] + [sec(f"F{i}", ["技术部分", f"第{i}章 通用"],
                             "本方案措施完整性好，技术可行性高，内容成熟可靠。")
                         for i in range(2, 22)]
    cats = [{"mark": "①", "name": "施工工艺", "phrases": ["施工工艺"], "terms": ["施工工艺"],
             "points": [{"id": "①-F1", "name": "施工工艺落地",
                         "phrases": ["施工工艺落地"],
                         "terms": ["施工工艺", "落地"]}]}]
    res, _, _ = S.locate(corpus, cats)
    r = res[0]
    assert r["picked"], "跨换行的短语应命中"
    assert r["picked"][0]["section_id"] == "F1"


def test_CRLF正则折行匹配():
    """回归：匹配副本需同时去除 \\r\\n 与 \\n，否则 \"关键\\r\\n路径\" → \"关键\\r路径\"，
    仍会导致 DF=0 与锚点误判。"""
    folded = sec("F2", ["技术部分", "进度管理", "关键路径"],
                 "本工程工期紧\n关键路径分析至关重要。")
    # CRLF 变体
    folded_crlf = dict(folded)
    folded_crlf["text"] = folded["text"].replace("\n", "\r\n")
    flat_crlf = folded_crlf["text"].replace("\r", "").replace("\n", "")
    assert "关键路径分析" in flat_crlf, "CRLF 去除后应命中"
    corpus = [folded_crlf] + [sec(f"F{i}", ["技术部分", f"第{i}章 通用"],
                                  "本方案措施完整性好。") for i in range(2, 22)]
    cats = [{"mark": "①", "name": "进度管理", "phrases": ["关键路径"], "terms": ["关键路径"],
             "points": [{"id": "①-F2", "name": "关键路径分析",
                         "phrases": ["关键路径分析"],
                         "terms": ["关键路径", "分析"]}]}]
    res, _, _ = S.locate(corpus, cats)
    assert res[0]["picked"], "CRLF 文本应被正确匹配"
    assert res[0]["picked"][0]["section_id"] == "F2"


# ── 证据按父章节聚合 ──────────────────────────────────────────────────

def test_证据按父章节整段收取(corpus, cats):
    """命中 21.1 时应连带收下同属「第21章 基坑」的 21.2、21.3，而不是只收命中那一块。"""
    res, _, _ = S.locate(corpus, cats)
    r = next(x for x in res if x["point_id"] == "①-1")
    收到的 = {p["section_id"] for p in r["picked"]}
    assert {"T#21", "T#22", "T#23"} <= 收到的, "父章节内的兄弟块应一起收，保证上下文连贯"


def test_单元键取直接父章节而非固定层级(corpus):
    a = S.unit_key(corpus[-1])   # 21.3 降水方案
    b = S.unit_key(corpus[-2])   # 21.2 支护结构
    assert a == b == ("T", ("技术部分", "第21章 基坑"))


def test_证据字数不超过budget(corpus, cats):
    res, _, _ = S.locate(corpus, cats)
    for r in res:
        assert r["evidence_chars"] <= S.BUDGET


# ── 真实标书冒烟测试（缺文件则跳过）────────────────────────────────────

REAL = Path(__file__).resolve().parents[1] / "data/projects/_sample-docx/evidence/sample-docx/located.json"


@pytest.mark.skipif(not REAL.exists(), reason="需先按 README §10 跑完前三条命令")
def test_真实标书上的已知结果():
    res = json.loads(REAL.read_text(encoding="utf-8"))
    assert len(res) == 114, "评审点总数变了，先确认 README §9.1/§9.2 是否已澄清"

    # 手头样例是软件信息化标，这一项确实没写 -> 必须未命中
    r = next(x for x in res if x["point_id"] == "①-2")
    assert r["picked"] == []

    # 每项证据不超 budget，且字段名与 README §4 数据契约一致
    for x in res:
        assert x["evidence_chars"] <= 3000
        for p in x["picked"]:
            assert "match_score" in p and "score" not in p, "检索分字段名须为 match_score"

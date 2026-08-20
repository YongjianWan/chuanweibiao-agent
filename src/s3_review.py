"""S3：把 S2 证据包转换为模型辅助评审结果。

模型负责对照招标文件档位描述判定档位、在档位区间内给出分数、并选择证据编号；
置信度、重试与引用校验全部由程序确定性处理。模型调用被隔离在小型客户端接口后面，
因此真实端点未提供时也能先用 ``MockModelClient`` 跑通和测试整个评审流程。
"""

from __future__ import annotations

import argparse
import json
import os
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol, Sequence

import yaml


# 首次调用失败后最多重试 3 次，分别等待 2/4/8 秒，避免瞬时故障造成集中重试。
BACKOFF_SECONDS = (2.0, 4.0, 8.0)
DEFAULT_MAX_ATTEMPTS = len(BACKOFF_SECONDS) + 1
# 防止异常端点返回超大内容耗尽进程内存；正常评审 JSON 远小于此值。
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
# 检索池非空却没检索到证据时的置信度。取值依据见 docs/data-contract.md 第 6 节
# confidence 表：它必须低于「有证据」的最差组合 0.567，因为无证据比弱证据更不可信。
NOT_FOUND_CONFIDENCE = 0.5


class ReviewError(ValueError):
    """模型返回内容不满足评审结果契约。"""


@dataclass(frozen=True)
class ModelResponse:
    content: str
    in_tokens: int = 0
    out_tokens: int = 0
    latency_ms: int = 0


class ModelClient(Protocol):
    """模型客户端统一接口，S3 逻辑不关心底层使用 Mock 还是真实 HTTP 端点。"""

    name: str

    def complete(self, messages: Sequence[Mapping[str, str]]) -> ModelResponse:
        """完成一次对话调用并返回正文、token 和耗时。"""


class MockModelClient:
    """真实端点未提供时使用的确定性本地模型，仅用于开发和自动测试。"""

    name = "mock"

    def complete(self, messages: Sequence[Mapping[str, str]]) -> ModelResponse:
        # Mock 仍读取真实 Prompt 结构，避免测试绕开 build_messages() 这条正式路径。
        request = json.loads(messages[-1]["content"])
        tiers = request["scoring_item"]["tiers"]
        picked = request["evidence"]
        tier_index = len(tiers) // 2
        tier = tiers[tier_index]
        # score 落在该档位区间内，取中点；最高档为闭区间，其余左闭右开。
        score = (float(tier["min"]) + float(tier["max"])) / 2
        if tier_index > 0 and score >= float(tier["max"]):
            score = float(tier["max"]) - 0.05
        payload = {
            "tier": tier["tier"],
            "score": round(score, 1),
            "cite": [0] if picked else [],
            "reason": "Mock 评审结果：证据覆盖主要要求，真实结论需接入模型端点后生成。",
        }
        content = json.dumps(payload, ensure_ascii=False)
        return ModelResponse(
            content=content,
            in_tokens=max(1, len(messages[-1]["content"]) // 2),
            out_tokens=max(1, len(content) // 2),
            latency_ms=0,
        )


class OpenAICompatibleClient:
    """最小化的 OpenAI Chat Completions 兼容客户端，不额外引入 SDK 依赖。"""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        timeout: float = 60.0,
    ) -> None:
        if not base_url or not api_key or not model:
            raise ValueError("base_url、api_key 和 model 均不能为空")
        base = base_url.rstrip("/")
        self.endpoint = (
            base if base.endswith("/chat/completions") else f"{base}/chat/completions"
        )
        self.api_key = api_key
        self.model = model
        self.timeout = timeout
        self.name = model

    @classmethod
    def from_env(cls, timeout: float = 60.0) -> "OpenAICompatibleClient":
        # 密钥只从环境变量读取，禁止写入源码或输出文件。
        missing = [
            key
            for key in ("MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_NAME")
            if not os.environ.get(key)
        ]
        if missing:
            raise ValueError(f"缺少模型环境变量：{', '.join(missing)}")
        return cls(
            os.environ["MODEL_BASE_URL"],
            os.environ["MODEL_API_KEY"],
            os.environ["MODEL_NAME"],
            timeout=timeout,
        )

    def complete(self, messages: Sequence[Mapping[str, str]]) -> ModelResponse:
        # temperature=0 降低同一证据重复评审时的随机波动；JSON mode 约束返回格式。
        body = json.dumps(
            {
                "model": self.model,
                "messages": list(messages),
                "temperature": 0,
                "response_format": {"type": "json_object"},
            },
            ensure_ascii=False,
        ).encode("utf-8")
        request = urllib.request.Request(
            self.endpoint,
            data=body,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                # 多读取 1 字节，用于判断响应是否确实超过上限。
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise RuntimeError("模型端点响应超过 2 MiB 上限")
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise RuntimeError("模型端点响应不是有效的 UTF-8 JSON") from exc
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise RuntimeError(f"模型端点 HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise RuntimeError(f"模型端点连接失败：{exc}") from exc

        latency_ms = round((time.perf_counter() - started) * 1000)
        try:
            content = payload["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise RuntimeError("模型端点响应缺少 choices[0].message.content") from exc
        if not isinstance(content, str):
            raise RuntimeError("模型端点 message.content 必须是字符串")
        usage = payload.get("usage") or {}
        return ModelResponse(
            content=content,
            in_tokens=_non_negative_int(usage.get("prompt_tokens", 0), "prompt_tokens"),
            out_tokens=_non_negative_int(
                usage.get("completion_tokens", 0), "completion_tokens"
            ),
            latency_ms=latency_ms,
        )


class AgentFactoryClient:
    """智能体工厂（`/api/agents/test/{agent}/chat`）客户端。

    该端点与 OpenAI Chat Completions 有四处硬差异，逐条对应本类的处理：

    1. **没有 system role**，请求体只有一个 ``message`` 字符串 —— 把 system 与 user
       拼成一条发送。
    2. **不传 ``thread_id`` 并非每次独立**（平台文档写的是「不传每次独立」，2026-08-20
       实测为错）：前一次调用种下的内容会被后一次读到。228 次评审若共用上下文，
       各家标书会互相污染，撞 README §0「只做每家独立打分」。因此**每次调用都传一个
       本进程内唯一的 ``thread_id``**，重跑换新 ``run_id``，不复用历史会话。
    3. **响应没有 token 计数**（``usage`` 恒为 null），故 in/out token 由字符数估算，
       估算口径见 ``_estimate_tokens``，报告中必须注明是估算值而非端点返回值。
    4. **必须绕过 HTTP 代理**：端点是内网地址，而 ``urllib`` 默认读 ``HTTP_PROXY``
       环境变量，走代理会直接超时且报不出原因（实测排查成本极高）。

    另有一处不可控：该端点不接受 ``temperature``，同一输入多次调用分数会有小幅波动
    （实测同一证据包三次判分 3.6 / 3.7，档位一致）。档位内差异按 README §1 的 P0
    口径可接受，但报告里不要声称结果逐位可复现。
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        agent_id: str,
        timeout: float = 300.0,
        run_id: str = "",
    ) -> None:
        if not base_url or not api_key or not agent_id:
            raise ValueError("base_url、api_key 和 agent_id 均不能为空")
        self.endpoint = f"{base_url.rstrip('/')}/api/agents/test/{agent_id}/chat"
        self.api_key = api_key
        self.agent_id = agent_id
        self.timeout = timeout
        self.name = agent_id
        # run_id 隔离不同批次：重跑时换一个，避免读到上一批的会话内容。
        self.run_id = run_id or f"s3-{int(time.time())}"
        self._seq = 0
        self._seq_lock = threading.Lock()
        # 显式空代理：内网端点不能走 HTTP_PROXY，否则超时。
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @classmethod
    def from_env(cls, timeout: float = 300.0) -> "AgentFactoryClient":
        missing = [
            key
            for key in ("AF_BASE_URL", "AF_API_KEY", "AF_AGENT_ID")
            if not os.environ.get(key)
        ]
        if missing:
            raise ValueError(f"缺少智能体工厂环境变量：{', '.join(missing)}")
        return cls(
            os.environ["AF_BASE_URL"],
            os.environ["AF_API_KEY"],
            os.environ["AF_AGENT_ID"],
            timeout=timeout,
        )

    def _next_thread_id(self) -> str:
        with self._seq_lock:
            self._seq += 1
            return f"{self.run_id}-{self._seq:04d}"

    @staticmethod
    def _estimate_tokens(text: str) -> int:
        """端点不返回 usage，按中文约 1.5 字/token 估算，宁可高估不低估。

        这是估算不是实测，交付报告里必须标注来源，不得与端点返回的真实计数混列。
        """
        return max(1, round(len(text) / 1.5))

    def complete(self, messages: Sequence[Mapping[str, str]]) -> ModelResponse:
        merged = "\n\n".join(message["content"] for message in messages)
        body = json.dumps(
            {
                "message": merged,
                "thread_id": self._next_thread_id(),
                "stream": False,
            },
            ensure_ascii=False,
        ).encode("utf-8")
        request = urllib.request.Request(
            self.endpoint,
            data=body,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        started = time.perf_counter()
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
                if len(raw) > MAX_RESPONSE_BYTES:
                    raise RuntimeError("智能体工厂响应超过 2 MiB 上限")
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise RuntimeError("智能体工厂响应不是有效的 UTF-8 JSON") from exc
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:500]
            raise RuntimeError(f"智能体工厂 HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError) as exc:
            raise RuntimeError(f"智能体工厂连接失败：{exc}") from exc

        latency_ms = round((time.perf_counter() - started) * 1000)
        content = payload.get("response")
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError(f"智能体工厂响应缺少 response 正文：{str(payload)[:200]}")
        usage = payload.get("usage") or {}
        in_tokens = usage.get("prompt_tokens")
        out_tokens = usage.get("completion_tokens")
        return ModelResponse(
            content=content,
            in_tokens=(
                _non_negative_int(in_tokens, "prompt_tokens")
                if in_tokens is not None
                else self._estimate_tokens(merged)
            ),
            out_tokens=(
                _non_negative_int(out_tokens, "completion_tokens")
                if out_tokens is not None
                else self._estimate_tokens(content)
            ),
            latency_ms=latency_ms,
        )


def _non_negative_int(value: Any, name: str) -> int:
    if isinstance(value, bool):
        raise RuntimeError(f"{name} 不是非负整数")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise RuntimeError(f"{name} 不是非负整数") from exc
    if parsed < 0:
        raise RuntimeError(f"{name} 不是非负整数")
    return parsed


def _read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def _read_yaml(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def _extract_sections(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("sections"), list):
        return data["sections"]
    raise ValueError("章节文件必须是数组，或包含 sections 数组的对象")


def _extract_evidence_packages(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return data
    for key in ("evidence_packages", "packages"):
        if isinstance(data, dict) and isinstance(data.get(key), list):
            return data[key]
    raise ValueError("证据文件必须是数组，或包含 evidence_packages 数组的对象")


def _index_sections(sections: Sequence[Mapping[str, Any]]) -> dict[tuple[str, str], str]:
    """按 (投标人, 章节 id) 建立正文索引，避免不同投标人的相同 id 串证据。"""
    index: dict[tuple[str, str], str] = {}
    for section in sections:
        section_id = str(section.get("id", ""))
        bidder = str(section.get("bidder", ""))
        text = section.get("text")
        if section_id and isinstance(text, str):
            index[(bidder, section_id)] = text
    return index


def _evidence_with_text(
    evidence: Mapping[str, Any],
    section_index: Mapping[tuple[str, str], str],
) -> list[dict[str, Any]]:
    """把 located.json 的证据元数据与 sections.json 中的真实正文合并。"""
    bidder = str(evidence.get("bidder", ""))
    rows: list[dict[str, Any]] = []
    for position, picked in enumerate(evidence.get("picked") or []):
        section_id = str(picked.get("section_id", ""))
        text = picked.get("text")
        if not isinstance(text, str):
            text = section_index.get((bidder, section_id))
        if text is None:
            # 当前 docx 样例没有 bidder 字段；真实多投标人数据优先走上面的复合键。
            text = section_index.get(("", section_id))
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"证据编号 {position}（{section_id}）找不到章节正文")
        chars = picked.get("chars")
        if isinstance(chars, int) and chars >= 0:
            text = text[:chars]
        rows.append(
            {
                "index": position,
                "section_id": section_id,
                "file": picked.get("file"),
                "path": picked.get("path") or [],
                "page": picked.get("page"),
                "text": text,
            }
        )
    return rows


def build_messages(
    evidence: Mapping[str, Any],
    item: Mapping[str, Any],
    project_summary: str,
    project_rules: Sequence[str],
    section_index: Mapping[tuple[str, str], str],
    previous_error: str = "",
) -> list[dict[str, str]]:
    """构造一次评审调用的 Prompt：固定系统约束 + 当前评分项和证据。"""
    # User Prompt 使用结构化 JSON，方便模型准确区分项目规则、评审标准和证据。
    request = {
        "project_summary": project_summary,
        "project_rules": list(project_rules),
        "scoring_item": {
            "id": item["id"],
            "name": item["name"],
            "max_score": item["max_score"],
            "criteria": item["criteria"],
            "tiers": [
                {"tier": tier["tier"], "min": tier["min"], "max": tier["max"]}
                for tier in item["tiers"]
            ],
        },
        "evidence": _evidence_with_text(evidence, section_index),
    }
    if previous_error:
        # 格式错误重试时把上次错误反馈给模型，帮助它修正 JSON，而不是盲目重复。
        request["previous_error"] = previous_error

    # ===== 固定 System Prompt：模型侧调优时优先检查和修改这里 =====
    # 模型只返回引用编号，原文由系统从 evidence 回填，避免模型改写或编造引用。
    # 档位判定以 item.criteria 原文为唯一依据；score 必须落在该档位区间内。
    system = (
        "你是工程建设技术标辅助评审模型。严格对照招标文件评审标准和项目事实评审。"
        "只能引用 evidence 中已有的 index，不得生成或改写原文。"
        "只输出一个 JSON 对象，字段为 tier、score、cite、reason。"
        "tier 必须是评分档位之一；score 必须是一个数字，且落在 tier 对应的分值区间内；"
        "cite 是证据编号数组，无相关证据时可为空；reason 说明判分理由。"
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": json.dumps(request, ensure_ascii=False)},
    ]


def _balance_json(text: str) -> str:
    """给被截断的 JSON 补上缺失的 ``}`` 与 ``]``，字符串内的括号与转义不计入。

    参考「可信空间数据产品」前端 `js/app.js` 的 `balanceJson()`，那边是实测出来的：
    模型长输出被 token 截断时末尾缺闭合括号。本项目 76 次调用尚未复现该情形
    （单次 out_tokens 仅约 150，离截断阈值很远），但补全零损失、成本极低，先备着。

    **刻意不补未闭合的字符串。** 断在字符串中间时，补一个引号能让 JSON 变合法，
    但换来的是一条半句话的 `reason` ——它会静默通过 `_validate_model_output()`，
    交付一个看起来合法、内容却是残的判分理由。本项目有 README §3.6 的重试兜底，
    失败重来只花 2 秒，**宁可失败重来，也不要合法的残缺结果**。
    """
    stack: list[str] = []
    in_string = False
    escaped = False
    for char in text:
        if escaped:
            escaped = False
            continue
        if char == "\\" and in_string:
            escaped = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if char == "{":
            stack.append("}")
        elif char == "[":
            stack.append("]")
        elif char in "}]":
            if stack and stack[-1] == char:
                stack.pop()
    if in_string:
        # 断在字符串中间，见上方说明：不抢救，交给重试。
        return text
    return text + "".join(reversed(stack))


def _repair_json(text: str) -> str:
    """修复模型常犯的两类毛病，均为零损失（只补不删）。

    - 中文顿号当数组分隔符（``"a"、"b"`` → ``"a","b"``），实测来源同 `_balance_json`。
    - 括号未闭合，见 `_balance_json`。
    """
    return _balance_json(text.replace('"\u3001"', '","'))


def _extract_json_object(text: str) -> "str | None":
    """从夹带自然语言的文本里抠出第一个花括号平衡的 JSON 对象。

    有些端点（如智能体工厂）会在正式答案前吐一段思考过程，或把 JSON 裹进
    ``` 代码块且围栏前后还有文字，此时整段既不是 JSON 也不以 ``` 开头。
    字符串内的花括号与转义要跳过，否则 "reason" 里出现 "}" 会截错位置。

    括号始终没配平时返回从第一个 ``{`` 起的全部剩余文本，交给 `_repair_json` 补全。
    """
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return text[start:]


def _parse_json_object(content: str) -> dict[str, Any]:
    """宽松解析模型输出，按**数据损失从小到大**逐级降级。

    1. 剥 ``</think>`` 之后的正文、剥 ``` 代码块围栏 —— 零损失
    2. 直接解析 —— 零损失
    3. `_repair_json`（顿号 + 括号补全）后解析 —— 零损失，只补不删
    4. 抠出第一个 JSON 对象后解析，仍失败则再修一次 —— 零损失，只削外围噪声

    **不做「逐段砍尾」那一级。** 参考实现（`js/app.js` 的 `parseJSON`）有第五级：
    从末尾一个个砍掉不完整的片段直到能解析。那是**有损**的——评审结果只有
    tier/score/cite/reason 四个字段，砍掉任何一个都不是「少显示一点」而是判分失效。
    该前端没有重试、用户在页面上等着，才必须有损抢救；本项目有 §3.6 的重试，
    直接失败重来更便宜也更安全。
    """
    text = content.strip()
    # 部分端点把思考过程与正答用 </think> 分隔，取最后一段。
    if "</think>" in text:
        text = text.rsplit("</think>", 1)[1].strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if len(lines) >= 3 and lines[-1].strip() == "```":
            text = "\n".join(lines[1:-1])
            if text.lstrip().lower().startswith("json"):
                text = text.lstrip()[4:].lstrip()

    payload: Any = None
    for candidate in (text, _repair_json(text)):
        try:
            payload = json.loads(candidate)
            break
        except json.JSONDecodeError:
            continue
    else:
        extracted = _extract_json_object(text)
        if extracted is None:
            raise ReviewError("JSON 解析失败：输出中找不到 JSON 对象")
        for candidate in (extracted, _repair_json(extracted)):
            try:
                payload = json.loads(candidate)
                break
            except json.JSONDecodeError as exc:
                last = exc
        else:
            raise ReviewError(f"JSON 解析失败：{last.msg}") from last

    if not isinstance(payload, dict):
        raise ReviewError("模型输出必须是 JSON 对象")
    return payload


def _number_between_zero_and_one(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ReviewError(f"{name} 必须是 0~1 的数字")
    parsed = float(value)
    if not 0 <= parsed <= 1:
        raise ReviewError(f"{name} 必须是 0~1 的数字")
    return parsed


def _score_in_tier(score: float, tier: Mapping[str, Any], tier_index: int) -> bool:
    """判断 score 是否落在该档位的有效区间内。

    边界约定（data-contract.md §3）：
    - 最高档：闭区间 [min, max]
    - 其他档：左闭右开 [min, max)
    """
    tier_min = float(tier["min"])
    tier_max = float(tier["max"])
    if tier_index == 0:
        return tier_min <= score <= tier_max
    return tier_min <= score < tier_max


def _validate_model_output(
    payload: Mapping[str, Any],
    item: Mapping[str, Any],
    evidence_count: int,
) -> dict[str, Any]:
    """校验模型输出字段，并阻止错误档位、越界分数、越界引用进入结果。"""
    tier_names = [tier["tier"] for tier in item["tiers"]]
    tier = payload.get("tier")
    if tier not in tier_names:
        raise ReviewError(f"tier 必须是以下之一：{', '.join(tier_names)}")
    tier_index = tier_names.index(tier)

    reason = payload.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise ReviewError("reason 必须是非空字符串")

    cite = payload.get("cite")
    if not isinstance(cite, list):
        raise ReviewError("cite 必须是数组")
    clean_cite: list[int] = []
    for value in cite:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ReviewError("cite 中的编号必须是整数")
        if value < 0 or value >= evidence_count:
            raise ReviewError(f"cite 编号 {value} 越界，有效范围是 0~{evidence_count - 1}")
        if value not in clean_cite:
            clean_cite.append(value)

    score = payload.get("score")
    if isinstance(score, bool) or not isinstance(score, (int, float)):
        raise ReviewError("score 必须是数字")
    score = float(score)
    if not _score_in_tier(score, item["tiers"][tier_index], tier_index):
        raise ReviewError(
            f"score {score} 不在档位 {tier} 的有效区间内"
        )

    return {"tier": tier, "reason": reason.strip(), "cite": clean_cite, "score": score}


def _validate_scoring_item(item: Mapping[str, Any]) -> None:
    """在调用模型前校验人工确认的评分配置，错误配置直接失败而不是产生错误分数。"""
    required = ("id", "name", "max_score", "tiers", "criteria")
    missing = [key for key in required if key not in item]
    if missing:
        raise ValueError(f"评分项缺少字段：{', '.join(missing)}")
    if not isinstance(item.get("criteria"), str) or not item["criteria"].strip():
        raise ValueError(f"评分项 {item['id']} 的 criteria 必须是非空字符串")
    tiers = item["tiers"]
    if not isinstance(tiers, list) or not tiers:
        raise ValueError(f"评分项 {item['id']} 的 tiers 不能为空")
    if len({tier.get("tier") for tier in tiers}) != len(tiers):
        raise ValueError(f"评分项 {item['id']} 的 tier 名称必须唯一")
    previous_max: float | None = None
    for tier in tiers:
        if not all(key in tier for key in ("tier", "min", "max")):
            raise ValueError(f"评分项 {item['id']} 的 tier 字段不完整")
        tier_min, tier_max = float(tier["min"]), float(tier["max"])
        if tier_min > tier_max:
            raise ValueError(f"评分项 {item['id']} 的 tier 区间无效")
        if previous_max is not None and tier_max > previous_max:
            raise ValueError(f"评分项 {item['id']} 的 tiers 必须按分值降序排列")
        previous_max = tier_max


def _score_and_confidence(
    validated: Mapping[str, Any],
    evidence: Mapping[str, Any],
    attempts: int,
) -> tuple[float, float, list[str]]:
    """根据模型给出的档位和分数计算置信度。

    score 由模型在档位区间内直接给出，程序只做区间校验，不再按要素加权计算。
    置信度从 1.0 开始，按三因素相乘：降级 ×0.7 / 截断 ×0.9 / 重试 ×0.9。
    """
    score = float(validated["score"])

    confidence = 1.0
    factors: list[str] = []
    if evidence.get("fallback") is True:
        confidence *= 0.7
        factors.append("降级")
    if any(row.get("truncated") is True for row in evidence.get("picked") or []):
        confidence *= 0.9
        factors.append("截断")
    if attempts > 1:
        confidence *= 0.9
        factors.append("重试")
    return score, round(confidence, 3), factors


def _identity(evidence: Mapping[str, Any], item: Mapping[str, Any]) -> dict[str, Any]:
    result = {
        "item_id": item["id"],
        "bidder": evidence.get("bidder", ""),
    }
    guid = item.get("guid") or evidence.get("item_guid")
    if guid:
        result["item_guid"] = guid
    return result


def _miss_result(
    identity: Mapping[str, Any],
    evidence: Mapping[str, Any],
) -> dict[str, Any]:
    """证据包为空时的判分结果。

    两种未命中必须分开，理由见 docs/data-contract.md 第 5 节 ``pool_sections``：
    - ``pool_sections == 0``：该投标人没有这个 PDF，确实没写，判 0 分是对的；
    - ``pool_sections > 0``：文件在、内容在，是检索没找到。仍判 0 分（招标文件规则
      「若此条缺项不得分」），但这是把「写了」判成「没写」的风险位，撞 README §1 的
      P0「档位不能错」，因此压低 confidence 让它进页面④的 ⚠ 与报告的 review_flags。

    ``pool_sections`` 缺失时按 ``not_found`` 处理：无法证明该家没有这个文件，
    保守方向是标出来让人看，而不是静默判 0 分。
    """
    pool_sections = evidence.get("pool_sections")
    # type(...) is int 而非 isinstance：bool 是 int 的子类，False 会等于 0。
    if type(pool_sections) is int and pool_sections == 0:
        miss_reason = "no_file"
        reason = "该投标人未提交本评分项对应的投标文件，按项目规则“若此条缺项不得分”判 0 分。"
        confidence = 1.0
    else:
        miss_reason = "not_found"
        reason = (
            "本评分项对应的投标文件存在，但证据定位未检索到相关章节，"
            "按项目规则“若此条缺项不得分”判 0 分。检索未命中不等于投标人未写，建议人工复核。"
        )
        confidence = NOT_FOUND_CONFIDENCE
    return {
        **identity,
        "status": "rated",
        "tier": None,
        "score": 0,
        "miss_reason": miss_reason,
        "cite": [],
        "reason": reason,
        "confidence": confidence,
        "attempts": 0,
        "last_error": "",
        "perf": {"in_tokens": 0, "out_tokens": 0, "latency_ms": 0},
    }


def review_one(
    evidence: Mapping[str, Any],
    item: Mapping[str, Any],
    project_summary: str,
    project_rules: Sequence[str],
    section_index: Mapping[tuple[str, str], str],
    client: ModelClient,
    *,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    """评审一个证据包，返回 README §4 定义的单项评审结果。"""
    _validate_scoring_item(item)
    if max_attempts < 1:
        raise ValueError("max_attempts 必须大于等于 1")
    identity = _identity(evidence, item)
    picked = evidence.get("picked") or []
    if not picked:
        return _miss_result(identity, evidence)

    # 若证据元数据无法还原正文，先失败再调用模型，避免花 token 评审空内容。
    _evidence_with_text(evidence, section_index)
    total_perf = {"in_tokens": 0, "out_tokens": 0, "latency_ms": 0}
    last_error = ""
    # 默认共调用 4 次：首次调用 + 3 次重试，重试等待时间为 2/4/8 秒。
    for attempt in range(1, max_attempts + 1):
        messages = build_messages(
            evidence,
            item,
            project_summary,
            project_rules,
            section_index,
            previous_error=last_error,
        )
        try:
            response = client.complete(messages)
            total_perf["in_tokens"] += response.in_tokens
            total_perf["out_tokens"] += response.out_tokens
            total_perf["latency_ms"] += response.latency_ms
            # 先解析并校验模型结果，再进行确定性的分数与置信度计算。
            validated = _validate_model_output(
                _parse_json_object(response.content), item, len(picked)
            )
            score, confidence, _ = _score_and_confidence(
                validated, evidence, attempt
            )
            return {
                **identity,
                "status": "rated",
                "tier": validated["tier"],
                "score": score,
                "miss_reason": None,
                "cite": validated["cite"],
                "reason": validated["reason"],
                "confidence": confidence,
                "attempts": attempt,
                "last_error": "",
                "perf": total_perf,
            }
        except (ReviewError, RuntimeError, TimeoutError, ConnectionError, OSError) as exc:
            # 只重试预期的端点或返回格式错误；程序自身 bug 必须直接暴露，不能静默记未评定。
            last_error = str(exc) or exc.__class__.__name__
            if attempt < max_attempts:
                sleep(BACKOFF_SECONDS[min(attempt - 1, len(BACKOFF_SECONDS) - 1)])

    return {
        **identity,
        "status": "unrated",
        "tier": None,
        "score": None,
        "miss_reason": None,
        "cite": [],
        "reason": "模型调用重试耗尽，未能完成评审。",
        "confidence": 0.0,
        "attempts": max_attempts,
        "last_error": last_error,
        "perf": total_perf,
    }


def review_all(
    evidence_packages: Sequence[Mapping[str, Any]],
    scoring_table: Mapping[str, Any],
    project_summary: str,
    sections: Sequence[Mapping[str, Any]],
    client: ModelClient,
    *,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    """按证据包逐项评审，并汇总模型调用次数、重试、token 和耗时。"""
    items = scoring_table.get("items")
    if not isinstance(items, list):
        raise ValueError("评分表顶层必须包含 items 数组")
    item_by_id = {str(item["id"]): item for item in items}
    section_index = _index_sections(sections)
    rules = scoring_table.get("rules") or []
    if not isinstance(rules, list) or not all(isinstance(rule, str) for rule in rules):
        raise ValueError("评分表 rules 必须是字符串数组")

    results = []
    for evidence in evidence_packages:
        item_id = str(evidence.get("item_id") or evidence.get("point_id") or "")
        item = item_by_id.get(item_id)
        if item is None:
            raise ValueError(f"证据包评分项 {item_id!r} 在评分表中不存在")
        results.append(
            review_one(
                evidence,
                item,
                project_summary,
                rules,
                section_index,
                client,
                max_attempts=max_attempts,
                sleep=sleep,
            )
        )

    return {
        "project": scoring_table.get("project", ""),
        "generated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "model": client.name,
        "review_results": results,
        "perf": {
            "calls": len(results),
            "retries": sum(max(result["attempts"] - 1, 0) for result in results),
            "in_tokens": sum(result["perf"]["in_tokens"] for result in results),
            "out_tokens": sum(result["perf"]["out_tokens"] for result in results),
            "latency_ms": sum(result["perf"]["latency_ms"] for result in results),
        },
    }


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="S3：证据包调用模型并生成评审结果")
    parser.add_argument("evidence", type=Path, help="S2 生成的 located.json")
    parser.add_argument("scoring_table", type=Path, help="S0 生成的项目评分表 YAML")
    parser.add_argument("project_summary", type=Path, help="项目特征摘要文本")
    parser.add_argument("sections", type=Path, help="S1 章节 JSON，用于回填证据正文")
    parser.add_argument("output", type=Path, help="review_results.json 输出路径")
    parser.add_argument("--mock", action="store_true", help="使用本地确定性 Mock 模型")
    parser.add_argument(
        "--agent-factory",
        action="store_true",
        help="使用智能体工厂端点（读 AF_BASE_URL / AF_API_KEY / AF_AGENT_ID）",
    )
    parser.add_argument("--timeout", type=float, default=300.0, help="真实模型请求超时秒数")
    parser.add_argument("--max-attempts", type=int, default=DEFAULT_MAX_ATTEMPTS)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    """命令行入口：加载文件、选择 Mock/真实客户端并写出 review_results.json。"""
    args = _parse_args(argv)
    evidence = _extract_evidence_packages(_read_json(args.evidence))
    scoring_table = _read_yaml(args.scoring_table)
    if not isinstance(scoring_table, dict):
        raise ValueError("评分表 YAML 顶层必须是对象")
    summary = args.project_summary.read_text(encoding="utf-8").strip()
    sections = _extract_sections(_read_json(args.sections))
    if args.mock:
        client: ModelClient = MockModelClient()
    elif args.agent_factory:
        client = AgentFactoryClient.from_env(args.timeout)
    else:
        client = OpenAICompatibleClient.from_env(args.timeout)
    output = review_all(
        evidence,
        scoring_table,
        summary,
        sections,
        client,
        max_attempts=args.max_attempts,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.output} ({len(output['review_results'])} review results)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

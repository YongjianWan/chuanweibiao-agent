"""端点探活：一次最小调用，回答「现在能不能演示」。

为什么需要它（2026-08-20 深夜的教训）：
当晚经服务层跑真实端点全量，**228 项全部 unrated**，684 次重试全失败，
根因是端点侧返回 `HTTP 500 {"detail":"Agent 'agent-xxx' not initialized."}`——
同一个 agent 昨晚跑通过 228 项，当晚未初始化。这类故障与我方代码无关，
但会让整场演示归零，而跑完一轮全量才发现要花 7 分钟。

**演练当天开演前先跑这个脚本**，10 秒内给结论。失败就去找智能体工厂那边把 agent 拉起来，
不要直接开演。

用法：

    source config/af-endpoint.sh && python scripts/ping_endpoint.py

退出码 0 = 端点可用，非 0 = 不可用（可用于脚本判断）。
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.s3_review import AgentFactoryClient  # noqa: E402


PROMPT = "请只回复两个字：正常"


def main() -> int:
    try:
        client = AgentFactoryClient.from_env(timeout=60.0)
    except ValueError as exc:
        print(f"✗ {exc}")
        print("  先执行：source config/af-endpoint.sh")
        return 2

    print(f"端点：{client.endpoint}")
    started = time.perf_counter()
    try:
        response = client.complete([{"role": "user", "content": PROMPT}])
    except Exception as exc:  # noqa: BLE001 —— 探活就是要把任何失败原样显示出来
        elapsed = time.perf_counter() - started
        print(f"✗ 端点不可用（{elapsed:.1f} 秒后失败）")
        print(f"  {exc}")
        print()
        print("  常见情形：")
        print("  · HTTP 500 Agent not initialized —— 端点侧 agent 没起，找智能体工厂那边拉起来")
        print("  · 超时 —— 检查是否走了 HTTP 代理（内网端点必须绕过代理）")
        print("  · 401/403 —— AF_API_KEY 过期")
        print()
        print("  **此时不要开演**：真跑会 228 项全部 unrated。")
        print("  应急预案：用 python src/server.py --mock 排练界面流程，")
        print("  并向客户说明模型端点故障，不要拿 mock 结果当真实评审结果展示。")
        return 1

    elapsed = time.perf_counter() - started
    print(f"✓ 端点可用，单次往返 {elapsed:.1f} 秒")
    print(f"  回复：{response.content.strip()[:80]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

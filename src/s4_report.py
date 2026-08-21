"""T6：S4 报告生成器。

把 S3 的评审结果（reviews 目录，<bidder>/<item_id>.json 形态，与调度器 work_dir
一致）汇总成客户交付物的数据层，产出结构严格对齐 docs/data-contract.md §7：

- report.json：报告数据（页面④、导出的消费方）
- report.md ：人读版（总分排名 / 评分矩阵 / ⚠ 复核清单 / 审计告警 / 未评定清单）

口径要点（均见 §6/§7/§8，勿擅改）：
- matrix 里 null = 未评定，0 = 未命中/没写（由 miss_reason 区分），不得在数据层合并
- matrix 与 totals.score 只装系统判分，专家改判永不回写；专家口径走
  totals[].expert_score 与 expert_reviews 并排呈现
- perf.calls 恒为 投标人数 × 评分项数，是覆盖度校验位，不是模型调用次数
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

import yaml

# confidence 低于该值的项进 review_flags 与页面④的 ⚠（§6，阈值由两因素表算出，
# 推导见 docs/data-contract.md 的 confidence 条）
REVIEW_FLAG_THRESHOLD = 0.85

# 未采集字段的占位口径：不得省略、不得估算（§7，同 ui-spec.md 页面③约定）
GPU_NOTE = "模型为远程托管端点，我方进程内无法采集显存"
COMPUTE_NOTES = {
    "owner": "未采集（算力归属：我方自有 / 政务云 / 其他，待填，README §8 B3 未解除）",
    "spec": "未采集（卡型号、显存、可用卡数，待 B3 解除后填实际值，不填估算值）",
    "model": "未采集（模型名与版本，待 README §8 B2 解除后填）",
    "method": [
        "证据定位：IDF 加权 + 单锚点闸门，不依赖向量库",
        "防幻觉：引用由模型选择证据编号，原文由系统截取",
    ],
}


def load_results(reviews_dir: Path) -> dict[tuple[str, str], dict[str, Any]]:
    """读取评审结果。支持两种输入：
    - 目录：读取其下全部 <bidder>/<item_id>.json，键从文件路径还原
    - 单文件 reviews.json：读取其 review_results 数组，键从记录字段还原
    """
    results: dict[tuple[str, str], dict[str, Any]] = {}
    if not reviews_dir.exists():
        raise FileNotFoundError(f"reviews 路径不存在: {reviews_dir}")
    if reviews_dir.is_file():
        data = json.loads(reviews_dir.read_text(encoding="utf-8"))
        for r in data.get("review_results", []):
            results[(r["bidder"], r["item_id"])] = r
        return results
    for item_file in sorted(reviews_dir.glob("*/*.json")):
        key = (item_file.parent.name, item_file.stem)
        results[key] = json.loads(item_file.read_text(encoding="utf-8"))
    return results


def load_expert_reviews(path: Path | None) -> list[dict[str, Any]]:
    """读专家复核记录（§8）。文件不存在时返回空数组——没有改判记录是正常态。"""
    if path is None or not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"expert_reviews 必须是数组: {path}")
    return data


def _flag_why(result: Mapping[str, Any]) -> str:
    """review_flags 的人读原因。评审结果不含 fallback/truncated 元数据（在证据包里），
    能确定的写确定，不能确定的写明阈值事实，不编理由。"""
    parts: list[str] = []
    if result.get("miss_reason") == "not_found":
        parts.append("检索未命中（文件在但证据定位未找到），把「写了」判成「没写」的风险位")
    if not parts:
        # 默认理由写死「证据降级」依赖一个隐式前提：当前两因素（降级 0.7 / 截断 0.9）
        # 口径下，rated 且 confidence < 0.85 的项必然含降级（仅截断是 0.90，不进清单）。
        # 将来若调整因素或乘数，这个默认理由要跟着重审——data-contract 里
        # 「改因素必须重算阈值表」的规矩覆盖不到这行文案。
        parts.append("证据降级（细粒度检索词未命中，退回评分项名重检索），证据可能不对题")
    # 重试次数不再是打折原因（2026-08-21，见 s3_review._score_and_confidence 的 docstring），
    # 但它是排查线索，附在后面，不单独构成进 review_flags 的理由。
    attempts = result.get("attempts") or 0
    if attempts > 1:
        parts.append(f"另：该项调用重试过 {attempts - 1} 次（不影响置信度）")
    return "；".join(parts)


def _build_audit(
    items: Sequence[Mapping[str, Any]],
    bidders: Sequence[str],
    results: Mapping[tuple[str, str], Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """跨投标人的档位分布审计（§7）：某项在全部投标人中判分完全无区分
    （落在同一档，含全部 0 分）时触发 no_discrimination。"""
    audit: list[dict[str, Any]] = []
    for item in items:
        item_id = str(item["id"])
        rated = [
            results[(b, item_id)]
            for b in bidders
            if (b, item_id) in results and results[(b, item_id)].get("status") == "rated"
        ]
        # 有人未评定就不是「全部投标人同档」，不触发
        if len(rated) != len(bidders):
            continue
        tier_names = [t["tier"] for t in item.get("tiers", [])]
        tier_dist: dict[str, int] = {t: 0 for t in tier_names}
        groups: set[str] = set()
        misses = 0
        for r in rated:
            tier = r.get("tier")
            if tier is None:  # 未命中 0 分项 tier 为 null（§6 _miss_result）
                groups.add("未命中")
                misses += 1
            else:
                groups.add(tier)
                tier_dist[tier] = tier_dist.get(tier, 0) + 1
        if len(groups) != 1:
            continue
        if misses:
            tier_dist["未命中"] = misses
            detail = f"{len(bidders)} 家全部 0 分（未命中）"
        else:
            only = next(iter(groups))
            detail = f"{len(bidders)} 家全部判「{only}」档"
        audit.append({
            "item_id": item_id,
            "kind": "no_discrimination",
            "detail": detail,
            "tier_dist": tier_dist,
        })
    return audit


def _latest_expert_records(
    expert_reviews: Sequence[Mapping[str, Any]],
) -> dict[tuple[str, str], Mapping[str, Any]]:
    """同一 (bidder, item_id) 多条记录以 reviewed_at 最新的一条为准（§8）。"""
    latest: dict[tuple[str, str], Mapping[str, Any]] = {}
    for rec in expert_reviews:
        key = (str(rec.get("bidder", "")), str(rec.get("item_id", "")))
        if key not in latest or str(rec.get("reviewed_at", "")) >= str(
            latest[key].get("reviewed_at", "")
        ):
            latest[key] = rec
    return latest


def build_report(
    reviews_dir: Path,
    scoring_table_path: Path,
    expert_reviews_path: Path | None = None,
) -> dict[str, Any]:
    """汇总评审结果为 §7 报告数据。"""
    scoring_table = yaml.safe_load(scoring_table_path.read_text(encoding="utf-8"))
    items = scoring_table.get("items", [])
    results = load_results(reviews_dir)
    expert_reviews = load_expert_reviews(expert_reviews_path)
    latest_expert = _latest_expert_records(expert_reviews)

    bidders = sorted({b for b, _ in results})

    # matrix：行来自评分表，格子里 null = 未评定，0 = 未命中/没写（§7）
    matrix: list[dict[str, Any]] = []
    for item in items:
        item_id = str(item["id"])
        scores: dict[str, Any] = {}
        for b in bidders:
            r = results.get((b, item_id))
            if r is None or r.get("status") != "rated":
                scores[b] = None
            else:
                scores[b] = r.get("score")
        matrix.append({
            "item_id": item_id,
            "name": item.get("name", ""),
            "max_score": item.get("max_score"),
            "scores": scores,
        })

    # details：全部评审结果，按 bidder + item_id 排序
    details = [results[k] for k in sorted(results)]

    # unrated / review_flags
    unrated: list[dict[str, Any]] = []
    review_flags: list[dict[str, Any]] = []
    for key in sorted(results):
        r = results[key]
        if r.get("status") == "unrated":
            unrated.append({
                "bidder": r.get("bidder", key[0]),
                "item_id": r.get("item_id", key[1]),
                "attempts": r.get("attempts", 0),
                "last_error": r.get("last_error", ""),
            })
        elif (r.get("confidence") or 0) < REVIEW_FLAG_THRESHOLD:
            review_flags.append({
                "bidder": r.get("bidder", key[0]),
                "item_id": r.get("item_id", key[1]),
                "confidence": r.get("confidence"),
                "why": _flag_why(r),
            })

    # totals：score 只装系统判分、不含未评定项；expert_score 逐项取
    # 「有改判记录用专家分，否则用系统判分」，未评定且未改判不计入（§7/§8）
    totals: dict[str, dict[str, Any]] = {}
    for b in bidders:
        score = 0.0
        expert_score = 0.0
        unrated_count = 0
        overrides = 0
        for item in items:
            item_id = str(item["id"])
            r = results.get((b, item_id))
            rec = latest_expert.get((b, item_id))
            overridden = rec is not None and rec.get("action") == "改判"
            if overridden:
                overrides += 1
                expert_score += rec.get("expert_score") or 0
            if r is None or r.get("status") != "rated":
                unrated_count += 1
            else:
                score += r.get("score") or 0
                if not overridden:
                    expert_score += r.get("score") or 0
        totals[b] = {
            "score": round(score, 1),
            "unrated": unrated_count,
            "expert_score": round(expert_score, 1),
            "expert_overrides": overrides,
        }

    audit = _build_audit(items, bidders, results)

    # perf：calls 是覆盖度校验位（家数 × 项数），不是模型调用次数（§7）；
    # 实际模型调用次数 = Σ attempts = calls − 未命中项数 + retries
    calls = len(bidders) * len(items)
    sum_attempts = sum(r.get("attempts") or 0 for r in results.values())
    first_calls = sum(1 for r in results.values() if (r.get("attempts") or 0) >= 1)

    # 优先读取调度器写进 reviews.json 顶层的 wall_clock_sec / concurrency；
    # 缺失时保留占位口径，不估算。
    reviews_perf = {}
    try:
        if reviews_dir.is_file():
            reviews_meta = json.loads(reviews_dir.read_text(encoding="utf-8"))
            reviews_perf = reviews_meta.get("perf") or {}
        else:
            reviews_meta_path = reviews_dir / "reviews.json"
            if reviews_meta_path.exists():
                reviews_meta = json.loads(reviews_meta_path.read_text(encoding="utf-8"))
                reviews_perf = reviews_meta.get("perf") or {}
    except (json.JSONDecodeError, OSError):
        pass

    wall_clock_sec = reviews_perf.get("wall_clock_sec")
    concurrency = reviews_perf.get("concurrency")
    if wall_clock_sec is None:
        wall_clock_note = (
            "未采集（调度器未落盘墙钟耗时；逐项 latency 之和为 "
            f"{round(sum((r.get('perf') or {}).get('latency_ms') or 0 for r in results.values()) / 1000, 1)} 秒，"
            "并发下实际墙钟低于该值）"
        )
    else:
        wall_clock_note = f"调度器落盘墙钟耗时：{wall_clock_sec} 秒"

    perf = {
        "wall_clock_sec": wall_clock_sec,
        "wall_clock_note": wall_clock_note,
        "concurrency": concurrency if concurrency is not None else "未采集",
        "calls": calls,
        "retries": sum_attempts - first_calls,
        "in_tokens": sum((r.get("perf") or {}).get("in_tokens") or 0 for r in results.values()),
        "out_tokens": sum((r.get("perf") or {}).get("out_tokens") or 0 for r in results.values()),
        "gpu": "未采集",
        "vram_peak_gb": None,
        "gpu_note": GPU_NOTE,
    }

    return {
        "project": scoring_table.get("project", ""),
        "generated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "bidders": bidders,
        "matrix": matrix,
        "totals": totals,
        "details": details,
        "unrated": unrated,
        "review_flags": review_flags,
        "audit": audit,
        "expert_reviews": list(expert_reviews),
        "perf": perf,
        "compute_notes": dict(COMPUTE_NOTES),
    }


def _cell(value: Any) -> str:
    """matrix 单元格渲染：null → —，0 → 0，其余原样（§7：null 与 0 必须用不同符号）。"""
    if value is None:
        return "—"
    return f"{value}"


def render_markdown(report: Mapping[str, Any]) -> str:
    """人读版报告。按「没有上下文的人能读懂」的标准写表头和注释。"""
    lines: list[str] = []
    bidders: list[str] = report["bidders"]  # type: ignore[assignment]
    totals: Mapping[str, Mapping[str, Any]] = report["totals"]  # type: ignore[assignment]

    lines.append(f"# 技术标辅助评审报告")
    lines.append("")
    lines.append(f"- 项目：{report['project']}")
    lines.append(f"- 生成时间：{report['generated_at']}")
    lines.append(f"- 投标人家数：{len(bidders)}；评分项数：{len(report['matrix'])}")
    lines.append("")
    lines.append("> 阅读说明：本报告由辅助系统产出，「系统判分」是模型按招标文件评审标准"
                 "给出的分数，「专家判分」是评审专家复核后的分数（未复核的项等于系统判分）。"
                 "评分矩阵中 `—` 表示该项系统未能评定（需人工处理），`0` 表示投标人未写"
                 "或系统未检索到相关内容，两者含义不同。")
    lines.append("")

    # 总分排名
    lines.append("## 总分排名")
    lines.append("")
    lines.append("| 排名 | 投标人 | 系统判分 | 专家判分 | 备注 |")
    lines.append("| --- | --- | ---: | ---: | --- |")
    ranked = sorted(bidders, key=lambda b: totals[b]["score"], reverse=True)
    for i, b in enumerate(ranked, 1):
        t = totals[b]
        notes: list[str] = []
        if t["unrated"]:
            notes.append(f"含 {t['unrated']} 项未评定，合计不含这些项")
        if t["expert_overrides"]:
            notes.append(f"专家改判 {t['expert_overrides']} 项")
        lines.append(f"| {i} | {b} | {t['score']} | {t['expert_score']} | {'；'.join(notes)} |")
    lines.append("")

    # 评分矩阵
    lines.append("## 评分矩阵（逐项判分，系统口径）")
    lines.append("")
    lines.append("> `—` = 未评定；`0` = 未写或检索未命中（可在明细中按 miss_reason 区分）。"
                 "专家改判不回写本表，见文末专家复核记录。")
    lines.append("")
    header = "| 评分项 | 满分 | " + " | ".join(bidders) + " |"
    sep = "| --- | ---: | " + " | ".join("---:" for _ in bidders) + " |"
    lines.append(header)
    lines.append(sep)
    for row in report["matrix"]:
        cells = " | ".join(_cell(row["scores"][b]) for b in bidders)
        lines.append(f"| {row['item_id']} {row['name']} | {row['max_score']} | {cells} |")
    lines.append("")

    # ⚠ 复核清单
    lines.append("## ⚠ 建议人工复核清单")
    lines.append("")
    lines.append("> 置信度低于 0.85 的项。阈值口径：除「仅被截断」与「仅重试过」外一律标记；"
                 "检索未命中（not_found）必然入列——它可能把「写了」判成「没写」。")
    lines.append("")
    if report["review_flags"]:
        lines.append("| 投标人 | 评分项 | 置信度 | 原因 |")
        lines.append("| --- | --- | ---: | --- |")
        for f in report["review_flags"]:
            lines.append(f"| {f['bidder']} | {f['item_id']} | {f['confidence']} | {f['why']} |")
    else:
        lines.append("（无）")
    lines.append("")

    # audit 告警
    lines.append("## 审计告警（跨投标人判分区分度）")
    lines.append("")
    lines.append("> 某评分项在全部投标人中判分完全无区分（同档或全部 0 分）时触发："
                 "专业投标人写出完全同档内容的概率，远低于该项检索配错或档位判飘的概率。")
    lines.append("> 注意：单项判飘但各家分布正常的情形没有自动信号，只能人工抽查。")
    lines.append("")
    if report["audit"]:
        lines.append("| 评分项 | 类型 | 详情 | 档位分布 |")
        lines.append("| --- | --- | --- | --- |")
        for a in report["audit"]:
            dist = "，".join(f"{k} {v}" for k, v in a["tier_dist"].items())
            lines.append(f"| {a['item_id']} | {a['kind']} | {a['detail']} | {dist} |")
    else:
        lines.append("（无）")
    lines.append("")

    # 未评定清单
    lines.append("## 未评定清单")
    lines.append("")
    lines.append("> 模型调用重试耗尽、系统未能判出的项，合计分中不含这些项，需人工处理。")
    lines.append("")
    if report["unrated"]:
        lines.append("| 投标人 | 评分项 | 尝试次数 | 最后错误 |")
        lines.append("| --- | --- | ---: | --- |")
        for u in report["unrated"]:
            lines.append(f"| {u['bidder']} | {u['item_id']} | {u['attempts']} | {u['last_error']} |")
    else:
        lines.append("（无）")
    lines.append("")

    # 专家复核记录
    lines.append("## 专家复核记录")
    lines.append("")
    lines.append("> 专家改判不回写系统判分，两套分数并排呈现（机辅人定）。")
    lines.append("")
    if report["expert_reviews"]:
        lines.append("| 投标人 | 评分项 | 动作 | 系统判分 | 专家判分 | 差值 | 说明 | 时间 |")
        lines.append("| --- | --- | --- | ---: | ---: | ---: | --- | --- |")
        for rec in report["expert_reviews"]:
            lines.append(
                f"| {rec.get('bidder', '')} | {rec.get('item_id', '')} "
                f"| {rec.get('action', '')} | {_cell(rec.get('system_score'))} "
                f"| {_cell(rec.get('expert_score'))} | {_cell(rec.get('delta'))} "
                f"| {rec.get('note', '')} | {rec.get('reviewed_at', '')} |"
            )
    else:
        lines.append("（无：专家尚未复核，专家判分列等于系统判分）")
    lines.append("")

    # 运行数据与算力说明
    perf = report["perf"]
    cn = report["compute_notes"]
    lines.append("## 运行数据与算力说明")
    lines.append("")
    lines.append(f"- 评审项次数（覆盖度校验位 = 家数 × 项数）：{perf['calls']}")
    lines.append(f"- 重试次数：{perf['retries']}；输入 tokens：{perf['in_tokens']}；"
                 f"输出 tokens：{perf['out_tokens']}")
    lines.append("> 注：当前端点不返回 token usage，输入/输出 tokens 按 1.5 汉字/token "
                 "本地估算，非端点真实计数。")
    lines.append(f"- GPU / 显存：{perf['gpu']} / {perf['vram_peak_gb']}（{perf['gpu_note']}）")
    lines.append(f"- 算力归属：{cn['owner']}")
    lines.append(f"- 算力规格：{cn['spec']}")
    lines.append(f"- 模型：{cn['model']}")
    lines.append("- 技术做法：")
    for m in cn["method"]:
        lines.append(f"  - {m}")
    lines.append("")

    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    """S4 CLI：读 reviews 目录 + 评分表，产出 report.json 与 report.md。

    用法：
        python src/s4_report.py \
            --reviews data/projects/jiyang-epc/reviews \
            --scoring-table config/projects/济阳区实验高级中学.yaml \
            --output data/out \
            [--expert-reviews data/projects/jiyang-epc/expert_reviews.json]
    """
    parser = argparse.ArgumentParser(description="T6: S4 报告生成器")
    parser.add_argument("--reviews", type=Path, required=True,
                        help="评审结果目录（<bidder>/<item_id>.json 形态）")
    parser.add_argument("--scoring-table", type=Path, required=True,
                        help="S0 生成的评分表 YAML")
    parser.add_argument("--output", type=Path, required=True,
                        help="输出目录：report.json 与 report.md")
    parser.add_argument("--expert-reviews", type=Path, default=None,
                        help="专家复核记录 JSON（可选，缺省/不存在时按无改判处理）")
    args = parser.parse_args(argv)

    report = build_report(args.reviews, args.scoring_table, args.expert_reviews)

    args.output.mkdir(parents=True, exist_ok=True)
    json_path = args.output / "report.json"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                         encoding="utf-8")
    md_path = args.output / "report.md"
    md_path.write_text(render_markdown(report), encoding="utf-8")
    print(f"wrote {json_path}")
    print(f"wrote {md_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

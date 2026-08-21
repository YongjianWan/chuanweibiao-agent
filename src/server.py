"""T10：运行时服务层。

把 S1~S4 那五个 CLI 脚本接到浏览器上——README §3.8 说的那层空白。

设计取舍（改之前先读，别照着「更标准」的样子重写）：

- **只用 Python 标准库，不引入 FastAPI/uvicorn。** 已定的接口只有三个端点、
  不收文件上传（§3.8 与 2026-08-20 决策：投标文件从服务端本地目录读，196MB 不走网络），
  标准库的 ThreadingHTTPServer 完全够用。少一个 pip 依赖 = 演示当天少一个失败点。
- **不 import S1~S4，一律 subprocess 调 CLI。** 那五个脚本已经在真实数据上跑过全量，
  import 进来等于把它们的 argparse 契约换成函数契约，得重测。subprocess 保持
  「命令行怎么跑，服务层就怎么跑」，出问题时可以把命令原样贴进终端复现。
- **进度不靠脚本回调，靠观察 scheduler 的落盘。** scheduler 本来就为断点续跑
  逐项写 work_dir/<bidder>/<item_id>.json（见 src/scheduler.py 的 run_batch），
  服务层只需扫这个目录。这样 scheduler 一行都不用改，续跑能力也白捡。

**开演前先跑 `python scripts/ping_endpoint.py`**——端点挂了就别开演，
2026-08-20 深夜有过一次 228 项全部 unrated 的教训，见 DEFAULT_CONCURRENCY 的注释。

启动：

    python src/server.py                # 默认 127.0.0.1:8000，真实端点，并发 4
    python src/server.py --mock         # 用 Mock 模型，不调端点（排练界面用，约 30 秒）
    python src/server.py --port 8080 --clean

浏览器打开 http://127.0.0.1:8000/ 即是 prototype/ 的页面①。
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent.parent
PROTOTYPE_DIR = ROOT / "prototype"
SCORING_TABLE = ROOT / "config" / "projects" / "济阳区实验高级中学.yaml"
PROJECT_SUMMARY = ROOT / "config" / "projects" / "项目特征摘要.md"
DEFAULT_SOURCE = ROOT / "原始资料" / "实际测试工程文件" / "济阳区实验高级中学项目工程总承包（EPC） 2"
RUNS_ROOT = ROOT / "data" / "runs"

# 默认 4 路，不是 12。2026-08-20 深夜实测：
#   并发 12 → 228 项**全部** unrated，684 次重试全失败，端点返回
#             HTTP 500 {"detail":"Agent 'agent-xxx' not initialized."}
#   并发  4 → 单家 19/19 全部 rated；全量 228 项成功，全流程 345.6 秒
# 注意归因有边界：同一个错误也会在与并发无关时出现（agent 自身「未初始化」故障态，
# 当晚一次单请求重跑也撞上，人工重启 agent 后恢复）。所以 4 路是「实测稳定」的选择，
# 不是「并发 ≤ 4 就永远不出错」的保证。详见 README §6 阶段二的归因说明。
# 按 4 路实测全量约 6 分钟，相对 50 分钟预算（README §1）富余约 8.6 倍，
# 拿吞吐换稳定在这里划算。**调高之前先跑 scripts/ping_endpoint.py 并小批量验证。**
DEFAULT_CONCURRENCY = 4

# 四个阶段名必须与 prototype/js/app.js 的 stageNames 逐字一致，否则页面③的阶段条不亮。
STAGE_INGEST = "PDF 入库"
STAGE_LOCATE = "证据定位"
STAGE_REVIEW = "逐项评审"
STAGE_REPORT = "结果汇总"

RUNS: dict[str, "Run"] = {}
RUNS_LOCK = threading.Lock()


class Run:
    """一次评审运行的全部状态。events 只追加不修改，前端按 cursor 增量取。"""

    def __init__(self, run_id: str, source: Path, concurrency: int, mock: bool):
        self.id = run_id
        self.source = source
        self.concurrency = concurrency
        self.mock = mock
        self.dir = RUNS_ROOT / run_id
        self.reviews_dir = self.dir / "reviews"
        self.report_dir = self.dir / "report"
        self.events: list[dict] = []
        self.done = False
        self.failed = False
        self.error = ""
        self.started_at = time.time()
        self.finished_at: float | None = None
        self.lock = threading.Lock()
        # 页面②是全流程唯一的人工介入点（README §5.2）。S1/S2 在人核对评分表期间就跑，
        # 但 **S3 必须等确认**——否则人还没点确认、后台已经评完，页面③会一次性刷完
        # 228 项，看起来正是 §1 P0 要避免的「预跑好当场播放」。
        self.confirmed = threading.Event()

    def emit(self, event: dict) -> None:
        with self.lock:
            self.events.append(event)

    def stage(self, name: str, status: str, message: str) -> None:
        self.emit({"type": "stage", "stage": name, "status": status, "message": message})

    def seen_reviews(self) -> set:
        with self.lock:
            return {(e.get("bidder"), e.get("item_id")) for e in self.events if e.get("type") == "review"}

    def snapshot(self, cursor: int) -> dict:
        with self.lock:
            events = self.events[cursor:]
            total = len(self.events)
        return {
            "run_id": self.id,
            "events": events,
            "cursor": total,
            "done": self.done,
            "failed": self.failed,
            "error": self.error,
            "concurrency": self.concurrency,
            "elapsed_sec": round((self.finished_at or time.time()) - self.started_at, 1),
        }


def run_cli(run: Run, args: list[str], step: str) -> None:
    """跑一条 CLI，失败就抛。stdout 不进事件流——页面③要的是评审进度，不是脚本日志。"""
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1")
    proc = subprocess.run(
        [sys.executable, *args],
        cwd=str(ROOT), env=env, capture_output=True,
        encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-8:]
        raise RuntimeError(f"{step} 失败（exit {proc.returncode}）：" + " / ".join(tail))


def scan_reviews(run: Run) -> None:
    """扫一遍 scheduler 的落盘产物，把新出现的项转成事件。

    scheduler 每完成一项就写 work_dir/<bidder>/<item_id>.json（为断点续跑而设计），
    所以这里只读不改，不需要和 scheduler 约定任何协议。"""
    if not run.reviews_dir.exists():
        return
    seen = run.seen_reviews()
    for bidder_dir in sorted(run.reviews_dir.iterdir()):
        if not bidder_dir.is_dir():
            continue
        for item_file in sorted(bidder_dir.glob("*.json")):
            if (bidder_dir.name, item_file.stem) in seen:
                continue
            try:
                data = json.loads(item_file.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue  # 正在写，下一轮再读
            emit_review_events(run, bidder_dir.name, data)


def watch_reviews(run: Run, stop: threading.Event) -> None:
    while not stop.is_set():
        scan_reviews(run)
        stop.wait(0.4)


def emit_review_events(run: Run, bidder: str, data: dict) -> None:
    """一项评审 → 若干 retry 事件 + 一个 review 事件。

    bidder 用**全名**，前端按名字查 id（app.js 的 bidderByName）。不在服务端造短 id：
    短 id 的生成规则在前端，两边各写一份必然漂移。"""
    perf = data.get("perf") or {}
    attempts = data.get("attempts") or 1
    for i in range(1, attempts):
        run.emit({
            "type": "retry", "bidder": bidder, "item_id": data.get("item_id"),
            "attempt": i, "max_attempts": attempts,
            "message": data.get("last_error") or "模型返回不合规，准备重试",
        })
    run.emit({
        "type": "review",
        "bidder": bidder,
        "item_id": data.get("item_id"),
        "status": data.get("status"),
        "score": data.get("score"),
        "tier": data.get("tier"),
        "miss_reason": data.get("miss_reason"),
        "confidence": data.get("confidence"),
        "attempts": attempts,
        "last_error": data.get("last_error") or "",
        "cite": data.get("cite") or [],
        "reason": data.get("reason") or "",
        "in_tokens": perf.get("in_tokens") or 0,
        "out_tokens": perf.get("out_tokens") or 0,
        "latency_ms": perf.get("latency_ms") or 0,
    })


def orchestrate(run: Run) -> None:
    """S1 → merge → S2 → S3 → S4，顺序跑。任一步失败即整体失败并如实上报。"""
    try:
        run.dir.mkdir(parents=True, exist_ok=True)

        run.stage(STAGE_INGEST, "running", "开始读取 12 家投标技术标 PDF")
        run_cli(run, ["src/s1_ingest.py", "--project", str(run.source), str(run.dir)], "S1 入库")
        run_cli(run, ["scripts/merge_sections.py", str(run.dir)], "章节合并")
        run.stage(STAGE_INGEST, "done", "全部投标文件入库完成")

        run.stage(STAGE_LOCATE, "running", "按 GUID 绑定关系，在单个 PDF 内部定位证据")
        run_cli(run, ["src/s2_locate.py", "--project", str(run.dir),
                      "--scoring-table", str(SCORING_TABLE)], "S2 证据定位")
        run.stage(STAGE_LOCATE, "done", "证据包生成完成，等待页面②确认评分表")

        # 等页面②的人工确认。前端 startReview() 会打 POST /api/confirm。
        # 超时上限 30 分钟：演示当天万一没人点，也不要把线程永远挂住。
        if not run.confirmed.wait(timeout=1800):
            raise RuntimeError("等待页面②确认超时（30 分钟）")

        run.stage(STAGE_REVIEW, "running", "逐项评审开始")
        stop = threading.Event()
        watcher = threading.Thread(target=watch_reviews, args=(run, stop), daemon=True)
        watcher.start()
        try:
            args = ["src/scheduler.py",
                    "--evidence", str(run.dir / "evidence"),
                    "--scoring-table", str(SCORING_TABLE),
                    "--project-summary", str(PROJECT_SUMMARY),
                    "--sections", str(run.dir / "sections_all.json"),
                    "--output", str(run.reviews_dir),
                    "--concurrency", str(run.concurrency),
                    "--mock" if run.mock else "--agent-factory"]
            run_cli(run, args, "S3 评审")
        finally:
            stop.set()
            watcher.join(timeout=3)
            scan_reviews(run)  # 收尾补扫：最后几项可能落在最后一次轮询之后
        run.stage(STAGE_REVIEW, "done", "全部评分项评审完成")

        run.stage(STAGE_REPORT, "running", "汇总报告")
        run_cli(run, ["src/s4_report.py",
                      "--reviews", str(run.reviews_dir),
                      "--scoring-table", str(SCORING_TABLE),
                      "--output", str(run.report_dir)], "S4 报告")
        run.stage(STAGE_REPORT, "done", "报告已生成")
    except Exception as exc:  # noqa: BLE001 —— 任何失败都要如实回传给页面③，不吞
        run.failed = True
        run.error = str(exc)
        run.stage(STAGE_REVIEW, "running", f"运行失败：{exc}")
    finally:
        run.done = True
        run.finished_at = time.time()


class Handler(BaseHTTPRequestHandler):
    server_version = "TechnicalReviewServer/1.0"

    def log_message(self, fmt, *args):
        # 轮询每秒一次，默认日志会刷屏，只留非轮询请求
        if "/api/progress" not in (self.path or ""):
            sys.stderr.write("%s - %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    def send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def do_GET(self):
        parsed = urlparse(self.path)
        path, query = parsed.path, parse_qs(parsed.query)

        if path == "/api/health":
            return self.send_json({"ok": True, "source": str(DEFAULT_SOURCE),
                                   "source_exists": DEFAULT_SOURCE.exists(),
                                   "mock": self.server.mock_mode})
        if path == "/api/progress":
            run = self._lookup(query)
            if run is None:
                return self.send_json({"error": "run_id 不存在"}, 404)
            cursor = int((query.get("cursor") or ["0"])[0])
            return self.send_json(run.snapshot(cursor))
        if path == "/api/report.xlsx":
            run = self._lookup(query)
            if run is None:
                return self.send_json({"error": "run_id 不存在"}, 404)
            report_file = run.report_dir / "report.json"
            if not report_file.exists():
                return self.send_json({"error": "报告尚未生成"}, 404)
            xlsx = run.report_dir / "评审报告.xlsx"
            try:
                # 与其他步骤一致走 CLI：出问题时命令能原样贴进终端复现
                run_cli(run, ["scripts/export_xlsx.py", str(report_file),
                              "-o", str(xlsx)], "导出 Excel")
            except RuntimeError as exc:
                return self.send_json({"error": str(exc)}, 500)
            data = xlsx.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type",
                             "application/vnd.openxmlformats-officedocument."
                             "spreadsheetml.sheet")
            # 文件名走 RFC 5987，中文名各浏览器都能正确落盘
            self.send_header("Content-Disposition",
                             "attachment; filename=review-report.xlsx; "
                             "filename*=UTF-8''%E8%AF%84%E5%AE%A1%E6%8A%A5%E5%91%8A.xlsx")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return None
        if path == "/api/report":
            run = self._lookup(query)
            if run is None:
                return self.send_json({"error": "run_id 不存在"}, 404)
            report_file = run.report_dir / "report.json"
            if not report_file.exists():
                return self.send_json({"error": "报告尚未生成"}, 404)
            return self.send_json(json.loads(report_file.read_text(encoding="utf-8")))
        return self.serve_static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/confirm":
            run = self._lookup(parse_qs(urlparse(self.path).query))
            if run is None:
                return self.send_json({"error": "run_id 不存在"}, 404)
            run.confirmed.set()
            return self.send_json({"ok": True, "run_id": run.id})
        if path != "/api/run":
            return self.send_json({"error": "not found"}, 404)
        body = self.read_json()
        source = Path(body.get("source") or DEFAULT_SOURCE)
        if not source.is_absolute():
            source = ROOT / source
        if not source.exists():
            return self.send_json({"error": f"投标文件目录不存在：{source}"}, 400)

        # 同时只允许一条流水线在跑。两条 4 路并发叠加 = 8 路打向端点，
        # 而 12 路那晚 228 项全灭过（README §6 阶段二），离出过事的区间不远。
        # 演示现场双击/连点页面①是真实会发生的事，不能靠人小心。
        with RUNS_LOCK:
            active = next((r for r in RUNS.values() if not r.done), None)
        if active is not None:
            return self.send_json(
                {"error": f"已有运行进行中（run {active.id}），等它跑完再发起",
                 "active_run_id": active.id, "concurrency": active.concurrency}, 409)

        run = Run(
            run_id=uuid.uuid4().hex[:12],
            source=source,
            concurrency=int(body.get("concurrency") or DEFAULT_CONCURRENCY),
            mock=bool(body.get("mock", self.server.mock_mode)),
        )
        with RUNS_LOCK:
            RUNS[run.id] = run
        threading.Thread(target=orchestrate, args=(run,), daemon=True).start()
        return self.send_json({"run_id": run.id, "source": str(source),
                               "concurrency": run.concurrency, "mock": run.mock})

    def _lookup(self, query):
        """按 run_id 找运行；内存里没有就回退到磁盘。

        服务重启后 RUNS 是空的，但 data/runs/<run_id>/ 还在。没有这段回退，
        演示中途服务崩一次重启，页面④就再也拿不到已经跑完的报告了——
        结果明明还在磁盘上。回退出来的是只读壳子（done=True），够 /api/report
        和 /api/report.xlsx 用，进度事件不重建（那本来就是过去时）。"""
        run_id = (query.get("run_id") or [""])[0]
        if not run_id:
            return None
        with RUNS_LOCK:
            run = RUNS.get(run_id)
        if run is not None:
            return run
        run_dir = RUNS_ROOT / run_id
        # 只认规规矩矩的 id，挡掉 ../ 之类的路径穿越
        if not run_id.isalnum() or not (run_dir / "report" / "report.json").exists():
            return None
        recovered = Run(run_id=run_id, source=DEFAULT_SOURCE,
                        concurrency=DEFAULT_CONCURRENCY, mock=False)
        recovered.done = True
        recovered.finished_at = recovered.started_at
        with RUNS_LOCK:
            RUNS[run_id] = recovered
        return recovered

    def serve_static(self, path: str) -> None:
        rel = path.lstrip("/") or "index.html"
        target = (PROTOTYPE_DIR / rel).resolve()
        if not str(target).startswith(str(PROTOTYPE_DIR.resolve())) or not target.is_file():
            self.send_error(404)
            return
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="T10：运行时服务层")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--mock", action="store_true", help="用 Mock 模型跑，不调真实端点")
    parser.add_argument("--clean", action="store_true", help="启动前清空 data/runs/")
    args = parser.parse_args(argv)

    if args.clean and RUNS_ROOT.exists():
        shutil.rmtree(RUNS_ROOT)
    RUNS_ROOT.mkdir(parents=True, exist_ok=True)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.mock_mode = args.mock
    mode = "Mock 模型" if args.mock else "真实端点（需 AF_BASE_URL / AF_AGENT_ID / AF_API_KEY）"
    print(f"服务已启动：http://{args.host}:{args.port}/    模式：{mode}")
    print(f"投标文件目录：{DEFAULT_SOURCE}")
    print("  " + ("存在" if DEFAULT_SOURCE.exists() else "不存在——页面①点下一步会报错"))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    except Exception as exc:
        # 捕获并打印任何导致服务退出的隐藏异常，避免终端里「静默退出」
        print(f"\n服务异常退出：{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

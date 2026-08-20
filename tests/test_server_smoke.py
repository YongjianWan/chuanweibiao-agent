"""T10 服务层（src/server.py）冒烟测试。

不跑真实流水线（那需要 240 个 PDF 与模型端点），只守 HTTP 胶水层的
几条行为契约：

- /api/health 探活
- /api/run 的参数校验（source 不存在 → 400）
- /api/run 防重入（已有一条在跑 → 409 并给出 active_run_id）
- run_id 的磁盘回退（服务重启后仍能取到已跑完的报告）与路径穿越拦截
- 静态站点的路径穿越拦截

orchestrate 被 monkeypatch 成可控的假实现，测试在秒级完成。
"""

import http.client
import json
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, "src")
import server  # noqa: E402


@pytest.fixture()
def httpd(tmp_path, monkeypatch):
    """起一个真实 HTTP 服务（随机端口），RUNS_ROOT 指向临时目录。"""
    monkeypatch.setattr(server, "RUNS_ROOT", tmp_path)
    server.RUNS.clear()

    # 假 orchestrate：等放行事件，然后正常收场（done=True）。
    # release 由测试控制，用来模拟「运行进行中」的时间窗。
    release = threading.Event()

    def fake_orchestrate(run):
        run.dir.mkdir(parents=True, exist_ok=True)
        release.wait(timeout=10)
        run.done = True
        run.finished_at = run.started_at

    monkeypatch.setattr(server, "orchestrate", fake_orchestrate)

    from http.server import ThreadingHTTPServer

    srv = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    srv.mock_mode = True
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield srv, release
    release.set()
    srv.shutdown()
    srv.server_close()
    server.RUNS.clear()


def call(srv, method, path, body=None):
    conn = http.client.HTTPConnection("127.0.0.1", srv.server_port, timeout=5)
    payload = json.dumps(body) if body is not None else None
    headers = {"Content-Type": "application/json"} if body is not None else {}
    conn.request(method, path, body=payload, headers=headers)
    res = conn.getresponse()
    raw = res.read()
    conn.close()
    try:
        return res.status, json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return res.status, raw


def test_health(httpd):
    srv, _ = httpd
    status, data = call(srv, "GET", "/api/health")
    assert status == 200
    assert data["ok"] is True
    assert data["mock"] is True


def test_run_rejects_missing_source(httpd):
    srv, _ = httpd
    status, data = call(srv, "POST", "/api/run", {"source": "不存在的目录-xyz"})
    assert status == 400
    assert "不存在" in data["error"]


def test_run_rejects_second_run_while_active(httpd):
    """防重入：一条在跑时第二条必须 409，并带回 active_run_id 供前端接续。"""
    srv, release = httpd
    status, first = call(srv, "POST", "/api/run", {})
    assert status == 200
    assert first["run_id"]

    status, second = call(srv, "POST", "/api/run", {})
    assert status == 409
    assert second["active_run_id"] == first["run_id"]

    release.set()
    # 等假 orchestrate 收场后再发一条，应当放行
    for _ in range(50):
        if server.RUNS[first["run_id"]].done:
            break
        release.wait(0.05)
    status, third = call(srv, "POST", "/api/run", {})
    assert status == 200
    assert third["run_id"] != first["run_id"]


def test_report_disk_fallback_after_restart(httpd, tmp_path):
    """内存里没有的 run_id，磁盘上有完整报告时仍能取到（模拟服务重启）。"""
    srv, _ = httpd
    report = {"project": "测试项目", "matrix": [], "marker": "from-disk"}
    report_dir = tmp_path / "abc123" / "report"
    report_dir.mkdir(parents=True)
    (report_dir / "report.json").write_text(
        json.dumps(report, ensure_ascii=False), encoding="utf-8")

    status, data = call(srv, "GET", "/api/report?run_id=abc123")
    assert status == 200
    assert data["marker"] == "from-disk"


def test_lookup_rejects_path_traversal(httpd):
    srv, _ = httpd
    status, _ = call(srv, "GET", "/api/report?run_id=..")
    assert status == 404
    status, _ = call(srv, "GET", "/api/progress?run_id=../../etc")
    assert status == 404


def test_static_serves_prototype_and_blocks_traversal(httpd):
    srv, _ = httpd
    status, body = call(srv, "GET", "/")
    assert status == 200
    assert b"html" in body[:200].lower() or b"<!doctype" in body[:200].lower()

    status, _ = call(srv, "GET", "/../src/server.py")
    assert status == 404
    status, _ = call(srv, "GET", "/%2e%2e/%2e%2e/src/server.py")
    assert status == 404

#!/usr/bin/env python3
"""DVI 数据采集接收端 —— 本机静默接收用户脚本上报的数据。

用法：
    python dvi-capture-server.py            # 默认监听 127.0.0.1:8787
    python dvi-capture-server.py --port 9000

数据落盘位置（本目录下 captured/）：
    dvi-capture.jsonl    追加式原始记录，一行一条，我可直接读
    latest-self.json     最近一次角色快照（可读，便于快速查看）
    latest-offline.json  最近一次离线报告（可读）
    capture-log.txt      运行日志

只绑定 127.0.0.1，不对外网开放。
"""
import argparse
import json
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
OUT = HERE / "captured"
OUT.mkdir(exist_ok=True)

JSONL = OUT / "dvi-capture.jsonl"
LOG = OUT / "capture-log.txt"
SELF = OUT / "latest-self.json"
OFFLINE = OUT / "latest-offline.json"

MAX_BODY = 4 * 1024 * 1024
_stats = {"records": 0, "bytes": 0, "started": time.time()}


def log(msg):
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line, flush=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def handle_records(payload):
    """payload 可以是单条记录，也可以是 {records:[...]}"""
    if isinstance(payload, dict) and "records" in payload:
        records = payload["records"]
    elif isinstance(payload, list):
        records = payload
    else:
        records = [payload]

    accepted = 0
    with JSONL.open("a", encoding="utf-8") as f:
        for r in records:
            if not isinstance(r, dict):
                continue
            r.setdefault("receivedAt", datetime.now().isoformat(timespec="seconds"))
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
            accepted += 1

            kind = r.get("kind")
            if kind == "self":
                SELF.write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")
            elif kind == "offline":
                OFFLINE.write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")

    _stats["records"] += accepted
    return accepted


def summarise():
    """生成一份给人看的汇总"""
    if not JSONL.exists():
        return {"records": 0}
    kinds, chars, markets = {}, set(), 0
    offlines = []
    first = last = None
    with JSONL.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except Exception:
                continue
            k = r.get("kind", "?")
            kinds[k] = kinds.get(k, 0) + 1
            if r.get("character"):
                chars.add(r["character"])
            if k == "offline":
                offlines.append(r)
            if k == "market":
                markets += 1
            t = r.get("at") or r.get("receivedAt")
            if t:
                first = first or t
                last = t
    total_ticks = sum((o.get("offline") or {}).get("ticksElapsed", 0) for o in offlines)
    return {
        "records": sum(kinds.values()),
        "byKind": kinds,
        "characters": sorted(chars),
        "offlineReports": len(offlines),
        "offlineTicksTotal": total_ticks,
        "marketRecords": markets,
        "firstSeen": first,
        "lastSeen": last,
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, obj, extra=None):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")
        # Chrome 私有网络访问（HTTPS 页面 → localhost）预检要求
        self.send_header("Access-Control-Allow-Private-Network", "true")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        # 200 而非 204：带 body 的 204 属于非法响应，会让部分客户端/代理返回 502
        self._send(200, {"ok": True})

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/health", "/"):
            self._send(200, {
                "ok": True,
                "service": "dvi-capture",
                "uptimeSec": int(time.time() - _stats["started"]),
                "sessionRecords": _stats["records"],
                "outDir": str(OUT),
            })
        elif path == "/summary":
            self._send(200, summarise())
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/ingest":
            self._send(404, {"ok": False, "error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_BODY:
            self._send(400, {"ok": False, "error": "bad length"})
            return
        raw = self.rfile.read(n)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception as e:
            self._send(400, {"ok": False, "error": f"bad json: {e}"})
            return
        try:
            accepted = handle_records(payload)
        except Exception as e:
            log(f"写入失败: {e}")
            self._send(500, {"ok": False, "error": str(e)})
            return
        _stats["bytes"] += n
        log(f"收到 {accepted} 条记录（{n} 字节）")
        self._send(200, {"ok": True, "accepted": accepted})

    def log_message(self, fmt, *args):
        pass  # 静默，只写自己的日志


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()

    log(f"DVI 采集接收端启动 → http://{a.host}:{a.port}")
    log(f"数据目录：{OUT}")
    log("等待用户脚本上报…（保持本窗口开着）")
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log(f"停止。本次共接收 {_stats['records']} 条记录。")
        print("\n汇总：")
        print(json.dumps(summarise(), ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""本地开发服务器：静态托管 board-games 目录 + POST /api/jev 转发官方 Jev API。

用法：
    set TYPESAFE_API_KEY=ts-xxxx     (Windows)
    export TYPESAFE_API_KEY=ts-xxxx  (macOS/Linux)
    python dev-proxy.py [端口，默认 8788]

然后浏览器打开 http://localhost:8788 ，接入渠道选「同源代理」。
仅用 Python 标准库，无第三方依赖。
"""
import json
import os
import sys
import threading
import http.client
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = ("api.typesafe.ai", 443)
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)))

_conn_lock = threading.Lock()
_conn = None  # 持久 TLS 连接：省去每手棋的重复握手（实测省 ~0.45s）


def _upstream_call(key, payload):
    """通过持久连接转发请求；连接失效时重建并重试一次。"""
    global _conn
    body = json.dumps(payload)
    headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json",
               "Accept": "application/json"}
    with _conn_lock:
        for attempt in (0, 1):
            try:
                if _conn is None:
                    _conn = http.client.HTTPSConnection(*UPSTREAM, timeout=60)
                _conn.request("POST", "/v1/systemone", body=body, headers=headers)
                resp = _conn.getresponse()
                return resp.status, resp.read()
            except (http.client.HTTPException, OSError):
                _conn = None
                if attempt:
                    raise


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_POST(self):
        if self.path.rstrip("/").endswith("/api/jev"):
            self.handle_jev()
        else:
            self.send_error(404)

    def handle_jev(self):
        # BYOK：优先用请求头里访客自己的 key；环境变量仅作本机开发兜底
        key = self.headers.get("X-Api-Key") or os.environ.get("TYPESAFE_API_KEY", "")
        if not key:
            self.json_response(401, {"error": "未提供 API Key：请在页面设置中填写你的 TypeSafe key"})
            return
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            self.json_response(422, {"error": "invalid JSON body"})
            return
        payload = {
            "state": body.get("state"),
            "model": body.get("model", "jev-latest"),
            "questions": body.get("questions"),
        }
        try:
            status, data = _upstream_call(key, payload)
            self.json_response(status, json.loads(data.decode("utf-8")))
        except Exception as e:  # noqa: BLE001
            self.json_response(502, {"error": "upstream failed: %s" % e})

    def json_response(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):  # 精简日志
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
    print("serving %s at http://localhost:%d  (POST /api/jev -> TypeSafe)" % (ROOT, port))
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()

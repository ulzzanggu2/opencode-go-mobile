#!/usr/bin/env python3
"""에뮬레이터 검증용 mock 서버 — OpenCode Go의 OpenAI 호환 응답을 흉내낸다.
앱의 네이티브 SSE 브리지(OcStreamPlugin)가 실제로 델타를 흘려보내는지 확인하는 용도."""
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODELS = {
    "object": "list",
    "data": [
        {"id": "mock-model", "object": "model", "created": 0, "owned_by": "mock",
         "name": "모의 모델", "description": "에뮬레이터 테스트용", "type": "chat"},
        {"id": "mock-vision", "object": "model", "created": 0, "owned_by": "mock",
         "name": "모의 비전", "description": "이미지 지원", "type": "chat",
         "modalities": {"input": ["text", "image/png"], "output": ["text"]}},
    ],
}

ANSWER = "안녕하세요! 스트리밍 테스트입니다. 한 토큰씩 흘러가고 있습니다."


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print("[mock]", fmt % args, flush=True)

    def _json(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.endswith("/models"):
            self._json(MODELS)
        else:
            self._json({"ok": True})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            req = json.loads(raw or b"{}")
        except Exception:
            req = {}
        print("[mock] 요청 모델:", req.get("model"), "| stream:", req.get("stream"), flush=True)

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        for chunk in ANSWER.split(" "):
            payload = {
                "choices": [{"index": 0, "delta": {"content": chunk + " "}}],
                "model": req.get("model", "mock"),
            }
            self.wfile.write(b"data: " + json.dumps(payload, ensure_ascii=False).encode() + b"\n\n")
            self.wfile.flush()
            time.sleep(0.12)
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    print("mock SSE 서버: http://0.0.0.0:8788/v1", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8788), H).serve_forever()

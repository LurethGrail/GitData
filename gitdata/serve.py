"""Lokaler Dashboard-Server: JSON-API + statische Dateien, nur Standardbibliothek.

Bewusst http.server statt FastAPI: fuer ein lokales Single-User-Dashboard reicht
das. Die API-Grenze (/api/*) bleibt stabil; ein spaeterer Wechsel auf FastAPI
tauscht nur diese Datei.
"""
from __future__ import annotations

import json
import urllib.parse
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import analyze, db, ops

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MIME = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
        ".json": "application/json", ".svg": "image/svg+xml"}


class Handler(BaseHTTPRequestHandler):
    def __init__(self, *args, db_path=None, tokens=None, **kwargs):
        self.db_path = db_path
        self.tokens = tokens
        super().__init__(*args, **kwargs)

    def log_message(self, *args):
        pass  # ruhig bleiben

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _static(self, path: str):
        rel = path.lstrip("/") or "index.html"
        target = (WEB_DIR / rel).resolve()
        if WEB_DIR not in target.parents or not target.is_file():
            self.send_error(404)
            return
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = self.path.split("?")[0]
        # /api/ops oeffnet seine Verbindung selbst (gecacht) — nicht in den
        # conn-Block unten ziehen, sonst zahlt jeder Poll den Verbindungsaufbau.
        if route == "/api/ops":
            self._json(ops.snapshot(self.db_path, self.tokens))
            return
        if route == "/api/agent/log":
            q = urllib.parse.parse_qs(self.path.partition("?")[2])
            self._json(ops.tail_log(q.get("cmd", [""])[0], self.db_path,
                                    int(q.get("lines", ["120"])[0] or 120)))
            return
        if route == "/api/agent":       # Steuerung laeuft ueber POST
            self._json({"error": "POST benutzen"}, 405)
            return
        if route.startswith("/api/"):
            conn = db.connect(self.db_path)
            try:
                if route == "/api/summary":
                    self._json(analyze.summary(conn))
                elif route == "/api/graph":
                    self._json(analyze.graph(conn, min_shared=1))
                elif route == "/api/intel":
                    self._json(analyze.intel(conn))
                else:
                    self._json({"error": "unknown endpoint"}, 404)
            finally:
                conn.close()
        else:
            self._static(route)

    def do_POST(self):
        """Agents starten/stoppen. Nur lokal gebunden, nur Whitelist-Kommandos,
        Stop nur fuer verifizierte gitdata-PIDs (siehe ops.stop_agent)."""
        if self.path.split("?")[0] != "/api/agent":
            self._json({"error": "unknown endpoint"}, 404)
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            self._json({"ok": False, "err": "ungueltiges JSON"}, 400)
            return
        action = body.get("action")
        if action == "start":
            res = ops.start_agent(str(body.get("cmd", "")), self.db_path)
        elif action == "stop":
            try:
                res = ops.stop_agent(int(body.get("pid")))
            except (TypeError, ValueError):
                res = {"ok": False, "err": "pid fehlt"}
        else:
            res = {"ok": False, "err": "action muss start|stop sein"}
        self._json(res, 200 if res.get("ok") else 400)


def serve(db_path=db.DEFAULT_DB, host="127.0.0.1", port=8000, tokens=None) -> None:
    handler = partial(Handler, db_path=str(db_path), tokens=tokens)
    httpd = ThreadingHTTPServer((host, port), handler)
    print(f"GitData-Dashboard: http://{host}:{port}  (Strg+C zum Beenden)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nBeendet.")

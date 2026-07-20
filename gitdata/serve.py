"""Lokaler Dashboard-Server: JSON-API + statische Dateien, nur Standardbibliothek.

Bewusst http.server statt FastAPI: fuer ein lokales Single-User-Dashboard reicht
das. Die API-Grenze (/api/*) bleibt stabil; ein spaeterer Wechsel auf FastAPI
tauscht nur diese Datei.
"""
from __future__ import annotations

import json
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import analyze, db

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MIME = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
        ".json": "application/json", ".svg": "image/svg+xml"}


class Handler(BaseHTTPRequestHandler):
    def __init__(self, *args, db_path=None, **kwargs):
        self.db_path = db_path
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


def serve(db_path=db.DEFAULT_DB, host="127.0.0.1", port=8000) -> None:
    handler = partial(Handler, db_path=str(db_path))
    httpd = ThreadingHTTPServer((host, port), handler)
    print(f"GitData-Dashboard: http://{host}:{port}  (Strg+C zum Beenden)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nBeendet.")

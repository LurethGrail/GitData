"""GitHub-REST-Client auf Basis der Standardbibliothek.

Features, die fuer "Massenverarbeitung" zaehlen:
- konditionale Requests (ETag/Last-Modified): bei 304 spart man Download +
  Parsing der unveraenderten Antwort (Bandbreite/CPU). Hinweis: GitHubs REST-API
  zaehlt 304 empirisch DENNOCH aufs Rate-Limit (die Doku behauptet das Gegenteil,
  gemessen 2026 stimmt es nicht). Der echte Sparhebel liegt daher im Roh-Layer.
- Roh-Layer-Cache in SQLite: jede Antwort wird gespeichert -> Reprozessierung
  ohne erneuten API-Call.
- Pagination via Link-Header
- Rate-Limit-Handling: bei Erschoepfung sauber abbrechen statt haengen
- Secondary-Rate-Limit: Retry-After respektieren
"""
from __future__ import annotations

import json
import os
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API = "https://api.github.com"
USER_AGENT = "GitData-MVP/0.1 (+https://github.com/)"


def _ssl_context() -> ssl.SSLContext:
    """CA-Bundle finden — python.org-Python auf macOS hat oft keins installiert.

    Reihenfolge: certifi -> System-Bundle (/etc/ssl/cert.pem) -> OpenSSL-Default.
    """
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    for path in ("/etc/ssl/cert.pem", "/usr/local/etc/openssl/cert.pem"):
        if os.path.exists(path):
            return ssl.create_default_context(cafile=path)
    return ssl.create_default_context()


_SSL = _ssl_context()


class RateLimitExhausted(Exception):
    def __init__(self, reset_epoch: int):
        self.reset_epoch = reset_epoch
        wait = max(0, reset_epoch - int(time.time()))
        super().__init__(f"Rate-Limit erschoepft. Reset in {wait}s "
                         f"({datetime.fromtimestamp(reset_epoch).isoformat()}).")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_link_next(link_header: str | None) -> str | None:
    """Naechste Seite aus dem GitHub Link-Header ziehen, sonst None."""
    if not link_header:
        return None
    for part in link_header.split(","):
        segs = part.split(";")
        if len(segs) < 2:
            continue
        url = segs[0].strip().strip("<>")
        if any(s.strip() == 'rel="next"' for s in segs[1:]):
            return url
    return None


class _Slot:
    """Ein Token mit eigenem Rate-Budget. Jeder Token hat bei GitHub einen
    getrennten 5000/h-Topf, daher tracken wir remaining/reset pro Token."""
    __slots__ = ("value", "remaining", "reset")

    def __init__(self, value: str | None):
        self.value = value
        self.remaining: int | None = None   # None = noch unbekannt
        self.reset: int | None = None


class GitHubClient:
    def __init__(self, conn, token=None):
        # token: None (unauth) | str (ein Token) | list[str] (mehrere -> Round-Robin).
        if token is None:
            values = [None]
        elif isinstance(token, str):
            values = [token]
        else:
            values = list(token) or [None]
        self.conn = conn
        self.slots = [_Slot(v) for v in values]
        self._rr = 0
        self.requests_made = 0
        self._last_link: str | None = None

    @property
    def token_count(self) -> int:
        return sum(1 for s in self.slots if s.value)

    @property
    def total_remaining(self):
        known = [s.remaining for s in self.slots if s.remaining is not None]
        return sum(known) if known else None

    def _pick_slot(self) -> _Slot:
        """Naechsten Token mit Budget waehlen (Round-Robin). Sind alle leer,
        RateLimitExhausted mit der fruehesten Reset-Zeit."""
        n = len(self.slots)
        for i in range(n):
            s = self.slots[(self._rr + i) % n]
            if s.remaining is None or s.remaining > 0:
                self._rr = (self._rr + i + 1) % n
                return s
        resets = [s.reset for s in self.slots if s.reset]
        raise RateLimitExhausted(min(resets) if resets else int(time.time()) + 60)

    def _headers(self, cached_row, slot: _Slot) -> dict:
        h = {
            "Accept": "application/vnd.github+json",
            "User-Agent": USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if slot.value:
            h["Authorization"] = f"Bearer {slot.value}"
        if cached_row:
            if cached_row["etag"]:
                h["If-None-Match"] = cached_row["etag"]
            if cached_row["last_modified"]:
                h["If-Modified-Since"] = cached_row["last_modified"]
        return h

    def clear_rate_limit(self) -> None:
        """Nach dem Warten aufs Reset aufrufen, damit die naechsten Requests wieder feuern."""
        for s in self.slots:
            s.remaining = None
            s.reset = None

    def _track(self, slot: _Slot, headers) -> None:
        rem = headers.get("X-RateLimit-Remaining")
        rst = headers.get("X-RateLimit-Reset")
        if rem is not None:
            slot.remaining = int(rem)
        if rst is not None:
            slot.reset = int(rst)

    def _cache_get(self, url: str):
        return self.conn.execute(
            "SELECT etag, last_modified, body FROM http_cache WHERE url=?", (url,)
        ).fetchone()

    def _cache_put(self, url, etag, last_modified, status, body) -> None:
        self.conn.execute(
            "INSERT INTO http_cache(url, etag, last_modified, status, body, fetched_at) "
            "VALUES(?,?,?,?,?,?) ON CONFLICT(url) DO UPDATE SET "
            "etag=excluded.etag, last_modified=excluded.last_modified, "
            "status=excluded.status, body=excluded.body, fetched_at=excluded.fetched_at",
            (url, etag, last_modified, status, body, _now()),
        )
        self.conn.commit()

    def get(self, url: str, _retry: bool = True):
        """Eine URL holen. Gibt geparstes JSON zurueck oder None bei 404.

        Nutzt konditionale Requests: bei 304 kommt der Body aus dem Cache.
        Bei mehreren Tokens wird pro Request rotiert (_pick_slot).
        """
        slot = self._pick_slot()  # RateLimitExhausted, wenn alle Tokens leer
        cached = self._cache_get(url)
        req = urllib.request.Request(url, headers=self._headers(cached, slot))
        self.requests_made += 1  # jeder echte HTTP-Call zaehlt (auch 304/404)
        try:
            with urllib.request.urlopen(req, timeout=30, context=_SSL) as resp:
                self._track(slot, resp.headers)
                self._last_link = resp.headers.get("Link")
                body = resp.read().decode("utf-8")
                self._cache_put(url, resp.headers.get("ETag"),
                                resp.headers.get("Last-Modified"), resp.status, body)
                return json.loads(body) if body else None
        except urllib.error.HTTPError as e:
            self._track(slot, e.headers)
            self._last_link = e.headers.get("Link")
            if e.code == 304 and cached:
                return json.loads(cached["body"]) if cached["body"] else None
            # 404 geloescht/privat, 409 leeres Repo, 451 rechtlich gesperrt -> keine Daten.
            if e.code in (404, 409, 451):
                return None
            if e.code in (403, 429):
                if e.headers.get("X-RateLimit-Remaining") == "0":
                    slot.remaining = 0  # dieser Token ist leer
                    # Anderer Token noch mit Budget? Dann sofort mit dem weiter.
                    if _retry and any(s.remaining is None or s.remaining > 0
                                      for s in self.slots):
                        return self.get(url, _retry=False)
                    raise RateLimitExhausted(slot.reset or int(time.time()) + 60)
                # 403/429 ohne Primary-Limit: transientes Secondary-Limit von einem
                # dauerhaft verbotenen Repo unterscheiden (sonst 5x sinnlos retryen).
                retry_after = e.headers.get("Retry-After")
                body = ""
                try:
                    body = e.read().decode("utf-8", "replace")
                except Exception:
                    pass
                secondary = bool(retry_after) or "secondary rate limit" in body.lower()
                if secondary:
                    if _retry:
                        time.sleep(min(int(retry_after) if retry_after else 60, 120))
                        return self.get(url, _retry=False)
                    raise
                return None  # dauerhaft verboten -> wie 404 behandeln (keine Daten)
            raise

    def get_json(self, path: str, params: dict | None = None):
        url = f"{API}{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        return self.get(url)

    def get_paginated(self, path: str, params: dict | None = None, max_pages: int = 3):
        """Alle Elemente ueber Seiten hinweg (Link-Header). max_pages begrenzt Kosten."""
        url = f"{API}{path}"
        if params:
            url += "?" + urllib.parse.urlencode(params)
        pages = 0
        while url and pages < max_pages:
            data = self.get(url)
            if isinstance(data, list):
                yield from data
            url = parse_link_next(self._last_link)
            pages += 1

"""Betriebs-Telemetrie fuer das Ops-Dashboard.

Beantwortet drei Fragen, die man beim Zuschauen wirklich hat:
  1. Welche Agents laufen gerade?      -> Prozessliste (ps), mit Laufzeit
  2. Wie viel Token-Budget ist uebrig? -> GitHubs /rate_limit je Token
  3. Wie weit ist die Arbeit?          -> Zaehler aus der DB (Queue/Enum/Enrich)

Warum /rate_limit: der Endpunkt zaehlt selbst NICHT aufs Limit, liefert aber die
echten Restwerte aller Tokens — die In-Memory-Zaehler der Crawler-Prozesse sind
von aussen nicht sichtbar.

Alles gecacht (DB-Zaehler kurz, Rate-Limits laenger): das Dashboard pollt im
Sekundentakt, die 19-GB-DB soll das nicht spueren.
"""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from . import db
from .github import API, USER_AGENT, _SSL

_COUNT_TTL = 4.0      # DB-Zaehler
_RATE_TTL = 60.0      # Budget-Messung kostet einen echten Request -> sparsam
_cache: dict[str, tuple[float, object]] = {}
_refreshing: set[str] = set()
_lock = threading.Lock()


def _cached(key: str, ttl: float, produce):
    """Stale-while-revalidate: abgelaufene Werte werden sofort ausgeliefert und
    im Hintergrund erneuert. Sonst wartet jeder Poll auf die DB und das
    Dashboard ruckelt im Sekundentakt."""
    hit = _cache.get(key)
    now = time.time()
    if hit and now - hit[0] < ttl:
        return hit[1]
    if hit:
        with _lock:
            start = key not in _refreshing
            if start:
                _refreshing.add(key)
        if start:
            threading.Thread(target=_bg, args=(key, produce), daemon=True).start()
        return hit[1]                      # alter Wert, aber sofort
    val = produce()                        # allererster Aufruf: synchron
    _cache[key] = (time.time(), val)
    return val


def _bg(key: str, produce) -> None:
    try:
        val = produce()
        _cache[key] = (time.time(), val)
    except Exception:
        _cache[key] = (time.time(), _cache.get(key, (0, None))[1])
    finally:
        with _lock:
            _refreshing.discard(key)


# --------------------------------------------------------------------------- #
# Agents (Prozesse)
# --------------------------------------------------------------------------- #
_AGENT_RE = re.compile(r"-m\s+gitdata\s+([a-z]+)")
_ETIME_RE = re.compile(r"^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$")


def _etime_seconds(s: str) -> int:
    m = _ETIME_RE.match(s.strip())
    if not m:
        return 0
    d, h, mi, sec = (int(x) if x else 0 for x in m.groups())
    return ((d * 24 + h) * 60 + mi) * 60 + sec


def agents() -> list[dict]:
    """Laufende `python -m gitdata <cmd>`-Prozesse mit Laufzeit."""
    try:
        out = subprocess.run(["ps", "-Ao", "pid=,etime=,command="],
                             capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return []
    found = []
    for line in out.splitlines():
        m = _AGENT_RE.search(line)
        if not m:
            continue
        parts = line.split(None, 2)
        if len(parts) < 3:
            continue
        pid, etime, cmd = parts
        if "ps -Ao" in cmd:          # der eigene Aufruf
            continue
        found.append({"cmd": m.group(1), "pid": int(pid),
                      "uptime": _etime_seconds(etime)})
    found.sort(key=lambda a: a["cmd"])
    return found


# --------------------------------------------------------------------------- #
# Token-Budgets
# --------------------------------------------------------------------------- #
# WICHTIG: /rate_limit taugt hier NICHT als Budget-Anzeige. Der Endpunkt meldet
# das Kontingent pro Token — GitHub rechnet es aber pro ACCOUNT ab. Liegen alle
# Tokens auf einem Account, behauptet /rate_limit 20x5000 frei, waehrend real 0
# uebrig sind und jeder Request 403 bekommt. Deshalb messen wir mit einem echten
# (winzigen) Request und lesen die X-RateLimit-Header der Antwort.
_PROBE = "/repositories?since=0&per_page=1"
_ACCOUNT_RE = re.compile(r"user ID (\d+)")


def _hdrs(token):
    h = {"Accept": "application/vnd.github+json", "User-Agent": USER_AGENT,
         "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _probe(token, path=_PROBE):
    """-> (headers|None, http_code, body). Verbraucht 1 Request (403 bei
    erschoepftem Budget kostet nichts mehr)."""
    req = urllib.request.Request(API + path, headers=_hdrs(token))
    try:
        with urllib.request.urlopen(req, timeout=12, context=_SSL) as r:
            r.read(1)
            return r.headers, 200, ""
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:
            body = ""
        return e.headers, e.code, body
    except Exception as e:
        return None, 0, type(e).__name__


def _one_budget(tok) -> dict | None:
    h, code, body = _probe(tok)
    if h is None:
        return None

    def num(k, d=0):
        try:
            return int(h.get(k, d))
        except (TypeError, ValueError):
            return d
    remaining = num("X-RateLimit-Remaining")
    return {"limit": num("X-RateLimit-Limit"), "remaining": remaining,
            "reset": num("X-RateLimit-Reset"), "used": num("X-RateLimit-Used"),
            "ok": code == 200, "exhausted": code == 403 and remaining == 0,
            "err": None if code in (200, 403) else f"HTTP {code}"}


def real_budget(tokens, reps=None) -> dict:
    """Echtes Restbudget, gemessen an echten Requests.

    `reps` = je ein Token pro Account (aus token_accounts). Ohne die Angabe wird
    nur das erste gemessen — das stimmt nur, solange alle Tokens einem Account
    gehoeren. Mit Tokens aus mehreren Accounts addieren sich die Kontingente
    tatsaechlich, und genau dann muss je Account gemessen werden.
    """
    toks = list(reps) if reps else (list(tokens) or [None])[:1]
    parts = [b for b in (_one_budget(t) for t in toks) if b]
    if not parts:
        return {"limit": 0, "remaining": 0, "reset": 0, "used": 0, "ok": False,
                "exhausted": False, "err": "Netzfehler"}
    return {
        "limit": sum(p["limit"] for p in parts),
        "remaining": sum(p["remaining"] for p in parts),
        "used": sum(p["used"] for p in parts),
        "reset": min((p["reset"] for p in parts if p["reset"]), default=0),
        "ok": any(p["ok"] for p in parts),
        "exhausted": all(p["exhausted"] for p in parts),
        "err": next((p["err"] for p in parts if p["err"]), None),
        "accounts_measured": len(parts),
    }


def token_accounts(tokens) -> dict:
    """Auf wie viele GitHub-Accounts verteilen sich die Tokens? Entscheidend,
    weil sich Tokens desselben Accounts EIN Kontingent teilen — 20 Tokens auf
    einem Account sind 5.000/h, nicht 100.000/h. Einmal je Prozess ermittelt."""
    toks = list(tokens) if tokens else []
    if not toks:
        return {"tokens": 0, "accounts": 0, "shared": False}

    # Erfolg -> ID aus dem Body; 403 wegen Limit -> ID steht in der Fehlermeldung.
    def uid(t):
        req = urllib.request.Request(API + "/user", headers=_hdrs(t))
        try:
            with urllib.request.urlopen(req, timeout=12, context=_SSL) as r:
                return str(json.loads(r.read().decode()).get("id"))
        except urllib.error.HTTPError as e:
            try:
                m = _ACCOUNT_RE.search(e.read().decode("utf-8", "replace"))
            except Exception:
                m = None
            return m.group(1) if m else f"http{e.code}"
        except Exception as e:
            return type(e).__name__

    with ThreadPoolExecutor(max_workers=min(8, len(toks))) as ex:
        ids = list(ex.map(uid, toks))
    # Je Account ein Vertreter-Token — daran misst real_budget die Kontingente.
    reps: dict[str, str] = {}
    for acc, tok in zip(ids, toks):
        reps.setdefault(acc, tok)
    uniq = {i for i in ids if i.isdigit()}
    return {"tokens": len(toks), "accounts": len(uniq) or len(set(ids)),
            "shared": len(toks) > 1 and len(uniq) <= 1, "ids": sorted(uniq),
            "reps": list(reps.values())}


# --------------------------------------------------------------------------- #
# Fortschritt aus der DB
# --------------------------------------------------------------------------- #
def counts(db_path) -> dict:
    conn = db.connect(db_path)
    try:
        one = lambda sql: conn.execute(sql).fetchone()[0]  # noqa: E731
        # Queue-Zaehler in EINEM Lauf ueber den Covering-Index (detailed, id).
        # Einzelne COUNT(*)-WHERE-Abfragen mit `attempts` kosten auf 1,4 Mio
        # Repos ~3 s, weil sie je Zeile in die Tabelle greifen muessen.
        q = dict(conn.execute("SELECT detailed, COUNT(*) FROM repos GROUP BY detailed"))
        # Kern-Owner (Ziel der Anreicherung); "offen" wird abgeleitet statt per
        # NOT-IN-Subquery (die kostet auf 583k Ownern ~3 s).
        core = one("""SELECT COUNT(*) FROM (
                          SELECT owner_login AS login FROM repos WHERE detailed=1
                          UNION SELECT owner_login FROM contributions)
                      WHERE login NOT LIKE '%[bot]'""")
        enriched = one("SELECT COUNT(*) FROM owners WHERE enriched=1")
        return {
            "repos": {
                "total": sum(q.values()),
                "detailed": q.get(1, 0),
                "pending": q.get(0, 0),
                "inprogress": q.get(3, 0),
            },
            "enum": {
                "done": one("SELECT COUNT(*) FROM enum_chunks WHERE done=1"),
                "claimed": one("SELECT COUNT(*) FROM enum_chunks WHERE done=2"),
                "total": one("SELECT COUNT(*) FROM enum_chunks"),
            },
            "owners": {
                "total": one("SELECT COUNT(*) FROM owners"),
                "core": core,
                "enriched": enriched,
                "pending": max(0, core - enriched),
                "located": one("SELECT COUNT(*) FROM owners WHERE lat IS NOT NULL"),
            },
            "http_cache": one("SELECT COUNT(*) FROM http_cache"),
        }
    finally:
        conn.close()


def snapshot(db_path, tokens=None) -> dict:
    # Account-Zuordnung aendert sich nicht; einmal je Prozess reicht.
    acc = _cached("accounts", 10 ** 9, lambda: token_accounts(tokens))
    return {
        "ts": time.time(),
        **_cached("counts", _COUNT_TTL, lambda: counts(db_path)),
        "agents": _cached("agents", _COUNT_TTL, agents),
        # Ein Messrequest je Account und Minute — echte Zahlen sind das wert.
        "budget": _cached("budget", _RATE_TTL,
                          lambda: real_budget(tokens, acc.get("reps"))),
        "accounts": {k: v for k, v in acc.items() if k != "reps"},  # Tokens nicht ausliefern
        # Katalog fuer die Steuerung: das Frontend baut die Knoepfe daraus.
        "startable": [{"cmd": c, "desc": s["desc"], "dauer": s["dauer"]}
                      for c, s in STARTABLE.items()],
    }


# --------------------------------------------------------------------------- #
# Steuerung: Agents aus dem Dashboard starten/stoppen
# --------------------------------------------------------------------------- #
# Feste Whitelist statt freier Kommandozeile — der Endpunkt startet Prozesse,
# da wird nichts durchgereicht, was der Aufrufer bestimmen darf.
# "dauer": laeuft bis zum Stopp (Stop-Knopf sinnvoll) | sonst Ein-Schuss mit Log.
STARTABLE = {
    "run":       {"argv": ["run"], "dauer": True,
                  "desc": "Enumeration + Detail-Crawl (Dauerbetrieb)"},
    "discover":  {"argv": ["discover", "--pages", "20"], "dauer": False,
                  "desc": "Repo-Stubs enumerieren (20 Seiten)"},
    "detail":    {"argv": ["detail", "--limit", "500"], "dauer": False,
                  "desc": "500 offene Repos anreichern"},
    "crawl":     {"argv": ["crawl"], "dauer": False,
                  "desc": "Seed-Repos aus seeds.json crawlen"},
    "enrich":    {"argv": ["enrich"], "dauer": True,
                  "desc": "Owner-Profile holen + geocoden"},
    "analyze":   {"argv": ["analyze"], "dauer": False, "desc": "Text-Report der Auswertung"},
    "status":    {"argv": ["status"], "dauer": False, "desc": "Crawl-Fortschritt"},
    "selfcheck": {"argv": ["selfcheck"], "dauer": False, "desc": "Interne Tests"},
}
# monitor/serve fehlen bewusst: `monitor` ist eine Konsolen-Dauerschleife ohne
# Nutzen im Log, `serve` ist dieser Prozess selbst.


def _log_path(cmd: str, db_path) -> Path:
    return Path(db_path).parent / f"{'crawler' if cmd == 'run' else cmd}.log"


def tail_log(cmd: str, db_path, lines: int = 120) -> dict:
    """Letzte Zeilen des Agent-Logs — damit Ein-Schuss-Kommandos wie `analyze`
    oder `status` im Dashboard auch ein Ergebnis zeigen, nicht nur ein Exit."""
    if cmd not in STARTABLE:
        return {"ok": False, "err": f"unbekannter Agent: {cmd}"}
    p = _log_path(cmd, db_path)
    if not p.exists():
        return {"ok": True, "cmd": cmd, "text": "(noch kein Log — Agent nie gestartet)",
                "running": False}
    try:
        with open(p, "rb") as fh:            # nur das Ende lesen, Logs werden gross
            fh.seek(0, 2)
            fh.seek(max(0, fh.tell() - 64_000))
            text = fh.read().decode("utf-8", "replace")
    except OSError as e:
        return {"ok": False, "err": str(e)}
    return {"ok": True, "cmd": cmd, "running": any(a["cmd"] == cmd for a in agents()),
            "text": "\n".join(text.splitlines()[-lines:])}


def start_agent(cmd: str, db_path) -> dict:
    spec = STARTABLE.get(cmd)
    if not spec:
        return {"ok": False, "err": f"unbekannter Agent: {cmd}"}
    if any(a["cmd"] == cmd for a in agents()):
        return {"ok": False, "err": f"{cmd} laeuft bereits"}
    log = _log_path(cmd, db_path)
    log.parent.mkdir(parents=True, exist_ok=True)
    argv = [sys.executable, "-u", "-m", "gitdata", *spec["argv"]]
    with open(log, "a") as fh:
        p = subprocess.Popen(argv, stdout=fh, stderr=subprocess.STDOUT,
                             stdin=subprocess.DEVNULL,
                             start_new_session=True,   # ueberlebt das Dashboard
                             cwd=str(Path(__file__).resolve().parent.parent))
    _cache.pop("agents", None)                          # Liste sofort auffrischen
    return {"ok": True, "cmd": cmd, "pid": p.pid, "log": str(log)}


def stop_agent(pid: int) -> dict:
    """Nur PIDs beenden, die wirklich ein gitdata-Agent sind — eine PID aus dem
    Browser ist sonst ein Freifahrtschein auf jeden Prozess des Nutzers."""
    match = next((a for a in agents() if a["pid"] == pid), None)
    if not match:
        return {"ok": False, "err": f"pid {pid} ist kein laufender gitdata-Agent"}
    if match["cmd"] == "serve":
        return {"ok": False, "err": "das Dashboard kann sich nicht selbst beenden"}
    try:
        os.kill(pid, signal.SIGTERM)      # Daemon faengt SIGTERM und raeumt auf
    except ProcessLookupError:
        return {"ok": False, "err": "Prozess bereits beendet"}
    except PermissionError:
        return {"ok": False, "err": "keine Berechtigung"}
    _cache.pop("agents", None)
    return {"ok": True, "cmd": match["cmd"], "pid": pid}


def demo() -> None:
    assert _etime_seconds("00:42") == 42
    assert _etime_seconds("01:00:00") == 3600
    assert _etime_seconds("01-01:38:10") == 24 * 3600 + 5890, _etime_seconds("01-01:38:10")
    assert _etime_seconds("garbage") == 0
    assert _AGENT_RE.search("Python -u -m gitdata run").group(1) == "run"
    assert _AGENT_RE.search("ps -Ao pid=,command=") is None
    # Steuerung: nur Whitelist starten, fremde PIDs nicht anfassen.
    assert start_agent("rm -rf /", "data/x.db")["ok"] is False
    assert stop_agent(1)["ok"] is False, "PID 1 ist kein gitdata-Agent"
    assert _ACCOUNT_RE.search("API rate limit exceeded for user ID 226175479.").group(1) \
        == "226175479"
    print("ops.demo ok")


if __name__ == "__main__":
    demo()

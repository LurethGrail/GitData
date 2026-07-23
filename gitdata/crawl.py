"""Ingestion.

Zwei Betriebsarten:
1. Seed-Crawl (`crawl`): gezielte Repo-Liste aus seeds.json — wie gehabt.
2. Mass-Crawl (`discover`/`detail`/`run`): ganz GitHub. Enumeration ueber
   /repositories?since=<id> entdeckt jedes oeffentliche Repo (Cursor in
   crawl_state, absturzsicher). Die repos-Tabelle IST die Work-Queue:
   detailed=0 = zu holen. Der Daemon `run` schlaeft bei Rate-Limit bis zum
   Reset und stoppt sauber auf SIGINT/SIGTERM.

Alles idempotent (Upserts). Roh-JSON jeder Antwort liegt im http_cache -> alle
Metadaten bleiben vollstaendig erhalten, unabhaengig vom normalisierten Schema.
"""
from __future__ import annotations

import json
import signal
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from . import db, geo
from .github import GitHubClient, RateLimitExhausted

SEEDS_FILE = Path(__file__).resolve().parent.parent / "seeds.json"


def load_seeds(path: str | Path = SEEDS_FILE) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def upsert_owner(conn, o: dict, enriched: int = 0) -> None:
    conn.execute(
        """INSERT INTO owners(id, login, type, name, company, location, blog, bio,
                              followers, following, public_repos, html_url, created_at,
                              enriched, fetched_at)
           VALUES(:id,:login,:type,:name,:company,:location,:blog,:bio,:followers,
                  :following,:public_repos,:html_url,:created_at,:enriched,:fetched_at)
           ON CONFLICT(id) DO UPDATE SET
             login=excluded.login, type=excluded.type,
             name=COALESCE(excluded.name, owners.name),
             company=COALESCE(excluded.company, owners.company),
             location=COALESCE(excluded.location, owners.location),
             blog=COALESCE(excluded.blog, owners.blog),
             bio=COALESCE(excluded.bio, owners.bio),
             followers=COALESCE(excluded.followers, owners.followers),
             following=COALESCE(excluded.following, owners.following),
             public_repos=COALESCE(excluded.public_repos, owners.public_repos),
             html_url=excluded.html_url, created_at=excluded.created_at,
             enriched=MAX(owners.enriched, excluded.enriched),
             fetched_at=excluded.fetched_at""",
        {
            "id": o["id"], "login": o["login"], "type": o.get("type"),
            "name": o.get("name"), "company": o.get("company"),
            "location": o.get("location"), "blog": o.get("blog"), "bio": o.get("bio"),
            "followers": o.get("followers"), "following": o.get("following"),
            "public_repos": o.get("public_repos"), "html_url": o.get("html_url"),
            "created_at": o.get("created_at"), "enriched": enriched,
            "fetched_at": _now(),
        },
    )


def upsert_repo(conn, r: dict) -> None:
    lic = (r.get("license") or {})
    conn.execute(
        """INSERT INTO repos(id, full_name, owner_login, name, description, homepage,
              primary_language, license, stars, forks, watchers, open_issues, size,
              is_fork, archived, created_at, updated_at, pushed_at, fetched_at,
              parent_id, source_id)
           VALUES(:id,:full_name,:owner_login,:name,:description,:homepage,
              :primary_language,:license,:stars,:forks,:watchers,:open_issues,:size,
              :is_fork,:archived,:created_at,:updated_at,:pushed_at,:fetched_at,
              :parent_id,:source_id)
           ON CONFLICT(id) DO UPDATE SET
             full_name=excluded.full_name, owner_login=excluded.owner_login,
             name=excluded.name, description=excluded.description,
             homepage=excluded.homepage, primary_language=excluded.primary_language,
             license=excluded.license, stars=excluded.stars, forks=excluded.forks,
             watchers=excluded.watchers, open_issues=excluded.open_issues,
             size=excluded.size, is_fork=excluded.is_fork, archived=excluded.archived,
             updated_at=excluded.updated_at, pushed_at=excluded.pushed_at,
             fetched_at=excluded.fetched_at,
             parent_id=COALESCE(excluded.parent_id, repos.parent_id),
             source_id=COALESCE(excluded.source_id, repos.source_id)""",
        {
            "id": r["id"], "full_name": r["full_name"],
            "owner_login": r["owner"]["login"], "name": r.get("name"),
            "description": r.get("description"), "homepage": r.get("homepage"),
            "primary_language": r.get("language"),
            "license": lic.get("spdx_id"), "stars": r.get("stargazers_count"),
            "forks": r.get("forks_count"), "watchers": r.get("subscribers_count"),
            "open_issues": r.get("open_issues_count"), "size": r.get("size"),
            "is_fork": int(bool(r.get("fork"))), "archived": int(bool(r.get("archived"))),
            "created_at": r.get("created_at"), "updated_at": r.get("updated_at"),
            "pushed_at": r.get("pushed_at"), "fetched_at": _now(),
            "parent_id": (r.get("parent") or {}).get("id"),
            "source_id": (r.get("source") or {}).get("id"),
        },
    )
    # Topics (many-to-many): erst leeren, dann neu setzen.
    conn.execute("DELETE FROM repo_topics WHERE repo_id=?", (r["id"],))
    for t in r.get("topics", []) or []:
        conn.execute("INSERT OR IGNORE INTO repo_topics(repo_id, topic) VALUES(?,?)",
                     (r["id"], t))


def crawl_repo(client: GitHubClient, full_name: str, contrib_pages: int = 1,
               log: bool = True) -> bool:
    """Ein Repo samt Sprachen und Contributors holen. False = uebersprungen (404)."""
    conn = client.conn
    r = client.get_json(f"/repos/{full_name}")
    if not r:
        if log:
            print(f"  ! {full_name}: nicht gefunden (404/409/451)")
        return False
    upsert_owner(conn, r["owner"], enriched=0)
    upsert_repo(conn, r)

    langs = client.get_json(f"/repos/{full_name}/languages") or {}
    conn.execute("DELETE FROM repo_languages WHERE repo_id=?", (r["id"],))
    for lang, nbytes in langs.items():
        conn.execute(
            "INSERT OR REPLACE INTO repo_languages(repo_id, language, bytes) VALUES(?,?,?)",
            (r["id"], lang, nbytes),
        )

    conn.execute("DELETE FROM contributions WHERE repo_id=?", (r["id"],))
    for c in client.get_paginated(f"/repos/{full_name}/contributors",
                                  {"per_page": 100}, max_pages=contrib_pages):
        if not isinstance(c, dict) or not c.get("login"):
            continue
        conn.execute(
            "INSERT OR REPLACE INTO contributions(repo_id, owner_login, contributions) "
            "VALUES(?,?,?)", (r["id"], c["login"], c.get("contributions", 0)),
        )
        # Contributor als (noch nicht angereicherten) Owner mitfuehren.
        upsert_owner(conn, {"id": c["id"], "login": c["login"], "type": c.get("type"),
                            "html_url": c.get("html_url")}, enriched=0)

    _fetch_releases(client, conn, full_name, r["id"])
    _fetch_dependencies(client, conn, full_name, r["id"])
    conn.commit()
    if log:
        stars = r.get("stargazers_count")
        print(f"  + {full_name}: {stars}★, {len(langs)} Sprachen")
    return True


def _fetch_releases(client: GitHubClient, conn, full_name: str, rid: int) -> None:
    """Releases (neueste 100): Tag + Author (Person<->Repo-Kante) + Datum."""
    rels = client.get_json(f"/repos/{full_name}/releases", {"per_page": 100}) or []
    conn.execute("DELETE FROM releases WHERE repo_id=?", (rid,))
    for rel in rels:
        if not isinstance(rel, dict):
            continue
        tag = rel.get("tag_name") or f"_id{rel.get('id')}"
        conn.execute(
            "INSERT OR REPLACE INTO releases(repo_id, tag, name, author_login, published_at) "
            "VALUES(?,?,?,?,?)",
            (rid, tag, rel.get("name"), (rel.get("author") or {}).get("login"),
             rel.get("published_at")))


def _purl_ecosystem(pkg: dict) -> str | None:
    for ref in pkg.get("externalRefs", []) or []:
        loc = ref.get("referenceLocator", "")
        if loc.startswith("pkg:"):
            return loc[4:].split("/", 1)[0]  # z.B. pkg:pypi/numpy -> "pypi"
    return None


def _fetch_dependencies(client: GitHubClient, conn, full_name: str, rid: int) -> None:
    """Abhaengigkeiten aus dem SBOM: Repo -> Paket (das Kern-Relationsnetz)."""
    sbom = client.get_json(f"/repos/{full_name}/dependency-graph/sbom")
    conn.execute("DELETE FROM dependencies WHERE repo_id=?", (rid,))
    if not sbom:
        return
    root = f"com.github.{full_name}".lower()
    for p in ((sbom.get("sbom") or {}).get("packages") or []):
        name = p.get("name")
        if not name or name.lower() == root:      # Selbstreferenz (Repo) ueberspringen
            continue
        conn.execute(
            "INSERT OR IGNORE INTO dependencies(repo_id, package, version, ecosystem) "
            "VALUES(?,?,?,?)", (rid, name, p.get("versionInfo"), _purl_ecosystem(p)))


def list_owner_repos(client: GitHubClient, login: str, max_pages: int = 2) -> list[str]:
    repos = []
    for r in client.get_paginated(f"/users/{login}/repos",
                                   {"per_page": 100, "sort": "pushed"}, max_pages):
        if isinstance(r, dict) and not r.get("fork"):
            repos.append(r["full_name"])
    return repos


# ---------------------------------------------------------------------------
# Owner-Anreicherung + Geo. Der Massen-Crawl holt nur eingebettete Owner-Basics
# (id/login/type) — Location steckt erst im vollen /users/{login}-Profil. `enrich`
# holt die Profile der Kern-Owner (detaillierte Repos + deren Contributors) und
# leitet Land/Stadt offline aus geo.py ab. Das speist die Weltansicht.
# ---------------------------------------------------------------------------
def _enrich_worklist(conn) -> list[str]:
    """Kern-Owner-Logins ohne volles Profil, Repo-Owner zuerst (jedes detaillierte
    Repo bekommt so ein Land), dann Contributors. Bots raus."""
    rows = conn.execute(
        """SELECT login, MIN(rank) AS r FROM (
               SELECT owner_login AS login, 0 AS rank FROM repos WHERE detailed=1
               UNION ALL
               SELECT owner_login AS login, 1 AS rank FROM contributions
           )
           WHERE login NOT LIKE '%[bot]'
             AND login IN (SELECT login FROM owners WHERE enriched=0)
           GROUP BY login ORDER BY r""").fetchall()
    return [r[0] for r in rows]


def geocode_owner(conn, login: str, location: str | None) -> bool:
    hit = geo.geocode(location)
    if hit:
        country, city, lat, lon = hit
        conn.execute(
            "UPDATE owners SET country=?, city=?, lat=?, lon=?, geo_tried=1 WHERE login=?",
            (country, city, lat, lon, login))
        return True
    conn.execute("UPDATE owners SET geo_tried=1 WHERE login=?", (login,))
    return False


def geocode_pending(conn) -> int:
    """Offline-Nachlese: owners mit Location aber noch ohne Geo verorten. Frei —
    nach jedem geo.py-Update erneut sinnvoll (geo_tried dann zuruecksetzen)."""
    rows = conn.execute(
        "SELECT login, location FROM owners "
        "WHERE geo_tried=0 AND location IS NOT NULL AND location!=''").fetchall()
    n = sum(geocode_owner(conn, login, loc) for login, loc in rows)
    conn.commit()
    return n


def enrich(db_path=db.DEFAULT_DB, token: str | None = None,
           limit: int | None = None, log: bool = True) -> tuple[int, int]:
    """Kern-Owner-Profile holen (Location) und verorten. Idempotent, resumebar:
    404 und Treffer werden markiert, ein zweiter Lauf ueberspringt sie."""
    conn = db.connect(db_path)
    db.init_schema(conn)
    client = GitHubClient(conn, token=token)
    logins = _enrich_worklist(conn)
    if limit:
        logins = logins[:limit]
    total = len(logins)
    if log:
        print(f"enrich: {total} Kern-Owner ohne Profil "
              f"({client.token_count} Token).")
    fetched = located = skipped = 0
    try:
        for login in logins:
            try:
                u = client.get_json(f"/users/{login}")
            except RateLimitExhausted:
                raise                      # sauber stoppen, Fortschritt bleibt
            except Exception as e:
                # Transient (RemoteDisconnected/Timeout/SSL): einmal kurz warten,
                # dann ueberspringen — der naechste Lauf holt den Login nach.
                skipped += 1
                time.sleep(2)
                try:
                    u = client.get_json(f"/users/{login}")
                except RateLimitExhausted:
                    raise
                except Exception:
                    if log and skipped % 25 == 1:
                        print(f"  ! Netzfehler bei @{login}: {type(e).__name__} — übersprungen")
                    continue
            if not u:  # 404/gesperrt -> nicht erneut versuchen
                conn.execute(
                    "UPDATE owners SET enriched=1, geo_tried=1 WHERE login=?", (login,))
                conn.commit()
                continue
            upsert_owner(conn, u, enriched=1)
            if geocode_owner(conn, login, u.get("location")):
                located += 1
            conn.commit()
            fetched += 1
            if log and fetched % 100 == 0:
                print(f"  … {fetched}/{total} Profile · {located} verortet · "
                      f"Rate-Rest {client.total_remaining}")
    except RateLimitExhausted as e:
        print(f"  Rate-Limit erreicht, Fortschritt gespeichert: {e}")
    located += geocode_pending(conn)  # evtl. schon vorher enrichte Owner mitnehmen
    if log:
        tail = f", {skipped} übersprungen (nächster Lauf holt sie)" if skipped else ""
        print(f"enrich fertig: {fetched} Profile geholt, {located} verortet{tail}.")
    conn.close()
    return fetched, located


def crawl(db_path=db.DEFAULT_DB, seeds_path=SEEDS_FILE, token: str | None = None,
          contrib_pages: int = 1) -> None:
    conn = db.connect(db_path)
    db.init_schema(conn)
    client = GitHubClient(conn, token=token)
    seeds = load_seeds(seeds_path)

    targets = list(seeds.get("repos", []))
    for login in seeds.get("orgs", []) + seeds.get("users", []):
        print(f"Liste Repos von @{login} ...")
        try:
            targets += list_owner_repos(client, login)
        except RateLimitExhausted as e:
            print(f"\nGestoppt: {e}")
            _report(client)
            return

    seen = set()
    print(f"\nCrawle {len(targets)} Repos (Token: {'ja' if token else 'nein, 60/h'}) ...")
    for full_name in targets:
        if full_name in seen:
            continue
        seen.add(full_name)
        try:
            crawl_repo(client, full_name, contrib_pages=contrib_pages)
        except RateLimitExhausted as e:
            print(f"\nGestoppt bei {full_name}: {e}")
            print("Fortschritt ist gespeichert. Nach dem Reset erneut ausfuehren, "
                  "bereits geholte Repos werden uebersprungen bzw. revalidiert.")
            break
    _report(client)


def _report(client: GitHubClient) -> None:
    conn = client.conn
    n_repos = conn.execute("SELECT COUNT(*) FROM repos").fetchone()[0]
    n_owners = conn.execute("SELECT COUNT(*) FROM owners").fetchone()[0]
    n_contrib = conn.execute("SELECT COUNT(*) FROM contributions").fetchone()[0]
    print(f"\nStand: {n_repos} Repos, {n_owners} Owner/Contributors, "
          f"{n_contrib} Contributions. API-Calls: {client.requests_made}, "
          f"Rate-Limit-Rest: {client.total_remaining}")


# ---------------------------------------------------------------------------
# Mass-Crawl: Enumeration (discover) + Anreicherung (detail) + Daemon (run)
# ---------------------------------------------------------------------------

def get_state(conn, key: str, default=None):
    row = conn.execute("SELECT value FROM crawl_state WHERE key=?", (key,)).fetchone()
    return row[0] if row else default


def set_state(conn, key: str, value) -> None:
    conn.execute("INSERT INTO crawl_state(key, value) VALUES(?,?) "
                 "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))


def upsert_repo_stub(conn, r: dict) -> None:
    """Minimalen Repo-Datensatz aus der Enumeration ablegen. Bestehende (evtl.
    schon detaillierte) Repos werden NICHT ueberschrieben (DO NOTHING)."""
    conn.execute(
        """INSERT INTO repos(id, full_name, owner_login, name, description, is_fork,
                             detailed, discovered_at)
           VALUES(?,?,?,?,?,?,0,?) ON CONFLICT(id) DO NOTHING""",
        (r["id"], r["full_name"], r["owner"]["login"], r.get("name"),
         r.get("description"), int(bool(r.get("fork"))), _now()))
    upsert_owner(conn, r["owner"], enriched=0)


def discover_repos(client: GitHubClient, pages: int = 1, per_page: int = 100) -> int:
    """`pages` Seiten der globalen Repo-Enumeration holen. Cursor wird persistiert."""
    conn = client.conn
    since = int(get_state(conn, "repos_since", "0"))
    added = 0
    for _ in range(pages):
        batch = client.get_json("/repositories", {"since": since, "per_page": per_page})
        if not batch:
            break
        for r in batch:
            upsert_repo_stub(conn, r)
            since = max(since, r["id"])
            added += 1
        set_state(conn, "repos_since", since)
        conn.commit()
    return added


# --- Parallele Enumeration ------------------------------------------------
# Der Repo-ID-Raum wird in feste Chunks zerlegt, die Worker atomar beanspruchen.
# Feinkoernig -> Dichteunterschiede (alte IDs duenn, neue dicht) mitteln sich aus,
# jeder Chunk ist einzeln resume-bar. Chunk deckt IDs in (start, start+CHUNK_SIZE].
CHUNK_SIZE = 1_000_000
MAX_ID_BOUND = 2_000_000_000   # grosszuegig ueber GitHubs aktueller max Repo-ID


def init_chunks(conn) -> None:
    """enum_chunks einmalig mit allen Start-IDs befuellen (idempotent)."""
    if conn.execute("SELECT 1 FROM enum_chunks LIMIT 1").fetchone():
        return
    conn.executemany("INSERT OR IGNORE INTO enum_chunks(start, done) VALUES(?,0)",
                     [(s,) for s in range(0, MAX_ID_BOUND, CHUNK_SIZE)])
    conn.commit()


def enum_open(conn) -> int:
    """Anzahl noch nicht fertiger Enumerations-Chunks (done != 1)."""
    return conn.execute("SELECT COUNT(*) FROM enum_chunks WHERE done<>1").fetchone()[0]


def _claim_chunk(conn):
    """Atomar den naechsten offenen Chunk beanspruchen (done 0 -> 2)."""
    row = conn.execute(
        "UPDATE enum_chunks SET done=2 WHERE start = "
        "(SELECT start FROM enum_chunks WHERE done=0 ORDER BY start LIMIT 1) "
        "RETURNING start").fetchone()
    conn.commit()
    return row["start"] if row else None


def _set_chunk(conn, start: int, done: int) -> None:
    conn.execute("UPDATE enum_chunks SET done=? WHERE start=?", (done, start))
    conn.commit()


def _walk_chunk(client: GitHubClient, start: int, stop=lambda: False) -> int:
    """IDs in (start, start+CHUNK_SIZE] enumerieren, Stubs ablegen. `since` ist
    exklusiv -> keine Luecken an Chunk-Grenzen. Unterbrechbar: bei stop() bleibt
    der Chunk offen (done=0) fuer spaeter; bei RateLimitExhausted propagiert die
    Ausnahme (der Worker gibt den Chunk frei). Nur bei vollstaendigem Walk done=1."""
    conn = client.conn
    end = start + CHUNK_SIZE
    since = start
    found = 0
    while not stop():
        batch = client.get_json("/repositories", {"since": since, "per_page": 100})
        if not batch:
            _set_chunk(conn, start, 1)          # Ende von GitHub erreicht -> fertig
            return found
        over = False
        for r in batch:
            if r["id"] > end:
                over = True
                break
            upsert_repo_stub(conn, r)
            found += 1
        conn.commit()
        if over or len(batch) < 100:
            _set_chunk(conn, start, 1)          # Chunk-Grenze erreicht -> fertig
            return found
        since = batch[-1]["id"]
    _set_chunk(conn, start, 0)                  # per stop unterbrochen -> wieder offen
    return found


def count_pending(conn) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM repos WHERE detailed=0 AND attempts < 5").fetchone()[0]


def _detail_inprogress(conn) -> int:
    return conn.execute("SELECT COUNT(*) FROM repos WHERE detailed=3").fetchone()[0]


def detail_pending(client: GitHubClient, limit: int = 50,
                   stop=lambda: False, log: bool = False) -> int:
    """Bis zu `limit` offene Repos anreichern (single-threaded, fuer den
    `detail`-CLI-Befehl). Der Daemon `run` nutzt stattdessen den Thread-Pool."""
    conn = client.conn
    rows = conn.execute(
        "SELECT id, full_name FROM repos WHERE detailed=0 AND attempts < 5 "
        "ORDER BY id LIMIT ?", (limit,)).fetchall()
    done = 0
    for row in rows:
        if stop():
            break
        try:
            crawl_repo(client, row["full_name"], contrib_pages=1, log=log)
            conn.execute("UPDATE repos SET detailed=1 WHERE id=?", (row["id"],))
            conn.commit()
            done += 1
        except RateLimitExhausted:
            raise
        except Exception as e:  # transient (Netzwerk/5xx): Versuch zaehlen, weiter
            conn.execute("UPDATE repos SET attempts=attempts+1 WHERE id=?", (row["id"],))
            conn.commit()
            print(f"  ! {row['full_name']}: {type(e).__name__}: {e}")
    return done


def _install_signals() -> threading.Event:
    """SIGINT/SIGTERM -> Event setzen. Worker koennen dasselbe Event setzen, um alle
    zu stoppen. Signale werden nur im Main-Thread zugestellt."""
    ev = threading.Event()

    def handler(signum, frame):
        ev.set()
        print(f"\nSignal {signum} empfangen — stoppe nach aktuellem Repo ...")
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, handler)
    return ev


def _sleep_until(epoch: int, stop, buffer: int = 3) -> None:
    """Unterbrechbar bis `epoch`+buffer schlafen (in kleinen Schritten, stop-aware)."""
    wake = epoch + buffer
    while not stop():
        left = wake - time.time()
        if left <= 0:
            return
        time.sleep(min(5.0, left))


class _Progress:
    """Gemeinsamer, thread-sicherer Fortschrittszaehler ueber alle Worker."""
    def __init__(self):
        self.done = 0        # detaillierte Repos
        self.enum = 0        # fertige Enumerations-Chunks
        self.t0 = time.time()
        self.lock = threading.Lock()

    def tick(self) -> int:
        with self.lock:
            self.done += 1
            return self.done

    def enum_tick(self) -> int:
        with self.lock:
            self.enum += 1
            return self.enum


def _claim_one(conn):
    """Atomar ein offenes Repo beanspruchen (detailed 0 -> 3), race-frei ueber
    mehrere Worker dank UPDATE ... RETURNING. None, wenn die Queue leer ist."""
    row = conn.execute(
        "UPDATE repos SET detailed=3 WHERE id = "
        "(SELECT id FROM repos WHERE detailed=0 AND attempts<5 ORDER BY id LIMIT 1) "
        "RETURNING id, full_name").fetchone()
    conn.commit()
    return (row["id"], row["full_name"]) if row else None


def _detail_one(client: GitHubClient, conn, rid: int, full: str) -> None:
    """Beanspruchtes Repo anreichern. detailed=1 bei Erfolg, sonst zurueck auf 0
    (+attempts). RateLimitExhausted wird zum Warten durchgereicht."""
    try:
        crawl_repo(client, full, contrib_pages=1, log=False)
        conn.execute("UPDATE repos SET detailed=1 WHERE id=?", (rid,))
        conn.commit()
    except RateLimitExhausted:
        conn.execute("UPDATE repos SET detailed=0 WHERE id=?", (rid,))  # zurueck in Queue
        conn.commit()
        raise
    except Exception as e:  # transient -> Versuch zaehlen, Repo wieder freigeben
        # Eine belegte DB ist nicht die Schuld des Repos: wuerde sie als Fehlversuch
        # zaehlen, waeren nach 5 Sperrkonflikten kerngesunde Repos als Poison-Pill
        # aussortiert. Nur echte Hol-Fehler erhoehen attempts.
        locked = isinstance(e, sqlite3.OperationalError) and "locked" in str(e).lower()
        bump = "" if locked else ", attempts=attempts+1"
        try:
            conn.execute(f"UPDATE repos SET detailed=0{bump} WHERE id=?", (rid,))
            conn.commit()
        except sqlite3.OperationalError:
            pass          # Claim faellt beim naechsten Start ueber Crash-Recovery zurueck
        if not locked:
            print(f"  ! {full}: {type(e).__name__}: {e}")


def _worker(idx: int, token, db_path, stop_ev: threading.Event, prog: _Progress,
            max_details, skip_enum: bool = False) -> None:
    """Ein Worker = ein Token, Requests seriell (GitHub-konform). Alle Worker
    laufen dieselbe Zustandsmaschine: erst Enumerations-Chunks abarbeiten, dann
    die Detail-Queue. Ist beides leer -> Ziel erreicht -> Stopp."""
    conn = db.connect(db_path)
    client = GitHubClient(conn, token=token)
    while not stop_ev.is_set():
        active_chunk = None
        try:
            # Phase 1: Enumeration, solange offene Chunks existieren (ausser skip_enum).
            if not skip_enum and enum_open(conn) > 0:
                active_chunk = _claim_chunk(conn)
                if active_chunk is None:
                    _sleep_until(int(time.time()) + 5, stop_ev.is_set)  # Peers walken noch
                    continue
                found = _walk_chunk(client, active_chunk, stop_ev.is_set)
                cnum = active_chunk // CHUNK_SIZE
                active_chunk = None              # _walk_chunk hat den Status gesetzt
                prog.enum_tick()
                if found or cnum % 50 == 0:
                    print(f"[{_now()}] Enum Chunk {cnum} (+{found} Repos), "
                          f"offene Chunks: {enum_open(conn):,} | T{idx}")
                continue

            # Frueher warteten Detail-Worker hier, solange ueberhaupt Chunks offen
            # waren. Bei 2.000 offenen Chunks hiess das: die halbe Flotte hat
            # tagelang geschlafen, obwohl 1,4 Mio Repos in der Queue lagen — und
            # sobald die Enumeration klemmte, stand der ganze Crawl. Jetzt faellt
            # der Worker direkt in Phase 2 und schlaeft nur, wenn die Queue leer ist.

            # Phase 2: Detail-Queue abarbeiten.
            claimed = _claim_one(conn)
            if claimed is None:
                # Enumeration fertig + Queue leer + nichts in Arbeit -> Ziel erreicht.
                if enum_open(conn) == 0 and _detail_inprogress(conn) == 0:
                    print(f"[{_now()}] T{idx}: alles enumeriert UND detailliert — Ziel erreicht.")
                    stop_ev.set()
                    break
                _sleep_until(int(time.time()) + 5, stop_ev.is_set)
                continue
            rid, full = claimed
            _detail_one(client, conn, rid, full)
            n = prog.tick()
            if n % 100 == 0:
                rate = n / max(1e-9, time.time() - prog.t0) * 3600
                print(f"[{_now()}] {n} Repos detailliert (~{rate:.0f}/h) | "
                      f"T{idx} Rate-Rest {client.total_remaining}")
            if max_details and n >= max_details:
                stop_ev.set()
                break
        except RateLimitExhausted as e:
            if active_chunk is not None:         # Walk unterbrochen -> Chunk freigeben
                _set_chunk(conn, active_chunk, 0)
            # Ohne diese Zeile verstummt der Daemon beim Warten komplett und sieht
            # von aussen aus wie abgestuerzt. Wartezeiten gehoeren ins Log.
            wait = max(0, e.reset_epoch - int(time.time()))
            print(f"[{_now()}] T{idx}: Rate-Limit leer — warte {wait//60}m{wait%60:02d}s "
                  f"bis {datetime.fromtimestamp(e.reset_epoch).strftime('%H:%M:%S')}.")
            _sleep_until(e.reset_epoch, stop_ev.is_set)
            client.clear_rate_limit()
        except Exception as e:  # Netzwerkausfall o.ae. -> Backoff statt Absturz
            if active_chunk is not None:
                _set_chunk(conn, active_chunk, 0)
            # Sperrkonflikte sind hausgemacht (20 Writer, ein SQLite-Writer) und
            # nach Millisekunden weg — dafuer 30 s zu pausieren verschenkt den
            # halben Durchsatz. Netzfehler brauchen die lange Pause weiterhin.
            locked = isinstance(e, sqlite3.OperationalError) and "locked" in str(e).lower()
            if locked:
                _sleep_until(int(time.time()) + 1, stop_ev.is_set)
                continue
            print(f"[{_now()}] T{idx} Fehler: {type(e).__name__}: {e} — 30s Backoff.")
            _sleep_until(int(time.time()) + 30, stop_ev.is_set)
    conn.close()


def run(db_path=db.DEFAULT_DB, token=None, max_details: int | None = None,
        enumerate_only: bool = False, token_split: int | None = None) -> None:
    """Autonomer Daemon mit Thread-Pool: ein Worker je Token (seriell pro Token,
    parallel ueber Tokens -> Budgets addieren sich). Mit token_split: erste N
    Tokens = Enumeration, Rest = Detail (parallel, nicht sequenziell). Phase 1
    enumeriert ganz GitHub (parallele Chunks), Phase 2 detailliert die Queue.
    Erreicht der Lauf sein Ziel, stoppt er von selbst mit Exit 0."""
    conn = db.connect(db_path)
    db.init_schema(conn)
    init_chunks(conn)
    # Crash-Recovery: haengende Claims (Repos + Chunks) freigeben.
    r1 = conn.execute("UPDATE repos SET detailed=0 WHERE detailed=3").rowcount
    r2 = conn.execute("UPDATE enum_chunks SET done=0 WHERE done=2").rowcount
    conn.commit()
    if r1 or r2:
        print(f"Crash-Recovery: {r1} Repos + {r2} Chunks zurueckgesetzt.")
    open_chunks = enum_open(conn)
    values = [s.value for s in GitHubClient(conn, token=token).slots]
    conn.close()

    # Echtes Budget messen statt Tokens hochzurechnen: GitHub limitiert pro
    # ACCOUNT. Liegen alle Tokens auf einem Account, sind 20 Tokens weiterhin
    # 5.000/h — die alte Anzeige "~100000/h" war schlicht falsch.
    nt = sum(1 for v in values if v)
    if nt:
        from . import ops as _ops
        b = _ops.real_budget([v for v in values if v])
        if b["limit"]:
            budget = (f"{nt} Token(s), real {b['remaining']:,}/{b['limit']:,} frei"
                      + (" — AUFGEBRAUCHT, warte auf Reset" if b["exhausted"] else ""))
        else:
            budget = f"{nt} Token(s), Budget nicht messbar ({b.get('err')})"
    else:
        budget = "kein Token, 60/h"
    ziel = "nur Enumeration" if enumerate_only else "Enumeration -> Detail -> Stopp"

    # Split-Tokens: erste N dediziert Enum, Rest dediziert Detail, beide parallel
    split = token_split or (len(values) // 2 if values else 0)
    enum_vals = values[:split]
    detail_vals = values[split:]

    stop_ev = _install_signals()
    prog = _Progress()
    strategy = f"Split ({len(enum_vals)} Enum, {len(detail_vals)} Detail)" if split > 0 and split < len(values) else f"All-in ({len(values)} Worker)"
    print(f"GitData-Daemon: {len(values)} Tokens, {budget}. {strategy}. "
          f"Start: {'Enumeration' if open_chunks else 'Detail'} "
          f"({open_chunks:,} Chunks). Ziel: {ziel}.")

    threads = []
    # Enumeration-Worker (erste N Tokens)
    for i, val in enumerate(enum_vals):
        t = threading.Thread(target=_worker, name=f"E{i}", daemon=True,
                             args=(i, val, db_path, stop_ev, prog, max_details,
                                   False))  # skip_enum=False für Enumeration
        t.start()
        threads.append(t)
    # Detail-Worker (Rest der Tokens, nur wenn split)
    if split > 0 and split < len(values) and not enumerate_only:
        for i, val in enumerate(detail_vals):
            t = threading.Thread(target=_worker, name=f"D{i}", daemon=True,
                                 args=(len(enum_vals) + i, val, db_path, stop_ev, prog,
                                       max_details, True))  # skip_enum=True, nur Detail
            t.start()
            threads.append(t)

    # Main-Thread haelt Signale empfangsbereit (join blockiert sie sonst).
    while any(t.is_alive() for t in threads) and not stop_ev.is_set():
        time.sleep(0.3)
    stop_ev.set()  # falls per max_details/Signal ausgeloest: allen Bescheid geben
    for t in threads:
        t.join(timeout=40)

    status(db.connect(db_path))
    print(f"Gestoppt. Lauf: {prog.enum} Chunks enumeriert, "
          f"{prog.done} Repos detailliert.")


def status(conn) -> None:
    total = conn.execute("SELECT COUNT(*) FROM repos").fetchone()[0]
    detailed = conn.execute("SELECT COUNT(*) FROM repos WHERE detailed=1").fetchone()[0]
    pending = count_pending(conn)
    gone = conn.execute(
        "SELECT COUNT(*) FROM repos WHERE detailed=1 AND stars IS NULL").fetchone()[0]
    failed = conn.execute(
        "SELECT COUNT(*) FROM repos WHERE detailed<>1 AND attempts>=5").fetchone()[0]
    owners = conn.execute("SELECT COUNT(*) FROM owners").fetchone()[0]
    contrib = conn.execute("SELECT COUNT(*) FROM contributions").fetchone()[0]
    rels = conn.execute("SELECT COUNT(*) FROM releases").fetchone()[0]
    deps = conn.execute("SELECT COUNT(*) FROM dependencies").fetchone()[0]
    cache = conn.execute("SELECT COUNT(*) FROM http_cache").fetchone()[0]
    chunks_total = conn.execute("SELECT COUNT(*) FROM enum_chunks").fetchone()[0]
    chunks_done = conn.execute("SELECT COUNT(*) FROM enum_chunks WHERE done=1").fetchone()[0]
    enum_pct = (chunks_done / chunks_total * 100) if chunks_total else 0
    print("=" * 56)
    print("GITDATA — CRAWL-STATUS")
    print("=" * 56)
    if chunks_total:
        print(f"Enumeration:          {chunks_done:>6,}/{chunks_total:,} Chunks "
              f"({enum_pct:.1f}%)  {'FERTIG' if chunks_done==chunks_total else 'laeuft'}")
    print(f"Repos entdeckt:       {total:>12,}")
    print(f"  davon detailliert:  {detailed:>12,}")
    print(f"  offen (Queue):      {pending:>12,}")
    print(f"  geloescht/leer:     {gone:>12,}")
    print(f"  fehlgeschlagen:     {failed:>12,}  (attempts>=5, uebersprungen)")
    print(f"Owner/Personen:       {owners:>12,}")
    print(f"Contributions:        {contrib:>12,}")
    print(f"Releases:             {rels:>12,}")
    print(f"Dependencies:         {deps:>12,}  (Repo->Paket-Kanten)")
    print(f"HTTP-Cache (Roh):     {cache:>12,}  Eintraege")
    print("=" * 56)

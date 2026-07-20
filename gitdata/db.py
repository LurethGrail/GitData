"""SQLite-Schema und Verbindung.

Das Schema ist der eigentliche "robuste Kern": ein Roh-Layer (http_cache) hält
jede API-Antwort für Reprozessierung + konditionale Requests, darüber ein
normalisiertes Relationsmodell. Eine spätere Migration auf Postgres/eine
Graph-DB tauscht nur diese Datei, nicht die Analyse.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

DEFAULT_DB = Path(__file__).resolve().parent.parent / "data" / "gitdata.db"

SCHEMA = """
-- Roh-Layer: jede HTTP-Antwort roh gespeichert. Ermoeglicht Reprozessierung
-- ohne erneuten API-Call und konditionale Requests (ETag/Last-Modified -> 304
-- spart Download/Parsing; Rate-Limit spart erst der Roh-Layer selbst).
CREATE TABLE IF NOT EXISTS http_cache (
    url           TEXT PRIMARY KEY,
    etag          TEXT,
    last_modified TEXT,
    status        INTEGER,
    body          TEXT,
    fetched_at    TEXT
);

-- Nutzer und Organisationen.
CREATE TABLE IF NOT EXISTS owners (
    id           INTEGER PRIMARY KEY,
    login        TEXT UNIQUE NOT NULL,
    type         TEXT,                 -- User | Organization | Bot
    name         TEXT,
    company      TEXT,
    location     TEXT,
    blog         TEXT,
    bio          TEXT,
    followers    INTEGER,
    following    INTEGER,
    public_repos INTEGER,
    html_url     TEXT,
    created_at   TEXT,
    enriched     INTEGER DEFAULT 0,    -- 0 = nur eingebettete Basics, 1 = volles Profil
    fetched_at   TEXT
);

CREATE TABLE IF NOT EXISTS repos (
    id               INTEGER PRIMARY KEY,
    full_name        TEXT UNIQUE NOT NULL,
    owner_login      TEXT NOT NULL,
    name             TEXT,
    description      TEXT,
    homepage         TEXT,
    primary_language TEXT,
    license          TEXT,
    stars            INTEGER,
    forks            INTEGER,
    watchers         INTEGER,
    open_issues      INTEGER,
    size             INTEGER,
    is_fork          INTEGER,
    archived         INTEGER,
    created_at       TEXT,
    updated_at       TEXT,
    pushed_at        TEXT,
    fetched_at       TEXT,
    detailed         INTEGER DEFAULT 0,   -- 0 = nur Stub (aus Enumeration), 1 = volle Metadaten geholt
    attempts         INTEGER DEFAULT 0,   -- fehlgeschlagene Detail-Versuche (Poison-Pill-Schutz)
    discovered_at    TEXT,
    parent_id        INTEGER,             -- Fork-Elternteil (repo->parent Kante)
    source_id        INTEGER              -- Fork-Wurzel (repo->source Kante)
);

-- Schluessel-Wert-Checkpoints des Crawlers (z.B. Enumerations-Cursor).
CREATE TABLE IF NOT EXISTS crawl_state (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS repo_topics (
    repo_id INTEGER NOT NULL,
    topic   TEXT NOT NULL,
    PRIMARY KEY (repo_id, topic)
);

CREATE TABLE IF NOT EXISTS repo_languages (
    repo_id  INTEGER NOT NULL,
    language TEXT NOT NULL,
    bytes    INTEGER,
    PRIMARY KEY (repo_id, language)
);

-- Kante Person <-> Repo. Kern der "Datenrelationen".
CREATE TABLE IF NOT EXISTS contributions (
    repo_id       INTEGER NOT NULL,
    owner_login   TEXT NOT NULL,
    contributions INTEGER,
    PRIMARY KEY (repo_id, owner_login)
);

-- Releases: der Author ist eine Person<->Repo-Kante, Tags = Versionsgeschichte.
CREATE TABLE IF NOT EXISTS releases (
    repo_id      INTEGER NOT NULL,
    tag          TEXT NOT NULL,
    name         TEXT,
    author_login TEXT,
    published_at TEXT,
    PRIMARY KEY (repo_id, tag)
);

-- Dependencies aus dem SBOM: Repo -> Paket. Kern des Abhaengigkeits-Netzes.
CREATE TABLE IF NOT EXISTS dependencies (
    repo_id   INTEGER NOT NULL,
    package   TEXT NOT NULL,
    version   TEXT,
    ecosystem TEXT,
    PRIMARY KEY (repo_id, package, version)
);

-- Arbeitspakete der parallelen Enumeration (ein Worker je Token beansprucht Chunks).
CREATE TABLE IF NOT EXISTS enum_chunks (
    start INTEGER PRIMARY KEY,
    done  INTEGER DEFAULT 0        -- 0 = offen, 2 = beansprucht, 1 = fertig
);

CREATE INDEX IF NOT EXISTS idx_contrib_login ON contributions(owner_login);
CREATE INDEX IF NOT EXISTS idx_repos_owner   ON repos(owner_login);
CREATE INDEX IF NOT EXISTS idx_topics_topic  ON repo_topics(topic);
CREATE INDEX IF NOT EXISTS idx_dep_package   ON dependencies(package);
CREATE INDEX IF NOT EXISTS idx_releases_author ON releases(author_login);
"""

# Spalten, die aelteren DBs (vor der Mass-Crawl-Phase) fehlen. CREATE TABLE oben
# deckt frische DBs ab; hier ziehen wir bestehende nach.
_MIGRATIONS = [
    ("repos", "detailed", "INTEGER DEFAULT 0"),
    ("repos", "attempts", "INTEGER DEFAULT 0"),
    ("repos", "discovered_at", "TEXT"),
    ("repos", "parent_id", "INTEGER"),
    ("repos", "source_id", "INTEGER"),
]


def connect(db_path: str | Path = DEFAULT_DB) -> sqlite3.Connection:
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")       # gleichzeitige Reader + 1 Writer
    conn.execute("PRAGMA busy_timeout=30000")     # Writer warten statt "database is locked"
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    for table, col, decl in _MIGRATIONS:
        cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
        if col not in cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
            if table == "repos" and col == "detailed":
                # Bereits voll gecrawlte Repos (haben Stars) als detailed markieren.
                conn.execute("UPDATE repos SET detailed=1 WHERE stars IS NOT NULL")
    # Indizes auf migrierten Spalten erst NACH dem ALTER anlegen (sonst fehlt die
    # Spalte auf Alt-DBs beim executescript oben).
    # (detailed, id): Queue-Abfrage "WHERE detailed=0 ORDER BY id LIMIT n" bleibt
    # auch bei hunderten Mio. Zeilen ein Index-Seek statt Sort.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_repos_queue ON repos(detailed, id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_repos_parent ON repos(parent_id)")
    conn.commit()

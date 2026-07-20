"""Auswertung: Kennzahlen, Kategorisierung und abgeleitete Beziehungen.

Reine SQL-Sichten auf das Relationsmodell. Alles hier ist erweiterbar, ohne den
Crawler anzufassen — neue Kennzahl = neue Query.
"""
from __future__ import annotations

BOT = "AND owner_login NOT LIKE '%[bot]'"


def language_shares(conn, limit: int = 12) -> list[dict]:
    rows = conn.execute(
        "SELECT language, SUM(bytes) AS b FROM repo_languages "
        "GROUP BY language ORDER BY b DESC LIMIT ?", (limit,)).fetchall()
    total = sum(r["b"] for r in rows) or 1
    return [{"language": r["language"], "bytes": r["b"],
             "share": round(r["b"] / total, 4)} for r in rows]


def category_shares(conn, limit: int = 15) -> list[dict]:
    """Kategorien = GitHub-Topics, ueber alle Repos aggregiert."""
    rows = conn.execute(
        "SELECT topic, COUNT(*) AS n FROM repo_topics "
        "GROUP BY topic ORDER BY n DESC LIMIT ?", (limit,)).fetchall()
    return [{"topic": r["topic"], "count": r["n"]} for r in rows]


def top_repos(conn, limit: int = 10) -> list[dict]:
    rows = conn.execute(
        "SELECT full_name, owner_login, primary_language, stars, forks, open_issues, "
        "pushed_at FROM repos ORDER BY stars DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


def cross_project_contributors(conn, min_repos: int = 2, limit: int = 20) -> list[dict]:
    """Personen, die an mehreren Seed-Repos mitarbeiten — der Kern-'Schluss'."""
    rows = conn.execute(
        f"SELECT owner_login, COUNT(DISTINCT repo_id) AS repos, "
        f"SUM(contributions) AS total FROM contributions "
        f"WHERE 1=1 {BOT} GROUP BY owner_login "
        f"HAVING repos >= ? ORDER BY repos DESC, total DESC LIMIT ?",
        (min_repos, limit)).fetchall()
    return [dict(r) for r in rows]


def overlap_edges(conn, min_shared: int = 1) -> list[dict]:
    """Kanten Repo<->Repo, Gewicht = Anzahl gemeinsamer Contributors (ohne Bots)."""
    rows = conn.execute(
        """SELECT a.repo_id AS src, b.repo_id AS dst, COUNT(*) AS shared
           FROM contributions a
           JOIN contributions b
             ON a.owner_login = b.owner_login AND a.repo_id < b.repo_id
           WHERE a.owner_login NOT LIKE '%[bot]'
           GROUP BY a.repo_id, b.repo_id
           HAVING shared >= ?""", (min_shared,)).fetchall()
    return [dict(r) for r in rows]


def summary(conn) -> dict:
    counts = {
        "repos": conn.execute("SELECT COUNT(*) FROM repos").fetchone()[0],
        "owners": conn.execute("SELECT COUNT(*) FROM owners").fetchone()[0],
        "contributions": conn.execute("SELECT COUNT(*) FROM contributions").fetchone()[0],
        "total_stars": conn.execute("SELECT COALESCE(SUM(stars),0) FROM repos").fetchone()[0],
        "distinct_contributors": conn.execute(
            f"SELECT COUNT(DISTINCT owner_login) FROM contributions WHERE 1=1 {BOT}"
        ).fetchone()[0],
    }
    return {
        "counts": counts,
        "languages": language_shares(conn),
        "categories": category_shares(conn),
        "top_repos": top_repos(conn),
        "cross_project": cross_project_contributors(conn),
    }


def graph(conn, min_shared: int = 1) -> dict:
    nodes = [dict(r) for r in conn.execute(
        "SELECT id, full_name, owner_login, primary_language, stars FROM repos").fetchall()]
    edges = overlap_edges(conn, min_shared)
    return {"nodes": nodes, "edges": edges}


def intel(conn) -> dict:
    """Ein Payload fuer das gesamte Dashboard.

    Nur Repos mit Substanz (detailed=1 oder mit Contributions) — die 1.2M
    Enumerations-Stubs haben ausser dem Namen nichts und wuerden jede Sicht
    fluten. Repo<->Repo-Kanten werden NICHT mitgeschickt: der Client leitet sie
    aus `links` ab, damit Filter den Graphen live neu bauen statt neu zu laden.
    """
    repos = [dict(r) for r in conn.execute(
        """SELECT r.id, r.full_name, r.owner_login, r.primary_language AS lang,
                  r.license, r.stars, r.forks, r.watchers, r.open_issues, r.size,
                  r.is_fork, r.archived, r.created_at, r.updated_at, r.pushed_at,
                  o.type AS owner_type
           FROM repos r LEFT JOIN owners o ON o.login = r.owner_login
           WHERE r.detailed = 1
              OR r.id IN (SELECT repo_id FROM contributions)""").fetchall()]
    ids = {r["id"] for r in repos}

    links = [dict(r) for r in conn.execute(
        "SELECT repo_id, owner_login AS login, contributions AS n FROM contributions"
    ).fetchall() if r["repo_id"] in ids]

    people = [dict(r) for r in conn.execute(
        """SELECT c.owner_login AS login, o.type,
                  COUNT(DISTINCT c.repo_id) AS repos, SUM(c.contributions) AS total
           FROM contributions c LEFT JOIN owners o ON o.login = c.owner_login
           GROUP BY c.owner_login""").fetchall()]

    def rows(sql):
        return [dict(r) for r in conn.execute(sql).fetchall() if r[0] in ids]

    return {
        "repos": repos,
        "people": people,
        "links": links,
        "langs": rows("SELECT repo_id, language, bytes FROM repo_languages"),
        "topics": rows("SELECT repo_id, topic FROM repo_topics"),
        "releases": rows("SELECT repo_id, tag, author_login, published_at FROM releases"),
        "deps": rows("SELECT repo_id, package, ecosystem FROM dependencies"),
        # Universum-Zaehler: die volle Enumeration, nicht nur der angereicherte Kern.
        "universe": {
            "repos": conn.execute("SELECT COUNT(*) FROM repos").fetchone()[0],
            "owners": conn.execute("SELECT COUNT(*) FROM owners").fetchone()[0],
            "cached": conn.execute("SELECT COUNT(*) FROM http_cache").fetchone()[0],
            "detailed": conn.execute("SELECT COUNT(*) FROM repos WHERE detailed=1").fetchone()[0],
        },
    }


def report(conn) -> None:
    """Kompakter Text-Report — die 'Evaluation' ohne GUI."""
    s = summary(conn)
    c = s["counts"]
    print("=" * 60)
    print("GITDATA — AUSWERTUNG")
    print("=" * 60)
    print(f"Repos: {c['repos']}   Stars gesamt: {c['total_stars']:,}   "
          f"Contributors (ohne Bots): {c['distinct_contributors']}")
    print("\nTop-Repos nach Stars:")
    for r in s["top_repos"][:8]:
        print(f"  {r['stars']:>7,}★  {r['full_name']:<28} {r['primary_language'] or '-'}")
    print("\nSprach-Verteilung (nach Code-Bytes):")
    for l in s["languages"][:8]:
        bar = "#" * round(l["share"] * 40)
        print(f"  {l['language']:<14} {l['share']*100:5.1f}% {bar}")
    print("\nTop-Kategorien (Topics):")
    for cat in s["categories"][:10]:
        print(f"  {cat['count']:>3}x  {cat['topic']}")
    print("\nCross-Project-Contributors (Beziehung zwischen Projekten):")
    if not s["cross_project"]:
        print("  (noch keine Ueberschneidungen — mehr Repos crawlen)")
    for p in s["cross_project"][:12]:
        print(f"  @{p['owner_login']:<20} {p['repos']} Repos, "
              f"{p['total']:,} Contributions")
    print("=" * 60)

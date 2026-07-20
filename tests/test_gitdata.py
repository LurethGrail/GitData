"""Minimaler Selbsttest (stdlib asserts) fuer die nicht-triviale Logik:
Link-Header-Parser + Contributor-Overlap/Cross-Project-Query.

Lauf: python3 -m gitdata selfcheck   (oder: python3 tests/test_gitdata.py)
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gitdata import analyze, crawl, db
from gitdata.github import parse_link_next


def test_link_parser():
    h = ('<https://api.github.com/x?page=2>; rel="next", '
         '<https://api.github.com/x?page=9>; rel="last"')
    assert parse_link_next(h) == "https://api.github.com/x?page=2"
    assert parse_link_next(None) is None
    assert parse_link_next('<https://x>; rel="last"') is None


def _seed(conn):
    db.init_schema(conn)
    # 2 Repos, 3 Menschen, 1 Bot. Alice+Bob teilen beide Repos, Carol nur eins.
    conn.executemany(
        "INSERT INTO repos(id, full_name, owner_login, primary_language, stars) VALUES(?,?,?,?,?)",
        [(1, "org/a", "org", "Python", 100), (2, "org/b", "org", "C", 50)])
    conn.executemany(
        "INSERT INTO contributions(repo_id, owner_login, contributions) VALUES(?,?,?)",
        [(1, "alice", 10), (1, "bob", 5), (1, "carol", 3), (1, "ci[bot]", 99),
         (2, "alice", 8), (2, "bob", 2), (2, "ci[bot]", 88)])
    conn.commit()


def test_overlap_and_cross_project():
    conn = db.connect(":memory:")
    _seed(conn)
    edges = analyze.overlap_edges(conn, min_shared=1)
    assert len(edges) == 1, edges
    # alice + bob geteilt, Bot ausgeschlossen -> shared == 2
    assert edges[0]["shared"] == 2, edges[0]
    cross = analyze.cross_project_contributors(conn, min_repos=2)
    logins = {c["owner_login"] for c in cross}
    assert logins == {"alice", "bob"}, logins  # carol nur 1 Repo, Bot raus


def test_intel_payload():
    """intel() darf nur Repos mit Substanz liefern — die Enumerations-Stubs
    (Millionen Zeilen, nur ein Name) wuerden das Dashboard sonst fluten."""
    conn = db.connect(":memory:")
    _seed(conn)
    conn.execute("UPDATE repos SET detailed=1 WHERE id=1")
    # Stub: weder detailed noch Contributions -> darf nicht im Payload landen.
    conn.execute("INSERT INTO repos(id, full_name, owner_login) VALUES(3,'org/stub','org')")
    # Kind-Zeilen eines Stubs duerfen ebenfalls nicht durchrutschen.
    conn.execute("INSERT INTO repo_languages(repo_id, language, bytes) VALUES(3,'Go',7)")
    conn.execute("INSERT INTO repo_languages(repo_id, language, bytes) VALUES(1,'Python',42)")
    conn.commit()

    d = analyze.intel(conn)
    ids = {r["id"] for r in d["repos"]}
    assert ids == {1, 2}, ids                      # 2 nur ueber Contributions drin
    assert {l["repo_id"] for l in d["langs"]} == {1}, d["langs"]
    assert all(l["repo_id"] in ids for l in d["links"]), d["links"]
    # Personen aggregiert inkl. Bot (das Ausfiltern entscheidet der Client).
    alice = next(p for p in d["people"] if p["login"] == "alice")
    assert (alice["repos"], alice["total"]) == (2, 18), alice
    # universe zaehlt die volle Enumeration, nicht den angereicherten Kern.
    assert d["universe"]["repos"] == 3, d["universe"]
    assert d["universe"]["detailed"] == 1, d["universe"]


def _stub(i):
    return {"id": i, "full_name": f"u{i}/r", "name": "r",
            "owner": {"id": 100 + i, "login": f"u{i}", "type": "User"},
            "description": None, "fork": False}


def test_frontier():
    conn = db.connect(":memory:")
    db.init_schema(conn)
    # Checkpoint round-trip
    crawl.set_state(conn, "repos_since", 42)
    assert crawl.get_state(conn, "repos_since") == "42"
    # Stub-Upsert ist idempotent, Rediscovery clobbert nicht
    crawl.upsert_repo_stub(conn, _stub(1))
    crawl.upsert_repo_stub(conn, _stub(1))
    crawl.upsert_repo_stub(conn, _stub(2))
    assert crawl.count_pending(conn) == 2, crawl.count_pending(conn)
    # attempts >= 5 faellt aus der Queue (Poison-Pill-Schutz)
    conn.execute("UPDATE repos SET attempts=5 WHERE id=1")
    assert crawl.count_pending(conn) == 1, crawl.count_pending(conn)
    # detailed=1 (Migration hat bestehende NICHT als detailed markiert, da stars NULL)
    conn.execute("UPDATE repos SET detailed=1 WHERE id=2")
    assert crawl.count_pending(conn) == 0


def test_token_rotation():
    from gitdata.github import GitHubClient, RateLimitExhausted
    c = GitHubClient(db.connect(":memory:"), token=["a", "b", "c"])
    assert c.token_count == 3
    # Unbekanntes Budget -> reihum a,b,c,a
    assert [c._pick_slot().value for _ in range(4)] == ["a", "b", "c", "a"]
    # Leerer Token wird uebersprungen
    for s in c.slots:
        s.remaining = 5
    c.slots[1].remaining = 0  # "b" leer
    assert "b" not in {c._pick_slot().value for _ in range(6)}
    # Budgets addieren sich
    for s in c.slots:
        s.remaining = 5
    assert c.total_remaining == 15
    # Alle leer -> RateLimitExhausted mit fruehester Reset-Zeit
    for s, r in zip(c.slots, (300, 100, 200)):
        s.remaining = 0
        s.reset = r
    try:
        c._pick_slot()
        assert False, "sollte RateLimitExhausted werfen"
    except RateLimitExhausted as e:
        assert e.reset_epoch == 100, e.reset_epoch


def test_claim():
    conn = db.connect(":memory:")
    db.init_schema(conn)
    for i in (1, 2, 3):
        crawl.upsert_repo_stub(conn, _stub(i))
    conn.execute("UPDATE repos SET attempts=5 WHERE id=3")  # poison -> ausgeschlossen
    a = crawl._claim_one(conn)
    b = crawl._claim_one(conn)
    assert a[0] == 1 and b[0] == 2, (a, b)          # nach id, verschieden
    assert conn.execute("SELECT detailed FROM repos WHERE id=1").fetchone()[0] == 3
    assert crawl._claim_one(conn) is None            # 1&2 beansprucht, 3 poison


def test_chunks():
    conn = db.connect(":memory:")
    db.init_schema(conn)
    crawl.init_chunks(conn)
    total = conn.execute("SELECT COUNT(*) FROM enum_chunks").fetchone()[0]
    assert total == crawl.MAX_ID_BOUND // crawl.CHUNK_SIZE, total
    assert crawl.enum_open(conn) == total
    a = crawl._claim_chunk(conn)
    b = crawl._claim_chunk(conn)
    assert a == 0 and b == crawl.CHUNK_SIZE, (a, b)          # aufsteigend, verschieden
    assert conn.execute("SELECT done FROM enum_chunks WHERE start=0").fetchone()[0] == 2
    assert crawl.enum_open(conn) == total                    # beansprucht (2) = offen (done!=1)
    conn.execute("UPDATE enum_chunks SET done=1 WHERE start=0")
    assert crawl.enum_open(conn) == total - 1


def run():
    test_link_parser()
    test_overlap_and_cross_project()
    test_intel_payload()
    test_frontier()
    test_token_rotation()
    test_claim()
    test_chunks()
    print("selfcheck OK")


if __name__ == "__main__":
    run()

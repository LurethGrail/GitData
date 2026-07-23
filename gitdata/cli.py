"""CLI: crawl / discover / detail / run / status / analyze / serve / selfcheck."""
from __future__ import annotations

import argparse
import os
from pathlib import Path

from . import analyze, crawl, db, serve


def load_tokens():
    """Tokens aus Env (GITHUB_TOKENS/GITHUB_TOKEN, komma-/space-getrennt) oder aus
    data/token (eine Zeile pro Token, '#'-Kommentare erlaubt). Mehrere Tokens ->
    Round-Robin, ihre Rate-Budgets addieren sich. Rueckgabe: list[str] oder None."""
    env = os.environ.get("GITHUB_TOKENS") or os.environ.get("GITHUB_TOKEN") or ""
    toks = [t.strip() for t in env.replace(",", " ").split() if t.strip()]
    if not toks:
        tf = Path(db.DEFAULT_DB).parent / "token"
        if tf.exists():
            toks = [ln.strip() for ln in tf.read_text().splitlines()
                    if ln.strip() and not ln.startswith("#")]
    return toks or None


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="gitdata", description="GitHub-Metadaten indexieren & auswerten")
    p.add_argument("--db", default=str(db.DEFAULT_DB), help="Pfad zur SQLite-DB")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("crawl", help="Seeds crawlen (Metadaten holen)")
    c.add_argument("--seeds", default=str(crawl.SEEDS_FILE))
    c.add_argument("--contrib-pages", type=int, default=1,
                   help="Seiten Contributors pro Repo (100/Seite)")

    sub.add_parser("analyze", help="Text-Report der Auswertung")

    d = sub.add_parser("discover", help="Ganz GitHub enumerieren (Repo-Stubs)")
    d.add_argument("--pages", type=int, default=5, help="Enumerations-Seiten (100/Seite)")

    dt = sub.add_parser("detail", help="Offene Repos anreichern (volle Metadaten)")
    dt.add_argument("--limit", type=int, default=50)

    en = sub.add_parser("enrich", help="Kern-Owner-Profile holen + verorten (Weltansicht)")
    en.add_argument("--limit", type=int, default=None,
                    help="Nur so viele Owner anreichern (Test); Default: alle offenen")

    r = sub.add_parser("run", help="Autonomer Daemon: enumeriert ganz GitHub, dann Detail, stoppt am Ziel")
    r.add_argument("--split-enum", type=int, default=None,
                   help="Tokens dediziert fuer Enumeration (Rest fuer Detail, beide parallel). "
                        "Default: ~50%% Token-Count")
    r.add_argument("--enumerate-only", action="store_true",
                   help="Nach vollstaendiger Enumeration stoppen (nur der Index)")
    r.add_argument("--max-details", type=int, default=None,
                   help="Lauf nach so vielen detaillierten Repos beenden (Test/Cron)")

    m = sub.add_parser("monitor", help="Live-Monitor der laufenden Agents")
    m.add_argument("--interval", type=float, default=2.0, help="Update-Intervall (Sek)")

    sub.add_parser("status", help="Crawl-Fortschritt anzeigen")

    s = sub.add_parser("serve", help="Dashboard starten")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8000)

    sub.add_parser("selfcheck", help="Interne Asserts laufen lassen")

    args = p.parse_args(argv)
    token = load_tokens()

    if args.cmd == "crawl":
        crawl.crawl(db_path=args.db, seeds_path=args.seeds, token=token,
                    contrib_pages=args.contrib_pages)
    elif args.cmd == "analyze":
        conn = db.connect(args.db)
        analyze.report(conn)
    elif args.cmd == "discover":
        conn = db.connect(args.db); db.init_schema(conn)
        client = crawl.GitHubClient(conn, token=token)
        try:
            added = crawl.discover_repos(client, pages=args.pages)
            print(f"{added} Repo-Stubs entdeckt. Cursor: {crawl.get_state(conn, 'repos_since')}")
        except crawl.RateLimitExhausted as e:
            print(f"Gestoppt: {e}")
        crawl.status(conn)
    elif args.cmd == "detail":
        conn = db.connect(args.db); db.init_schema(conn)
        client = crawl.GitHubClient(conn, token=token)
        try:
            n = crawl.detail_pending(client, limit=args.limit, log=True)
            print(f"{n} Repos detailliert.")
        except crawl.RateLimitExhausted as e:
            print(f"Gestoppt: {e}")
        crawl.status(conn)
    elif args.cmd == "enrich":
        crawl.enrich(db_path=args.db, token=token, limit=args.limit)
    elif args.cmd == "run":
        token_split = args.split_enum
        if token_split is None and token:
            token_split = len(token) // 2 if isinstance(token, list) else 1
        crawl.run(db_path=args.db, token=token, max_details=args.max_details,
                  enumerate_only=args.enumerate_only, token_split=token_split)
    elif args.cmd == "monitor":
        from . import monitor as mon
        mon.live_monitor(db_path=args.db, interval=args.interval)
    elif args.cmd == "status":
        conn = db.connect(args.db); db.init_schema(conn)
        crawl.status(conn)
    elif args.cmd == "serve":
        serve.serve(db_path=args.db, host=args.host, port=args.port, tokens=token)
    elif args.cmd == "selfcheck":
        from tests import test_gitdata
        test_gitdata.run()
    return 0

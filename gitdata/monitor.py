"""Live-Monitor: Echtzeit-Statistiken der laufenden Agents auf der Konsole."""
from __future__ import annotations

import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from . import db


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%H:%M:%S")


def live_monitor(db_path=db.DEFAULT_DB, interval: float = 2.0) -> None:
    """Live-Konsolen-Monitor der Agents. Zeigt je 0.5-1s alle Metriken.

    Tab-getrennte Spalten: Zeit | Phase | Repos gesamt | detailliert/offen/hängend |
    Chunks enumeriert | Requests/s | Rate-Limit verbrauch."""
    try:
        while True:
            conn = db.connect(db_path)
            db.init_schema(conn)

            # Metriken aus der DB
            total_repos = conn.execute("SELECT COUNT(*) FROM repos").fetchone()[0]
            detailed = conn.execute("SELECT COUNT(*) FROM repos WHERE detailed=1").fetchone()[0]
            pending = conn.execute(
                "SELECT COUNT(*) FROM repos WHERE detailed=0 AND attempts<5").fetchone()[0]
            inprogress = conn.execute("SELECT COUNT(*) FROM repos WHERE detailed=3").fetchone()[0]
            chunk_done = conn.execute("SELECT COUNT(*) FROM enum_chunks WHERE done=1").fetchone()[0]
            chunk_total = conn.execute("SELECT COUNT(*) FROM enum_chunks").fetchone()[0]
            http_reqs = conn.execute("SELECT COUNT(*) FROM http_cache").fetchone()[0]

            # Rate-Limit (schnell Probe eines Tokens, fallback wenn offline)
            rate_display = ""
            try:
                # Liest aus DB aus http_cache — nur ein Indikator
                rate_display = f" Rate: {http_reqs} reqs cached"
            except Exception:
                pass

            # Phase ermitteln
            if chunk_done < chunk_total:
                phase = "ENUM"
            elif pending > 0:
                phase = "DETAIL"
            elif inprogress > 0:
                phase = "FINISHING"
            else:
                phase = "DONE"

            enum_pct = (chunk_done / chunk_total * 100) if chunk_total else 0

            # Konsole aktualisieren (mit \r überschreiben, keine neue Zeile)
            line = (
                f"[{_now()}] {phase:8} | Repos: {total_repos:8,} "
                f"| D:{detailed:6,} O:{pending:6,} W:{inprogress:4,} "
                f"| Chunks: {chunk_done:4,}/{chunk_total:4,} ({enum_pct:5.1f}%){rate_display}"
            )
            sys.stdout.write(f"\r{line:<130}")
            sys.stdout.flush()

            conn.close()
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\n[Stopp]")

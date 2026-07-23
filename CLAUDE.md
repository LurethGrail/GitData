# GitData — Projektkontext

OSINT-Werkzeug für GitHub-Metadaten: crawlt Repos/Owner in eine lokale SQLite-DB
und serviert ein Dashboard zur Beziehungsanalyse (Graph, Muster, Weltkarte, Ops).

**Wichtigste Regel: keine Abhängigkeiten.** Reine Standardbibliothek (Python 3.13),
Frontend ist Vanilla JS + Canvas, kein Framework, kein CDN, kein Build-Schritt.
Neue Funktionen dürfen das nicht brechen — im Zweifel selbst schreiben statt
Paket ziehen. Kommentare/UI sind auf Deutsch.

---

## Architektur (Datenfluss)

```
GitHub REST API
   │  github.py      Client: Multi-Token-Round-Robin, ETag-Cache, Rate-Limit-Handling
   ▼
http_cache          Roh-Layer: JEDE Antwort roh in SQLite (Reprozessierung ohne API-Call)
   │  crawl.py       Normalisierung → Relationsmodell
   ▼
SQLite (data/gitdata.db, ~19 GB)
   │  analyze.py     SQL-Sichten → /api/intel (ein Payload für das ganze Frontend)
   │  ops.py         Telemetrie → /api/ops (Agents, Token-Budget, Fortschritt)
   ▼
serve.py            stdlib http.server, JSON-API + statische Dateien
   ▼
web/                Ein scrollbares SPA, alles clientseitig gefiltert
```

Der Client lädt **einmal** `/api/intel` und rechnet danach alles lokal — Filter,
Cluster, Muster, Karte reagieren ohne Roundtrip. `/api/ops` wird alle 4 s gepollt.

---

## Dateien

| Datei | Zweck |
|---|---|
| `gitdata/github.py` | REST-Client. Round-Robin über N Tokens, konditionale Requests, Secondary-Rate-Limit-Retry. Fängt nur `HTTPError` — Verbindungsabbrüche muss der Aufrufer behandeln. |
| `gitdata/db.py` | Schema + `_MIGRATIONS` (ALTER-TABLE-Nachzieher für Alt-DBs). Verbindung mit WAL + `busy_timeout=30000`. |
| `gitdata/crawl.py` | Ingestion: `crawl` (Seeds), `discover`/`detail`/`run` (Massen-Crawl), `enrich` (Owner-Profile + Geocoding). Alles idempotent/resumebar. |
| `gitdata/geo.py` | **Offline-Geocoder.** ~82 Länder, ~259 Städte, Aliasse, Flaggen-Emoji, US-Staaten. Freitext → (Land, Stadt, lat, lon). Kein Netz. |
| `gitdata/analyze.py` | Auswertungs-Queries + `intel()` (der große Frontend-Payload) + Text-Report. |
| `gitdata/ops.py` | Betriebs-Telemetrie + Agent-Steuerung: `ps`-Agents, echtes Rate-Limit, DB-Zähler, `start_agent`/`stop_agent` (Whitelist). Stale-while-revalidate-Cache. |
| `gitdata/serve.py` | Routen: `/api/intel`, `/api/ops`, `/api/summary`, `/api/graph`, sonst statisch aus `web/`. |
| `gitdata/monitor.py` | Konsolen-Live-Monitor (Vorgänger des Ops-Dashboards). |
| `web/index.html` | 4 Sektionen + Sticky-Header. |
| `web/app.js` | Das gesamte Frontend (~2000 Z.). Abschnitte sind mit `/* ===== NAME ===== */` markiert. |
| `web/style.css` | Phosphor-Terminal-Look. Farben als CSS-Variablen, Canvas zieht sie über `CSSV()`. |
| `web/world-110m.json` | 156 KB Ländergrenzen (Natural Earth 110m, vereinfacht). Lokal, kein CDN. |
| `tests/test_gitdata.py` | stdlib-Asserts, Einstieg `run()`. Läuft über `python -m gitdata selfcheck`. |

## Kommandos

```bash
python -m gitdata crawl      # Seeds aus seeds.json
python -m gitdata discover   # ganz GitHub enumerieren (Repo-Stubs)
python -m gitdata detail     # Stubs zu vollen Metadaten anreichern
python -m gitdata run        # Daemon: discover + detail parallel, Token-Split
python -m gitdata enrich     # Owner-Profile holen (location) + geocoden  ← speist die Weltansicht
python -m gitdata status | monitor | analyze
python -m gitdata serve      # Dashboard http://127.0.0.1:8000
python -m gitdata selfcheck  # ALLE Tests (immer vor dem Abschluss laufen lassen)
```

Tokens: `data/token` (eine Zeile je Token, aktuell 20) oder `GITHUB_TOKEN(S)`.

## Datenmodell (Kern)

`repos` ist gleichzeitig die Work-Queue: `detailed` 0 = offen, 1 = fertig, 3 = in Arbeit;
`attempts>=5` = Poison-Pill. `enum_chunks` verteilt die ID-Enumeration auf Worker
(`done` 0/2/1 = offen/beansprucht/fertig).

Beziehungskanten: `contributions` (Person↔Repo, der Kern), `releases.author_login`,
`dependencies` (Repo→Paket), `repos.parent_id/source_id` (Fork-Ketten).

`owners` trägt neben dem Profil die Geo-Spalten `country, city, lat, lon, geo_tried`
(gefüllt von `enrich`/`geocode_pending`). Nur `enrich` schreibt sie — der Massen-Crawl
sieht in eingebetteten Owner-Objekten **keine** `location`.

## Frontend

Vier Sektionen, per Sticky-Header-Nav erreichbar (`#terminal`, `#patterns`, `#world`, `#ops`):

1. **GRAPH** — Force-Layout der Co-Contribution-Kanten. Kanten werden im Client aus
   Person→Repo-Kanten *gefaltet*, deshalb wirken Filter sofort. Label-Propagation
   liefert Cluster. Abstossung über **Barnes-Hut-Quadtree** (`buildQuad`/`bhForce`);
   gezeichnet werden höchstens `EDGE_BUDGET` (15k) Kanten, nach Gewicht sortiert.
2. **PATTERNS** — `PATTERNS`-Registry (9 Vorlagen) läuft über `pile()` = aktuell
   gefilterte Menge. Jeder Treffer ist klickbar (`focusRepo`/`focusPerson`).
   Darüber der **Steckbrief**: `sbRepo()`/`sbPerson()` bauen aus der Auswahl ganze
   deutsche Sätze.
3. **WORLD** — Globus (orthographisch) + flache Karte, echte Ländergrenzen.
   Ziehen dreht, Rad zoomt, Klick auf Land/Stadt fliegt hin (`flyTo`), Idle-Auto-Spin.
   Trigonometrie je Stützpunkt wird beim Laden vorgerechnet (`loadWorldGeometry`).
   Panel „VON HIER" (`paintWorldDrill`) listet die konkreten Repos/Personen des gewählten
   Ortes, anklickbar in den Graphen. Owner ohne Stadtangabe erzeugen **keinen** Ortsmarker
   (sonst dominiert ein Riesen-Klecks am Länderzentroid die Karte) — sie stehen als
   „nur Land, ohne Stadt" in der Abdeckung.
4. **OPS** — pollt `/api/ops`; Durchsatz/ETA werden **clientseitig** aus Zähler-Differenzen
   per EMA geschätzt (`opsRate`), nicht vom Server geliefert. Alle Kommandos aus
   `ops.STARTABLE` (run/discover/detail/crawl/enrich/analyze/status/selfcheck) lassen sich per
   `POST /api/agent` starten/stoppen (feste Whitelist, Stop nur für verifizierte gitdata-PIDs);
   `GET /api/agent/log?cmd=` zeigt die Ausgabe, damit auch Ein-Schuss-Befehle ein Ergebnis haben.

Zentrale Objekte in `app.js`: `S` (Daten + Graph-State), `F` (Filter), `W3` (Weltansicht),
`OPS` (Telemetrie). `rebuild()` → `paintAll()` ist der Weg, nach dem alles neu gemalt wird.

## Konventionen

- Deutsche Kommentare, Kommentar erklärt **warum**, nicht was.
- Bewusste Abkürzungen mit `ponytail:`-Kommentar markieren (Ceiling + Upgrade-Pfad).
- Nicht-triviale Logik lässt einen `demo()`-Selbsttest zurück, eingehängt in
  `tests/test_gitdata.py::run()` (`geo.demo`, `ops.demo`).
- Teure Queries niemals ungecacht in einen gepollten Endpunkt.

## Rate-Limit: der wichtigste Fallstrick

**GitHub limitiert pro ACCOUNT, nicht pro Token.** Die 20 Tokens in `data/token` gehören
alle demselben Account (user ID 226175479) — das sind **5.000 Requests/h insgesamt**, nicht
20 × 5.000. Mehr Durchsatz gibt es nur mit Tokens aus *verschiedenen* Accounts; ein weiterer
Token desselben Accounts bringt exakt null.

**`/rate_limit` lügt in dieser Konstellation**: es meldet 4.999/5.000 *pro Token*, während ein
echter Request 403 mit `X-RateLimit-Remaining: 0` bekommt. Deshalb misst `ops.real_budget()`
mit einem echten Mini-Request (`/repositories?since=0&per_page=1`) und liest dessen Header.
Niemals wieder `/rate_limit` als Budget-Anzeige verwenden.

Symptombild bei erschöpftem Budget: Crawler läuft, Log schweigt, nichts passiert. Seit dem
Fix protokolliert jeder Worker seine Wartezeit (`Rate-Limit leer — warte 10m00s bis …`), und
das Ops-Panel zeigt „Budget aufgebraucht" plus Reset-Countdown statt scheinbar freier 100.000.

## Betriebszustand / Fallstricke

- **Daemons halten die DB offen** (WAL, ein Writer): meist laufen `gitdata run` und
  `gitdata serve`. Zusätzliche Writer sind ok (`busy_timeout`), aber `serve` lädt
  Python-Module **nicht** neu — nach Backend-Änderungen neu starten.
- **Anreicherung ist durch**: 5.575/5.575 Kern-Owner, davon 3.712 verortet (66 %;
  der Rest schreibt „Remote“, „WorldWide“ o. ä.). Nach neuen Crawls `enrich` erneut laufen lassen.
- **Teure Queries**: `COUNT(*) ... WHERE attempts<5` auf 1,4 Mio Repos kostet ~3 s.
  Stattdessen `GROUP BY detailed` (Covering-Index `idx_repos_detailed`, ~0,18 s).
- **Verbindungsfehler sind Normalbetrieb**, nicht die Ausnahme: Enumerations-Antworten sind
  ~400 KB, IncompleteRead/ConnectionReset/Timeout treten laufend auf. `github.py:get()` fängt
  sie über `TRANSIENT` ab und versucht `NET_ATTEMPTS`-mal — und schliesst die Response im
  `finally`, sonst sammeln sich CLOSE_WAIT-Sockets bis die Deskriptoren ausgehen.
- **Detail-Worker dürfen nicht auf die Enumeration warten.** Früher schliefen sie, solange
  überhaupt Chunks offen waren — bei 2.000 offenen Chunks stand damit die halbe Flotte still,
  obwohl 1,4 Mio Repos in der Queue lagen.
- **`database is locked` ist Normalbetrieb**, nicht Datenverlust: SQLite kennt einen Writer,
  der Daemon fährt 20. Deshalb `busy_timeout=60000` + `synchronous=NORMAL`, und im Worker
  kostet ein Sperrfehler 1 s statt 30 s. Wichtig: Sperrfehler dürfen `repos.attempts`
  **nicht** hochzählen, sonst landen gesunde Repos nach 5 Kollisionen als Poison-Pill.
- **Der Graph wächst mit dem Crawl.** Ab ~4.000 Knoten war die alte Allpaar-Abstossung bei
  5 fps; Barnes-Hut + Kanten-Budget bringen ~27 fps. Wenn der Crawl weiterläuft, hier wieder
  messen (`tick()`/`draw()` timen) statt zu raten.
- **SBOM-Daten sind dünn** → Muster „Abhängigkeits-Konvergenz“ liefert meist 0 Treffer.
  Das ist korrekt, kein Bug.
- **Mausrad über dem Graph-Canvas zoomt**, scrollt also nicht die Seite. Zum Wechseln
  die Header-Nav benutzen (oder über den Seitenpanels scrollen).
- **Eingebetteter Preview-Browser führt `requestAnimationFrame` nicht aus** und
  fotografiert nichts unterhalb des Viewports. Animation/Globus dort nur durch
  manuelles Aufrufen von `worldLoop()`/`drawWorld()` prüfbar; echte Browser sind normal.
  DOM-/Canvas-Introspektion (`getImageData`) ist dort der verlässliche Testweg.

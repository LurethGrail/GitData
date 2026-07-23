# GitData

Crawls GitHub repo metadata into a local SQLite DB and serves a dashboard to explore it.

## Setup

Requires Python 3.13+ (stdlib only, no dependencies to install).

```bash
git clone <this-repo>
cd GitData
```

### GitHub token

Unauthenticated requests are limited to 60/h. To use your real rate limit (5000/h per token),
provide one or more [personal access tokens](https://github.com/settings/tokens) (no scopes needed
for public data) via either:

- environment variable: `export GITHUB_TOKEN=ghp_xxx` (or `GITHUB_TOKENS` with multiple,
  comma/space-separated, for round-robin), or
- a `data/token` file, one token per line (`#` comments allowed). This path is gitignored.

## Usage

```bash
python -m gitdata crawl          # crawl the seed repos in seeds.json
python -m gitdata discover       # enumerate repos across all of GitHub
python -m gitdata detail         # fetch full metadata for discovered repos
python -m gitdata run            # autonomous daemon: discover then detail
python -m gitdata enrich         # fetch owner profiles (location) + geocode → world view
python -m gitdata status         # show crawl progress
python -m gitdata monitor        # live view of running agents
python -m gitdata analyze        # text report of the collected data
python -m gitdata serve          # dashboard at http://127.0.0.1:8000
python -m gitdata selfcheck      # run internal asserts
```

The SQLite DB lives at `data/gitdata.db` by default (override with `--db`).

## Dashboard

`serve` opens a single scrollable page with three sections (jump between them with the
GRAPH / PATTERNS / WORLD buttons in the header):

- **Graph** — the collaboration network. Filter the pile with the left rack (language,
  stars, topology, owner type, time window, cluster, …); every other section reacts to
  the same filter live.
- **Relation Patterns** — one-click templates that run over the *currently filtered* pile
  and state a conclusion + the evidence: bus-factor (single point of failure), ko-maintainer
  cartels, cross-cluster brokers, serial forkers, bot-operated repos, abandoned-but-influential
  repos, language monocultures, co-location, and dependency convergence. Every finding is
  clickable and jumps back into the graph.
- **World View** — where the repos/actors come from, on a rotatable globe with real country
  borders (`web/world-110m.json`, Natural Earth 110m, 156 KB, served locally — no CDN, no
  mapping library). Drag to spin, wheel to zoom, click a country or city to fly to it; toggle
  to a flat map. Owner `location` strings are geocoded offline (`gitdata/geo.py`, ~80 countries
  / ~260 cities). Populate it with `gitdata enrich` (repo owners first, so every detailed repo
  gets a country).
- **Ops** — what the crawlers are doing right now: running agents with uptime, per-token
  rate-limit budget (via GitHub's free `/rate_limit`), and progress bars with live throughput
  and updating ETAs for the detail queue, enumeration and owner enrichment.

Selecting anything (graph node, ranking row, pattern finding) writes a **Steckbrief** — a
plain-German prose profile of that repo or person — at the top of the Patterns section.

### Running the crawler continuously (macOS)

`deploy/com.gitdata.crawler.plist` is a launchd unit that keeps `gitdata run` alive across
crashes/reboots. See the comments in that file for install steps.

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
python -m gitdata status         # show crawl progress
python -m gitdata monitor        # live view of running agents
python -m gitdata analyze        # text report of the collected data
python -m gitdata serve          # dashboard at http://127.0.0.1:8000
python -m gitdata selfcheck      # run internal asserts
```

The SQLite DB lives at `data/gitdata.db` by default (override with `--db`).

### Running the crawler continuously (macOS)

`deploy/com.gitdata.crawler.plist` is a launchd unit that keeps `gitdata run` alive across
crashes/reboots. See the comments in that file for install steps.

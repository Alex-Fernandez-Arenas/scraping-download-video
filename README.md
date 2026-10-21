# Scraping Download Video

Self-hosted tool that scrapes YouTube channel metadata into SQLite, exposes it through a small web dashboard, and downloads the selected videos with `yt-dlp`.

> **Status:** early-stage, single-maintainer project. APIs and CLI flags may change between minor versions.

## Features

- **Channel scraping with Playwright** — reads video IDs, titles, durations, upload dates and thumbnails directly from a channel page, without the YouTube Data API.
- **SQLite storage** — one file (`db/videos.sqlite`) keeps channels, videos and download state; no external service required.
- **Web dashboard** — browse channels, filter pending downloads, and follow progress live over Server-Sent Events.
- **Download orchestration** — spawns `yt-dlp` with sane defaults (720p+ video/audio merge to MP4), a two-download concurrency limit and retry/cookie handling.
- **Cookie support** — reads an exported `cookies.txt`, pulls cookies from a local browser profile, or runs your own refresh script when YouTube returns `403`.

## Requirements

| Dependency | Why |
|---|---|
| Node.js >= 20 | ESM runtime |
| `yt-dlp` in `PATH` | video downloads |
| Deno (recommended) | yt-dlp uses it to solve YouTube JS challenges |
| Chromium for Playwright | channel scraping |

## Install

```bash
git clone https://github.com/Alex-Fernandez-Arenas/scraping-download-video.git
cd scraping-download-video
npm install
npx playwright install chromium
cp .env.example .env
```

Edit `.env` and set at least `VIDEOS_DIR` to the folder where downloads should live.

## Usage

### Scrape a channel

```bash
npm run scrape -- scrape https://www.youtube.com/@channel/videos
npm run scrape -- scrape https://www.youtube.com/@channel/videos --show   # visible browser
```

### Scrape the predefined channels

The list lives in `DEFAULT_CHANNELS` inside [`video_scraper.js`](./video_scraper.js).

```bash
npm run scrape -- scrape-all
```

### Run the dashboard

```bash
npm start
# http://localhost:3000
```

### Migrate a legacy JSON database

```bash
node db/migrate.js
```

## Configuration

All settings are optional except `VIDEOS_DIR`.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `VIDEOS_DIR` | `./VIDEOS` | Destination folder for downloads |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `COOKIES_FILE` | `./cookies.txt` | Netscape-format cookie file |
| `COOKIES_FROM_BROWSER` | — | e.g. `firefox`, `chrome`, `edge` |
| `COOKIES_REFRESH_SCRIPT` | — | script executed when yt-dlp hits `403` |
| `DENO_PATH` | `~/.deno/bin/deno` | Deno binary used by yt-dlp |
| `MAX_SCROLLS` | `20` | Scraper scroll depth |
| `SCROLL_WAIT_MS` | `400` | Delay between scrolls |
| `SCROLL_LOAD_WAIT_MS` | `1200` | Wait after the last scroll |
| `THUMBNAIL_MAX_ROUNDS` | `6` | Thumbnail retry rounds |
| `THUMBNAIL_WAIT_MS` | `600` | Delay between thumbnail rounds |
| `IMAGE_LOAD_TIMEOUT_MS` | `3000` | Per-image timeout |
| `MAX_RETRIES` | `3` | Navigation retries |
| `RETRY_DELAY_MS` | `2000` | Base backoff delay |

## HTTP API

| Method | Route | Description |
|---|---|---|
| `GET` | `/` | Dashboard |
| `GET` | `/status` | Server, `yt-dlp` and disk status |
| `GET` | `/videos` | All channels and videos |
| `GET` | `/downloads/active` | In-flight downloads |
| `GET` | `/events` | SSE stream (`progress`, `completed`, `error`) |
| `POST` | `/sync` | Reconcile DB state with files on disk |
| `GET` | `/download?channel=<name>&video=<id>` | Queue a download |

## Project structure

```
server.js          Express server, SSE hub, yt-dlp orchestration
video_scraper.js   Playwright scraper and CLI
db/sqlite.js       SQLite data layer
db/migrate.js      JSON -> SQLite migration
docs/index.html    Dashboard (vanilla JS + Tailwind CDN)
```

## Legal notice

This project is **not affiliated with, endorsed by, or sponsored by YouTube or Google**.

It is intended for personal archiving and research on content you are allowed to access. Downloading videos may violate the terms of service of the platform and/or copyright law in your jurisdiction. You are responsible for how you use it.

The repository **does not include** downloaded media, cookies, credentials or scraped databases. Those are generated locally and ignored by Git.

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) and our [Code of Conduct](./CODE_OF_CONDUCT.md). Security issues: [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 Jhon Alex Fernandez Arenas

# Contributing

Thanks for taking the time to contribute. This is a small, single-maintainer project, so clear and focused contributions are especially appreciated.

## Before you start

- **Bugs:** open an issue with the command you ran, the expected result, the actual result, and the relevant log lines (redact cookies, tokens and personal paths).
- **Features:** open an issue first so we can agree on the approach before you invest time in a PR.
- **Security issues:** do **not** open a public issue — follow [SECURITY.md](./SECURITY.md).

## Development setup

```bash
git clone https://github.com/Alex-Fernandez-Arenas/scraping-download-video.git
cd scraping-download-video
npm install
npx playwright install chromium
cp .env.example .env
```

Requirements: Node.js >= 20 and `yt-dlp` available in `PATH`.

## Project conventions

- ES modules (`import`/`export`), no build step, no transpiler.
- Logging goes through `pino`; avoid `console.log` in server and scraper code.
- Keep the HTTP layer (`server.js`), scraping logic (`video_scraper.js`) and persistence (`db/`) separated.
- Any new external input used to build a filesystem path must go through `sanitizeChannelName`.
- Never commit `.env`, `cookies.txt`, `*.sqlite`, downloaded media or logs. They are already in `.gitignore`.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make the change, keeping the diff focused on one topic.
3. Test it locally: `npm start` plus the affected CLI command.
4. Update `README.md` / `.env.example` if you add configuration or endpoints.
5. Describe **what** changed and **why** in the PR body. Screenshots help for dashboard changes.

## Commit messages

Short imperative subject (for example `Fix channel path traversal`), and a body explaining the motivation when it is not obvious.

## Reporting scraping breakage

YouTube changes its DOM regularly. If scraping breaks, include:

- the channel URL,
- the failing selector or error message,
- whether `--show` (visible browser) reproduces it.

## License

By contributing you agree that your changes are released under the [MIT License](./LICENSE).

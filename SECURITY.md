# Security Policy

## Supported versions

This project is maintained on a best-effort basis. Fixes are applied to the
latest version on `main`.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting:
[Security → Advisories → Report a vulnerability](https://github.com/Alex-Fernandez-Arenas/scraping-download-video/security/advisories/new).

Include:

- a description of the issue and its impact,
- steps to reproduce (or a proof of concept),
- the affected version/commit,
- any suggested remediation.

You can expect an acknowledgement within a few days. Please allow time for a
fix to be released before publishing details.

## Scope

The most relevant areas:

- **Path handling** — the `channel` query parameter is used to build download
  paths; it is sanitized with `sanitizeChannelName`, but bypasses are in scope.
- **Local file exposure** — the HTTP server must never serve `.env`,
  `cookies.txt`, the SQLite database or any file outside `docs/`.
- **Command execution** — `yt-dlp` is spawned with an argument array (no shell),
  and video IDs are validated against `^[\w-]{11}$`.

## Out of scope

- Rate limiting or authentication: the dashboard is designed to run on
  `localhost` and has neither. Do not expose it to the public internet.
- Issues caused by running the server as root or with an overly permissive
  `VIDEOS_DIR`.

## Handling secrets

Never include real cookies, API keys or personal paths in a report. Redact
tokens before pasting logs.

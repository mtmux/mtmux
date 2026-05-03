<div align="center">

<img src="https://ccremote.dev/opengraph-image" alt="ccremote — Your Claude. Your terminal. Anywhere." width="640" />

# ccremote

**Your Claude. Your terminal. Anywhere.**

Self-hosted browser terminal for [Claude Code](https://www.anthropic.com/claude-code). Connect to your tmux sessions from any device — phone, tablet, laptop — over a single secure WebSocket. One npm install away.

[![npm](https://img.shields.io/npm/v/ccremote?color=e87958)](https://www.npmjs.com/package/ccremote)
[![CI](https://github.com/nicholasgriffintn/ccremote/actions/workflows/ci.yml/badge.svg)](https://github.com/nicholasgriffintn/ccremote/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-2496ED)](https://github.com/nicholasgriffintn/ccremote/pkgs/container/ccremote)

[Website](https://ccremote.dev) · [Docs](https://ccremote.dev/docs) · [Demo](https://ccremote.dev#demo)

</div>

---

## Install

```bash
npm install -g ccremote
ccremote start
```

That's it. ccremote auto-generates a token, opens your browser, and connects you to tmux.

<details>
<summary>Other package managers & Docker</summary>

```bash
bun install -g ccremote
pnpm add -g ccremote
docker run -p 14100:14100 ghcr.io/nicholasgriffintn/ccremote
```
</details>

## Why ccremote?

| | ccremote | ttyd / GoTTY | Web SSH | tmate |
|---|---|---|---|---|
| Mobile-first UX | ✓ | — | — | — |
| File browser + Monaco editor | ✓ | — | — | — |
| Single-port (HTTP + WS) | ✓ | ✓ | ✓ | — |
| Self-hosted | ✓ | ✓ | ✓ | optional |
| WebGL terminal | ✓ | — | — | — |
| Built for Claude Code workflows | ✓ | — | — | — |

## Features

- **True terminal fidelity** — xterm.js + WebGL, Unicode 11, 256-color
- **Mobile-first** — keyboard toolbar, swipe gestures, haptic feedback
- **Files + previews** — Monaco editor, syntax highlighting, image preview
- **Self-hosted** — your machine, your tmux, your token. No third party.
- **Single port** — HTTP and WS share one upstream behind nginx/Caddy
- **PWA** — installable on iOS/Android home screens

## Quick start

```bash
ccremote start              # localhost:14100, auto-token, opens browser
ccremote start --host 0.0.0.0 --port 8080
ccremote token print        # show current token
ccremote token rotate       # generate a new one
ccremote --help
```

## Behind a reverse proxy

Single-port means a single upstream. Nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:14100;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
}
```

Caddy:

```caddy
ccremote.example.com {
  reverse_proxy 127.0.0.1:14100
}
```

## Configuration

| Flag / Env | Default | Description |
|---|---|---|
| `--port` / `PORT` | `14100` | HTTP+WS port |
| `--host` / `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to expose) |
| `--token` / `AUTH_TOKEN` | auto | Shared auth token |
| `--allowed-paths` / `ALLOWED_PATHS` | `$HOME` | Comma-separated path allow-list for the file browser |
| `--no-open` | — | Don't open the browser on start |

The auto-generated token is stored at `~/.ccremote/config.json` (mode `0600`).

## Architecture

One Node process, one HTTP server, three layers:

```
Browser  ⇄ wss/https ⇄  ccremote node  ⇄ pty ⇄  tmux
            (one port)   Next.js + ws        your sessions
```

[Read more →](https://ccremote.dev/docs/architecture)

## Development

```bash
pnpm install
pnpm dev          # web (14100), relay (14300), docs (14102)
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

The repo is a pnpm + Turborepo monorepo. See [CLAUDE.md](CLAUDE.md) for the full layout.

## Production deployments

The CLI is for self-host on a single machine. For multi-tenant or container deployments, the repo also ships:

- **Docker compose** (`docker-compose.prod.yml`) — separate web/relay services
- **PM2** (`ecosystem.config.cjs`) — multi-process production

## Contributing

PRs welcome. Conventional commits (`feat:`, `fix:`, `chore:`). See [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT © Nicholas Griffin

<div align="center">

# mtmux

**Your tmux, in any browser.**

Self-hosted browser terminal for [tmux](https://github.com/tmux/tmux). Connect to your sessions from any device — phone, tablet, laptop — over a single secure WebSocket. Works great with [Claude Code](https://www.anthropic.com/claude-code), Vim, REPLs, and long-running jobs. One npm install away.

[![npm](https://img.shields.io/npm/v/mtmux?color=e87958)](https://www.npmjs.com/package/mtmux)
[![CI](https://github.com/GagnDeep/tmuxremote/actions/workflows/ci.yml/badge.svg)](https://github.com/GagnDeep/tmuxremote/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-2496ED)](https://github.com/GagnDeep/tmuxremote/pkgs/container/tmuxremote)

[GitHub](https://github.com/GagnDeep/tmuxremote) · [npm](https://www.npmjs.com/package/mtmux)

</div>

---

## Install

```bash
npm install -g mtmux
mtmux start
```

That's it. mtmux auto-generates a token, opens your browser, and connects you to tmux on the same machine. No config file, no Docker, no reverse proxy.

<details>
<summary>Other package managers & Docker</summary>

```bash
bun install -g mtmux
pnpm add -g mtmux
docker run -p 14100:14100 ghcr.io/gagndeep/tmuxremote
```

</details>

## Why mtmux?

|                                 | mtmux | ttyd / GoTTY | Web SSH | tmate    |
| ------------------------------- | ----- | ------------ | ------- | -------- |
| Mobile-first UX                 | ✓     | —            | —       | —        |
| File browser + Monaco editor    | ✓     | —            | —       | —        |
| Single-port (HTTP + WS)         | ✓     | ✓            | ✓       | —        |
| Self-hosted                     | ✓     | ✓            | ✓       | optional |
| WebGL terminal                  | ✓     | —            | —       | —        |
| Built for Claude Code workflows | ✓     | —            | —       | —        |

## Features

- **True terminal fidelity** — xterm.js + WebGL, Unicode 11, 256-color
- **Mobile-first** — keyboard toolbar, swipe gestures, haptic feedback
- **Files + previews** — Monaco editor, syntax highlighting, image preview
- **Self-hosted** — your machine, your tmux, your token. No third party.
- **Single port** — HTTP and WS share one upstream behind nginx/Caddy
- **PWA** — installable on iOS/Android home screens

## Quick start

```bash
mtmux start                    # localhost:14100, auto-token, opens browser
mtmux start --host 0.0.0.0 --port 8080
mtmux start --no-open          # don't open the browser
mtmux token print              # show current token
mtmux token rotate             # generate a new one
mtmux token set <value>        # set a specific token
mtmux --help
```

## Behind a reverse proxy

The CLI is **single-port**: HTTP and the WebSocket (served same-origin at
`/_relay`) share one upstream, so you proxy everything to one port. Do **not**
set `NEXT_PUBLIC_RELAY_URL` and do **not** add a separate `/ws` location in CLI
mode — that's only for the split web+relay deployment (see
[Production deployments](#production-deployments)).

Nginx:

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
mtmux.example.com {
  reverse_proxy 127.0.0.1:14100
}
```

## Configuration

| Flag / Env                          | Default     | Description                                          |
| ----------------------------------- | ----------- | ---------------------------------------------------- |
| `--port` / `PORT`                   | `14100`     | HTTP+WS port                                         |
| `--host` / `HOST`                   | `127.0.0.1` | Bind address (`0.0.0.0` to expose)                   |
| `--token` / `AUTH_TOKEN`            | auto        | Shared auth token (one-shot override)                |
| `--allowed-paths` / `ALLOWED_PATHS` | `$HOME`     | Comma-separated path allow-list for the file browser |
| `--no-open`                         | —           | Don't open the browser on start                      |

The auto-generated token is stored at `~/.mtmux/config.json` (mode `0600`).

## Architecture

One Node process, one HTTP server, three layers:

```
Browser  ⇄ wss/https ⇄  mtmux node  ⇄ pty ⇄  tmux
            (one port)   Next.js + ws         your sessions
```

[Read more →](apps/docs/content/docs/architecture.mdx)

## Development

```bash
pnpm install
pnpm dev          # web + relay on ONE port (14100), same as `mtmux start`
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

`pnpm dev` runs the shipped single-port topology — Next.js (Turbopack, with
HMR) and the relay in one process, relay WebSocket at `/_relay` — so single-port
bugs surface while you work rather than at release. It prints a login URL with
the dev token (`dev-token`) baked in. Override the port with `PORT=…`.

Two escape hatches:

```bash
pnpm dev:split    # the split model: web 14100 + relay 14300 (Docker/PM2 shape)
pnpm dev:docs     # docs site on 14102
```

The repo is a pnpm + Turborepo monorepo. See [CLAUDE.md](CLAUDE.md) for the full layout.

## Production deployments

The CLI (`mtmux start`) is the primary path for self-hosting on a single
machine: one process, one port, WebSocket at `/_relay`. For multi-tenant or
container deployments, the repo also ships a **split web+relay** model with
separate ports (web `14100`, relay `14300`), configured via
`NEXT_PUBLIC_RELAY_URL` and a `/ws` reverse-proxy route:

- **Docker compose** (`docker-compose.prod.yml`) — separate web/relay services
- **PM2** (`ecosystem.config.cjs`) — multi-process production

See [Deployment](apps/docs/content/docs/deployment.mdx) for the split-model details.

## Contributing

PRs welcome. Conventional commits (`feat:`, `fix:`, `chore:`). See [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT

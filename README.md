<p align="center">
  <h1 align="center">ccremote</h1>
  <p align="center">Access Claude Code from Any Browser</p>
</p>

<p align="center">
  <a href="https://github.com/nicholasgriffintn/ccremote/actions/workflows/ci.yml"><img src="https://github.com/nicholasgriffintn/ccremote/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/nicholasgriffintn/ccremote/blob/main/LICENSE"><img src="https://img.shields.io/github/license/nicholasgriffintn/ccremote" alt="License"></a>
  <a href="https://github.com/nicholasgriffintn/ccremote/pkgs/container/ccremote-web"><img src="https://img.shields.io/badge/docker-ghcr.io-blue" alt="Docker"></a>
</p>

---

**ccremote** is a remote terminal-in-browser app that connects a modern web UI to tmux sessions over WebSocket. Monitor Claude Code sessions, manage terminals, browse files, and code from your phone — all self-hosted.

## Features

- **Remote Terminal** — Full xterm.js terminal with WebGL rendering, themes, search, and Unicode support
- **Session Management** — Create, attach, rename, and kill tmux sessions from the browser
- **File Browser & Editor** — Browse directories, preview files with syntax highlighting, and edit remotely
- **Mobile Optimized** — Responsive UI with swipe gestures, virtual keyboard toolbar, and tab navigation
- **Self-Hosted** — Run on your own server with Docker or PM2, no third-party dependencies
- **Claude Code Ready** — Purpose-built for monitoring and interacting with Claude Code terminal sessions

## Quick Start

```bash
git clone https://github.com/nicholasgriffintn/ccremote.git
cd ccremote
pnpm setup    # Install deps + create .env
pnpm dev      # Start web (14100) + relay (14300) + docs (14102)
```

Open `http://localhost:14100`, enter your auth token, and connect.

## Docker Deployment

```bash
# Clone and configure
git clone https://github.com/nicholasgriffintn/ccremote.git
cd ccremote
cp .env.example .env

# Generate a strong auth token and paste it into .env (AUTH_TOKEN=...)
openssl rand -hex 32

# Edit .env — at minimum set AUTH_TOKEN, CORS_ORIGINS, NEXT_PUBLIC_RELAY_URL

# Start the full stack (web + relay + docs)
docker compose -f docker-compose.prod.yml up -d
```

> The relay server **refuses to boot** in production with the default
> `change-me-in-production` token — set `AUTH_TOKEN` before `up -d`.

### Deploy with nginx + TLS

Bundled nginx configs live in [`nginx/`](nginx/README.md):

```bash
# Docker sidecar (brings up nginx alongside web/relay/docs)
docker compose -f docker-compose.prod.yml --profile nginx up -d
```

For standalone-host deployments use `nginx/ccremote.conf.example` as a
starting point. See [`nginx/README.md`](nginx/README.md) for both flows.

### Pre-built images

```bash
docker pull ghcr.io/nicholasgriffintn/ccremote-web:latest
docker pull ghcr.io/nicholasgriffintn/ccremote-relay:latest
```

## Configuration

### Relay Server

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_PORT` | `14300` | WebSocket server port |
| `RELAY_HOST` | `0.0.0.0` | Bind address |
| `AUTH_TOKEN` | `change-me-in-production` | Client authentication token |
| `ALLOWED_PATHS` | `/home` | Comma-separated accessible paths |
| `TMUX_SOCKET` | _(default)_ | Custom tmux socket path |
| `TMUX_DEFAULT_SHELL` | `/bin/bash` | Default shell for new sessions |
| `WS_RATE_LIMIT` | `100` | Max messages per rate-limit window |
| `IDLE_TIMEOUT_MINUTES` | `30` | Idle connection timeout |
| `CORS_ORIGINS` | `http://localhost:14100` | Allowed origins |

### Web App

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_RELAY_URL` | `ws://localhost:14300` | Relay WebSocket URL |

## Architecture

```
┌─────────────┐    WebSocket     ┌──────────────┐    PTY/exec    ┌──────────┐
│   Browser    │ ◄─────────────► │ Relay Server │ ◄────────────► │   tmux   │
│  (Next.js)   │    Protocol     │  (Node.js)   │               │  (host)  │
└─────────────┘                  └──────────────┘               └──────────┘
```

The **web app** renders the terminal UI and communicates over a typed WebSocket protocol (`@repo/protocol`). The **relay server** bridges messages to tmux sessions and PTY streams on the host.

## Mobile Support

ccremote is built mobile-first:
- Swipe between terminal, sessions, and files
- Virtual keyboard toolbar with common keys (Tab, Ctrl, Esc, arrows)
- Landscape mode for wider terminal
- Copy mode with text selection
- Haptic feedback on interactions

## Apps

| App | Port | Description |
|-----|------|-------------|
| `web` | 14100 | Terminal web client |
| `relay` | 14300 | WebSocket relay server |
| `docs` | 14102 | Documentation site |

## Development

### Prerequisites

- Node.js 22+
- pnpm 9+
- tmux 3.0+

### Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all apps |
| `pnpm build` | Build all apps |
| `pnpm lint` | Lint everything |
| `pnpm typecheck` | Type check |
| `pnpm test` | Run tests |
| `pnpm docker:dev` | Dev containers |
| `pnpm docker:prod` | Production containers |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Changelog

Notable changes are tracked in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)

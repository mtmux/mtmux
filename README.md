# TermBridge

Access your server's terminal from any browser. TermBridge connects a modern web UI to remote tmux sessions over WebSocket, giving you a full terminal experience with session management, file browsing, and mobile support.

## Features

- **Remote Terminal**: Full xterm.js terminal with WebGL rendering, themes, and search
- **Session Management**: Create, attach, rename, and kill tmux sessions
- **File Browser**: Browse and preview files on the remote host
- **Mobile Support**: Responsive UI with swipe gestures, keyboard toolbar, and tab navigation
- **Real-time**: WebSocket protocol with automatic reconnection and keep-alive
- **Secure**: Token-based auth, path restrictions, rate limiting

## Architecture

```
Browser ←→ WebSocket ←→ Relay Server ←→ tmux/PTY
  (Next.js)              (Node.js)       (host)
```

The **web app** renders the terminal UI and communicates over a typed WebSocket protocol. The **relay server** bridges WebSocket messages to tmux sessions and PTY streams on the host machine.

## Prerequisites

- Node.js 22+
- pnpm 9+
- tmux 3.0+
- Docker (optional, for dev services)

## Quick Start

```bash
# Clone and install
git clone <repo-url> termbridge
cd termbridge
pnpm install

# Configure
cp .env.example .env
# Edit .env — at minimum set AUTH_TOKEN

# Generate Prisma client
pnpm db:generate

# Start development
pnpm dev
```

Open `http://localhost:14100` in your browser, enter your auth token, and connect.

## Configuration

### Relay Server (`apps/relay`)

| Env Var | Default | Description |
|---------|---------|-------------|
| `RELAY_PORT` | `14300` | WebSocket server port |
| `RELAY_HOST` | `0.0.0.0` | Host to bind to |
| `AUTH_TOKEN` | `change-me-in-production` | Client authentication token |
| `ALLOWED_PATHS` | `/home` | Comma-separated paths clients can access |
| `TMUX_SOCKET` | _(default)_ | Custom tmux socket path |
| `TMUX_DEFAULT_SHELL` | `/bin/bash` | Default shell for new sessions |
| `WS_RATE_LIMIT` | `100` | Max messages per rate-limit window |
| `IDLE_TIMEOUT_MINUTES` | `30` | Idle connection timeout |
| `CORS_ORIGINS` | `http://localhost:14100` | Comma-separated allowed origins |

### Web App (`apps/web`)

| Env Var | Default | Description |
|---------|---------|-------------|
| `NEXT_PUBLIC_RELAY_URL` | `ws://localhost:14300` | Relay server WebSocket URL |

## Apps

| App | Port | Description |
|-----|------|-------------|
| `web` | 14100 | Terminal web client |
| `docs` | 14102 | Documentation site |
| `relay` | 14300 | WebSocket relay server |

## Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all apps in development |
| `pnpm build` | Build all apps |
| `pnpm lint` | Lint everything |
| `pnpm typecheck` | Type check everything |
| `pnpm test` | Run tests |
| `pnpm db:generate` | Generate Prisma client |
| `pnpm db:push` | Push schema to database |
| `pnpm db:seed` | Seed database |
| `pnpm db:studio` | Open Prisma Studio |
| `pnpm docker:dev` | Start dev services |
| `pnpm docker:prod` | Start production Docker compose |
| `pnpm setup` | Full setup (install, generate, push, seed) |

## Repository Structure

```
apps/
├── web/              → Terminal web client (Next.js 15)
├── relay/            → WebSocket relay server (Node.js)
├── docs/             → Documentation site (Next.js + Fumadocs)
├── admin/            → Admin dashboard
├── api/              → Standalone API (Hono)
└── temporal-worker/  → Background job worker

packages/
├── protocol/         → Typed WebSocket message schemas (Zod)
├── ui/               → Shared UI components (shadcn/ui)
├── db/               → Prisma schema + client
├── auth/             → Authentication (better-auth)
├── api/              → tRPC routers
├── logger/           → Pino logger
├── config/           → Shared env + constants
└── ...               → email, storage, ai, websockets, temporal
```

## Deployment

### PM2

```bash
pnpm build
pm2 start ecosystem.config.cjs
```

### Docker

```bash
pnpm docker:prod
```

See `apps/docs` for full deployment documentation.

## License

MIT

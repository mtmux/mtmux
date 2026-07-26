# CLAUDE.md — mtmux

The shipped product is the **`mtmux`** npm CLI (`apps/cli`) — `npm install -g mtmux` then `mtmux start`. It bundles the web client and relay into one process on a single port. The other apps/packages are the source that CLI builds from, plus a split web+relay model for container/PM2 deployments.

## Tech Stack

- **Runtime**: Node.js 22, pnpm workspaces, Turborepo
- **Frontend**: Next.js 15 (App Router), React 19, Tailwind CSS 4, shadcn/ui
- **Real-time**: Custom WebSocket protocol (@repo/protocol) with Zod schemas
- **Terminal**: xterm.js with WebGL rendering, search addon, Unicode 11
- **Relay Server**: Node.js WebSocket server bridging to tmux via PTY
- **State Management**: Zustand (persisted stores for terminal settings, commands, settings)

## Repository Structure

- `apps/cli` — The published **`mtmux`** CLI (primary product); bundles web + relay into one single-port process (`mtmux start`). Also hosts `scripts/dev.mjs`, the single-port dev server behind `pnpm dev`
- `apps/web` — Terminal web client (Next.js 15, port 14100)
- `apps/relay` — WebSocket relay server (Node.js, port 14300 — split mode only; single-port mode serves it at `/_relay`)
- `apps/docs` — Documentation site (Next.js + Fumadocs, port 14102)
- `packages/protocol` — Typed WebSocket message schemas (Zod discriminated unions)
- `packages/ui` — shadcn/ui components + terminal themes
- `packages/logger` — Pino logger
- `packages/config` — Shared env + constants
- `tooling/` — Dev tooling configs (@repo/tsconfig, @repo/eslint-config, @repo/prettier-config)
- `docker/` — Dockerfiles (multi-stage builds)
- `scripts/` — Setup and dev helper scripts

## Key Commands

```bash
pnpm dev              # Web + relay on ONE port (14100), like `mtmux start`
pnpm dev:split        # Split model: web 14100 + relay 14300 (Docker/PM2 shape)
pnpm dev:docs         # Docs site (14102)
pnpm build            # Build all apps
pnpm lint             # Lint all packages
pnpm typecheck        # Type check all packages
pnpm test             # Run tests
pnpm clean            # Clean build artifacts
pnpm kill-ports       # Kill processes on dev ports
pnpm dev:restart      # Kill ports and restart dev
pnpm docker:dev       # Start dev Docker services
pnpm docker:prod      # Start production Docker compose
pnpm setup            # Full setup (install + env)
```

## Naming Conventions

- Internal packages: `@repo/*` (e.g., `@repo/ui`, `@repo/protocol`)
- Apps: `@app/*` (e.g., `@app/web`, `@app/relay`, `@app/docs`)
- All packages use `type: "module"` (ESM)
- File extensions in imports: use `.js` extension for local imports

## Patterns

### UI

Components from `@repo/ui`, apps import `@repo/ui/globals.css` for theming.

### Theming

CSS variables (oklch), never use raw Tailwind colors — always semantic classes (bg-background, text-foreground, etc.).

### Env

Validated with zod via @t3-oss/env-core (packages) and @t3-oss/env-nextjs (apps).

### Relay Architecture

The relay server (`apps/relay`) bridges WebSocket connections to tmux sessions:

1. Client connects via WebSocket and authenticates with a token
2. Authenticated messages are routed through `message-router.ts`
3. Session operations use `tmux-manager.ts` (execFile to tmux CLI)
4. Terminal I/O uses `pty-bridge.ts` (node-pty attached to tmux sessions)
5. File operations use `file-service.ts` with path allow-listing

### Protocol Message Pattern

All messages are defined as Zod discriminated unions in `@repo/protocol`:

- `ClientMessage` — 20+ message types from client to server
- `ServerMessage` — 15+ message types from server to client
- Serialized as JSON, validated on both ends

### Zustand Store Pattern

State management uses Zustand stores in `apps/web/src/stores/`:

- `connection-store` — WebSocket connection status, latency
- `session-store` — tmux session list, active session
- `terminal-store` — persisted terminal settings (font, theme, cursor)
- `file-store` — file browser state
- `command-store` — persisted command history and snippets
- `settings-store` — persisted UI settings (toolbar keys, gestures)
- `ui-store` — transient UI state (mobile tab)

### Terminal Component Hierarchy

```
(terminal)/layout.tsx  → Auth guard, WebSocket init, app shell
  └─ (terminal)/page.tsx → Layout (sidebar + terminal + file preview)
       ├─ TerminalToolbar → Session name, search, fullscreen, settings
       ├─ TerminalView → xterm.js instance, session attach/detach
       ├─ SessionList → Session cards with attach/kill
       └─ FileTree → Directory browser with sort/filter
```

## Adding a New Package

1. Create `packages/<name>/package.json` with `"name": "@repo/<name>"`
2. Add `tsconfig.json` extending appropriate `@repo/tsconfig/*`
3. Add `eslint.config.js` extending `@repo/eslint-config/*`
4. Export via `src/index.ts`

## Adding a Protocol Message

1. Add Zod schema to `packages/protocol/src/client-messages.ts` or `server-messages.ts`
2. Add to the discriminated union
3. Handle in relay's `message-router.ts` (server messages)
4. Handle in web's `use-websocket.ts` hook (client messages)

## Commit Convention

Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
Scopes: `cli`, `web`, `docs`, `relay`, `protocol`, `ui`, `config`, `logger`, `infra`, `ci`

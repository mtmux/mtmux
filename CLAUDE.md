# CLAUDE.md — TermBridge

## Tech Stack
- **Runtime**: Node.js 22, pnpm workspaces, Turborepo
- **Frontend**: Next.js 15 (App Router), React 19, Tailwind CSS 4, shadcn/ui
- **Backend**: tRPC 11, Hono 4, Prisma 7 (SQLite dev / Postgres prod)
- **Auth**: better-auth with Prisma adapter
- **Real-time**: Custom WebSocket protocol (@repo/protocol) with Zod schemas
- **Terminal**: xterm.js with WebGL rendering, search addon, Unicode 11
- **Relay Server**: Node.js WebSocket server bridging to tmux via PTY
- **Background Jobs**: Temporal
- **Storage**: MinIO (dev) / S3 (prod) via AWS SDK
- **Email**: React Email + Resend
- **AI**: Vercel AI SDK 4
- **State Management**: Zustand (persisted stores for terminal settings, commands, settings)

## Repository Structure
- `apps/web` — Terminal web client (Next.js 15, port 14100)
- `apps/relay` — WebSocket relay server (Node.js, port 14300)
- `apps/docs` — Documentation site (Next.js + Fumadocs, port 14102)
- `apps/admin` — Admin dashboard
- `apps/api` — Standalone Hono API
- `apps/temporal-worker` — Background job worker
- `packages/protocol` — Typed WebSocket message schemas (Zod discriminated unions)
- `packages/ui` — shadcn/ui components + terminal themes
- `packages/db` — Prisma 7 schema + client
- `packages/auth` — better-auth config
- `packages/api` — tRPC routers
- `packages/logger` — Pino logger
- `packages/config` — Shared env + constants
- `tooling/` — Dev tooling configs (@repo/tsconfig, @repo/eslint-config, @repo/prettier-config)
- `docker/` — Dockerfiles (multi-stage builds)
- `scripts/` — Setup and dev helper scripts

## Key Commands
```bash
pnpm dev              # Start all apps in dev mode
pnpm build            # Build all apps
pnpm lint             # Lint all packages
pnpm typecheck        # Type check all packages
pnpm test             # Run tests
pnpm db:generate      # Generate Prisma client
pnpm db:push          # Push schema to database
pnpm db:seed          # Seed database
pnpm db:studio        # Open Prisma Studio
pnpm db:reset         # Reset and re-seed database
pnpm docker:dev       # Start dev Docker services (Temporal, MinIO)
pnpm docker:prod      # Start production Docker compose
pnpm setup            # Full setup (install, generate, push, seed)
```

## Naming Conventions
- Internal packages: `@repo/*` (e.g., `@repo/db`, `@repo/ui`, `@repo/protocol`)
- Apps: `@app/*` (e.g., `@app/web`, `@app/relay`, `@app/docs`)
- All packages use `type: "module"` (ESM)
- File extensions in imports: use `.js` extension for local imports

## Patterns

### Database
Singleton PrismaClient in `@repo/db`, imported everywhere.

### Auth
Server-side via `@repo/auth` (better-auth), client-side via `@repo/auth/client`.

### API
tRPC routers in `@repo/api`, mounted in Next.js apps and Hono.

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

## Adding a New tRPC Router
1. Create `packages/api/src/routers/<name>.ts`
2. Define router with `router()` and procedures
3. Add to `packages/api/src/root.ts` merged router

## Adding a Protocol Message
1. Add Zod schema to `packages/protocol/src/client-messages.ts` or `server-messages.ts`
2. Add to the discriminated union
3. Handle in relay's `message-router.ts` (server messages)
4. Handle in web's `use-websocket.ts` hook (client messages)

## Prisma
- Prisma 7 with `prisma.config.ts` using `defineConfig()`
- Multi-file schema in `packages/db/prisma/schema/`
- SQLite for dev, swap `provider` in base.prisma for Postgres in prod

## Commit Convention
Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
Scopes: `web`, `admin`, `docs`, `api`, `db`, `auth`, `ui`, `email`, `storage`, `ai`, `websockets`, `temporal`, `config`, `logger`, `infra`, `ci`, `relay`, `protocol`

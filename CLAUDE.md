# CLAUDE.md — mtmux

The shipped product is the **`mtmux`** npm CLI (`apps/cli`) — `npm install -g mtmux`, then `mtmux`. It bundles the web client and relay into one process on a single port. Everything else in this repo is either the source that CLI builds from, the hosted services that make pairing work over the internet, or the sites that document and sell it.

## The one-liner

`mtmux` serves the machine's tmux **and** opens a sealed tunnel, then prints a QR and a six-digit code. A phone anywhere scans it and is in. No port forwarding, no account, no SSH key on the phone.

## Tech Stack

- **Runtime**: Node.js 22, pnpm workspaces, Turborepo
- **Frontend**: Next.js 16 (App Router), React 19, Tailwind CSS 4, shadcn/ui
- **Real-time**: Custom WebSocket protocol (@repo/protocol) with Zod schemas
- **Terminal**: xterm.js with WebGL rendering, search addon, Unicode 11
- **Relay Server**: Node.js WebSocket server bridging to tmux via PTY
- **Broker**: Node.js `node:http` + `ws`, blind by construction (`apps/api`)
- **Crypto**: CPace PAKE (ristretto255) → HKDF-SHA256 → AES-256-GCM frames
- **Accounts**: better-auth + Drizzle + SQLite; billing via Dodo Payments
- **State**: Zustand (persisted stores for terminal settings, commands, settings)

## Repository Structure

- `apps/cli` — The published **`mtmux`** CLI (primary product); bundles web + relay into one single-port process. Also hosts `scripts/dev.mjs`, the single-port dev server behind `pnpm dev`
- `apps/web` — Terminal web client + account dashboard (Next 16, port 14100 dev / 24100 prod)
- `apps/api` — Pairing broker, tunnel, accounts and billing (14400 dev / 24400 prod)
- `apps/relay` — WebSocket relay server (14300 — split mode only; single-port mode serves it at `/_relay`)
- `apps/site` — Marketing site, mtmux.com (next-intl + MDX blog; dev 14101, prod 41317)
- `apps/docs` — Documentation site (Next.js + Fumadocs, 14102 dev / 24102 prod)
- `packages/protocol` — Typed WebSocket message schemas (Zod discriminated unions)
- `packages/crypto` — CPace, HKDF key schedule, sealed frame codec, device keys
- `packages/db` — Drizzle schema + SQLite handle for the broker
- `packages/config` — Shared env, constants, and **plan limits** (`@repo/config/plans`)
- `packages/ui` — shadcn/ui components + terminal themes
- `packages/logger` — Pino logger
- `tooling/` — Dev tooling configs (@repo/tsconfig, @repo/eslint-config, @repo/prettier-config)
- `docker/`, `scripts/` — Dockerfiles, setup and deploy helpers

## Key Commands

```bash
pnpm dev              # Web + relay on ONE port (14100), like `mtmux start`
pnpm dev:pairing      # Adds the broker, so /pair and the tunnel actually work
pnpm dev:split        # Split model: web 14100 + relay 14300 (Docker/PM2 shape)
pnpm dev:docs         # Docs site (14102)
pnpm build            # Build all apps
pnpm build:hosted     # Build web + api with the production API origin baked in
pnpm prepare:standalone  # Copy static assets into the Next standalone tree
pnpm deploy:hosted    # build → verify the origin is in the bundle → stage → pm2 reload
pnpm lint / typecheck / test
pnpm release          # Bump, commit and tag the CLI
```

## Non-negotiable invariants

Break these and the product's central claim is false.

1. **The four-digit secret never reaches the broker** — not in a request, not as a hash. 10⁶ is an instant offline search.
2. **The broker logs counts and outcomes only.** No code, slot, mailbox id, ciphertext, or IP-to-mailbox mapping. A breach or a subpoena must yield nothing useful.
3. **Browser key material lives in IndexedDB**, never `localStorage`.
4. **The self-hosted path stays fully functional with zero contact with our servers.** `mtmux start` with no route to `api.mtmux.com` must degrade to LAN serving, never fail. `--local` makes that explicit.
5. **Accounts are optional forever.** Anonymous pairing must never regress.
6. **Never hand-edit nginx.** See the `cloudflare-cfx` skill; `http.conf` is read-only, and `mtmux.com`'s vhost lives there.
7. **Plan limits live only in `packages/config/src/plans.ts`.** No threshold is hard-coded anywhere else.
8. **Ports and PM2 app names are load-bearing** — nginx points at them. `mtmux-web` 41317, `mtmux-app` 24100, `mtmux-api` 24400, `mtmux-docs` 24102.

## Patterns

### UI

Components from `@repo/ui`; apps import `@repo/ui/globals.css` for theming.

### Theming

CSS variables (oklch), never raw Tailwind colors — always semantic classes (`bg-background`, `text-foreground`, …).

### Env

Validated with zod via @t3-oss/env-core (packages) and @t3-oss/env-nextjs (apps). `NEXT_PUBLIC_*` is inlined by Next **at build time** — a runtime env var cannot fix a bundle built without it, which is why `deploy:hosted` greps the built bundle for the API origin before it deploys.

### Relay Architecture

The relay (`apps/relay`) bridges WebSocket connections to tmux:

1. Client connects and authenticates with a token
2. Authenticated messages route through `message-router.ts`
3. Session operations use `tmux-manager.ts` (execFile to tmux)
4. Terminal I/O uses `pty-bridge.ts` (node-pty attached to tmux)
5. File operations use `file-service.ts` with path allow-listing

### Pairing and the tunnel

The code is `slot(2) + secret(4)`. The broker mints the slot and routes on it; the secret is the CPace password and stays on the two endpoints. Both directions work — the CLI can host a pairing (what `mtmux start` does) or join one a browser started (`mtmux pair`). After CPace, HKDF derives `{c2s, s2c, confirm, directToken}`; frames are AES-256-GCM with a per-direction nonce and a monotonic counter that rejects replays. The CLI agent binds an incoming tunnel stream to a pairing by **trial decryption**, which is what lets the broker stay blind.

### Protocol Message Pattern

Zod discriminated unions in `@repo/protocol`: `ClientMessage`, `ServerMessage`, plus the pairing and tunnel schemas. Serialized as JSON, validated on both ends.

### Zustand Store Pattern

Stores in `apps/web/src/stores/`: `connection`, `session`, `terminal`, `file`, `command`, `settings`, `ui`, `pane`, `alert`.

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
2. Add `tsconfig.json` extending the appropriate `@repo/tsconfig/*`
3. Add `eslint.config.js` extending `@repo/eslint-config/*`
4. Export via `src/index.ts`

## Adding a Protocol Message

1. Add the Zod schema to `packages/protocol/src/client-messages.ts` or `server-messages.ts`
2. Add it to the discriminated union
3. Handle it in the relay's `message-router.ts`
4. Handle it in the web's `use-websocket.ts` hook

## Commit Convention

Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
Scopes (enforced by `commitlint.config.js`): `cli`, `web`, `site`, `docs`, `relay`, `api`, `protocol`, `crypto`, `db`, `ui`, `config`, `logger`, `infra`, `ci`, `deps`

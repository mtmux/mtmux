# AGENTS.md — mtmux

The shipped product is the **`mtmux`** npm CLI (`apps/cli`). Everything else is
either the source it is built from, the hosted service around it, or the sites
that document and sell it.

## Repository Map

```
mtmux/
├── apps/cli/              → Published `mtmux` CLI; also `pnpm dev` (single port)
├── apps/web/              → Terminal web client (Next.js 16, port 14100)
├── apps/relay/            → WebSocket relay (served at /_relay; port 14300 in split mode)
├── apps/api/              → Blind pairing broker + tunnel relay (port 14400)
├── apps/docs/             → Documentation site, Fumadocs (port 14102)
├── apps/site/             → Marketing site, mtmux.com (port 41317 in prod)
├── packages/protocol/     → Zod message schemas: relay protocol + pairing/tunnel protocol
├── packages/crypto/       → CPace, HKDF key schedule, sealed frames, device keys, pairing codes
├── packages/db/           → Schema for the hosted accounts layer
├── packages/ui/           → shadcn/ui components + terminal themes
├── packages/logger/       → Pino logger
├── packages/config/       → Shared env + constants
├── tooling/               → ESLint, Prettier, TypeScript configs
├── docker/                → Multi-stage Dockerfiles
└── scripts/               → Dev, release and hosted-deploy scripts
```

Ownership note: `apps/site` has its own `.claude/skills` and its own
conventions. Do not edit it as a side effect of working elsewhere.

## How mtmux Works

### Single-port CLI

`mtmux start` runs one Node process serving the Next.js web client and the relay
WebSocket at `/_relay` on one port. `apps/cli/scripts/build.mjs` bundles the CLI
with esbuild and stages the web standalone server at `dist/web/apps/web/` and
the relay at `dist/relay/runtime.js`.

The default bind address is decided by `resolveHost` in
`apps/cli/src/commands/start.ts`: `0.0.0.0` when `primaryLanAddress()` finds a
usable private IPv4 on a non-virtual interface, `127.0.0.1` otherwise.

### Pairing and the tunnel

- Six-digit code = **slot(2) + secret(4)**. The broker mints the slot; the
  secret is generated locally, is the CPace password, and never reaches the
  broker — not even hashed.
- `packages/crypto`: CPace (`CPACE-RISTR255-SHA512`) → HKDF-SHA-256 key schedule
  → AES-256-GCM frames with a per-direction nonce and a monotonic counter.
- `apps/cli/src/tunnel-agent.ts` is the cryptographic peer, **not the relay**.
  It unseals frames from the broker and speaks plain relay JSON to a loopback
  socket, so nothing about the tunnel can regress the self-hosted path.
- A failed key confirmation destroys the mailbox. One wrong guess burns the code
  — that is the whole security argument, so do not add a retry anywhere.

### Terminal components

`apps/web/src`:

- `components/terminal/terminal-view.tsx` — the xterm.js instance and attach
  lifecycle
- `components/session/session-list.tsx` — session cards
- `hooks/use-websocket.ts` — server-message routing
- `lib/ws-client.ts` — `RelayClient`, reconnect, ping/pong, pending queue
- `lib/transport.ts` — `DirectTransport` and `SealedTransport`
- `lib/candidate-race.ts` — direct-path racing
- `lib/relay-url.ts` — which of the three connection modes applies
- `stores/` — Zustand: connection, session, pane, terminal, file, command,
  settings, ui, alert

### Protocol

`packages/protocol/src/`:

- `client-messages.ts` — browser → relay (44 types)
- `server-messages.ts` — relay → browser (24 types)
- `pairing-messages.ts` — browser/CLI ↔ broker. **Deliberately separate.**
- `codec.ts` — serialize/deserialize with Zod validation

### Relay

`apps/relay/src/`:

- `server.ts` — `/health`, `/_pair/local`, `/_pair/session`, `/file`
- `ws-server.ts` — upgrade, origin check, payload cap
- `wire-connections.ts` — auth deadline, rate limit, ping/pong, idle reaper
- `auth.ts` / `auth-throttle.ts` — token comparison and lockout
- `pairing-local.ts` — LAN nonces and scoped session tokens
- `message-router.ts` — routes authenticated messages to handlers
- `tmux-manager.ts` — tmux CLI operations
- `pty-bridge.ts` — node-pty bridge
- `file-service.ts` — path allow-listing
- `config.ts` — Zod-validated env, fail-fast

### Broker

`apps/api/src/`: `server.ts`, `broker.ts`, `mailbox.ts`, `tunnel.ts`,
`rate-limit.ts`, `config.ts`, plus the optional `accounts/` and `billing/`
layers. It must run as a **single fork-mode process** — mailboxes, claims and
tunnel sockets are in memory.

## How to Add a Protocol Message

1. Define the Zod schema in `packages/protocol/src/client-messages.ts` or
   `server-messages.ts` (or `pairing-messages.ts` for broker traffic).
2. Add it to the discriminated union.
3. Add a handler in `apps/relay/src/message-router.ts` (client messages).
4. Add a handler in `apps/web/src/hooks/use-websocket.ts` (server messages).
5. Update `apps/docs/content/docs/relay/protocol.mdx`.

## How to Add a Package

1. Create the directory under `packages/`.
2. `package.json` with `@repo/<name>`, `"private": true`, `"type": "module"`.
3. Extend `@repo/tsconfig/library.json` (or `node.json` for Node-only).
4. Extend `@repo/eslint-config/base` (or `/react`).
5. Export from `src/index.ts`.
6. Consumers add `"@repo/<name>": "workspace:*"`.

## How to Modify Relay Handlers

1. Find the message type in `apps/relay/src/message-router.ts`.
2. Each `case` handles one `ClientMessage` type.
3. Use `send(ws, msg)` for responses, `sendError(ws, code, message)` for errors.
4. File operations must call the path guard before touching the disk.
5. Session operations go through `tmux-manager.ts`.

## Commit Convention

Conventional commits. **Scopes are enforced** by `commitlint.config.js`:

`cli`, `web`, `docs`, `relay`, `api`, `protocol`, `crypto`, `ui`, `config`,
`logger`, `infra`, `ci`, `deps`

## Review Checklist

- [ ] No raw Tailwind colors — semantic classes only (`bg-background`, `text-foreground`)
- [ ] Local imports use the `.js` extension
- [ ] Environment variables validated with Zod, fail-fast
- [ ] File access in the relay uses the path guard
- [ ] Protocol messages added to both schemas and both handlers
- [ ] Nothing in `apps/api` inspects a sealed payload
- [ ] Nothing teaches the relay about pairing keys or tunnels
- [ ] No new path gives a pairing code a second guess
- [ ] Commit scope is on the enforced list
- [ ] Docs updated when a flag, message or environment variable changes

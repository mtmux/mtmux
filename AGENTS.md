# AGENTS.md — ccremote

## Repository Map
```
ccremote/
├── apps/web/              → Terminal web client (Next.js 15, port 14100)
├── apps/relay/            → WebSocket relay server (Node.js, port 14300)
├── apps/docs/             → Documentation site (port 14102)
├── packages/protocol/     → WebSocket message schemas (Zod)
├── packages/ui/           → shadcn/ui components + terminal themes
├── packages/logger/       → Pino logger
├── packages/config/       → Shared env + constants
├── tooling/               → ESLint, Prettier, TypeScript configs
├── docker/                → Multi-stage Dockerfiles
└── scripts/               → Dev setup scripts
```

## How ccremote Works

### Terminal Components
The web client at `apps/web` uses xterm.js to render terminal output. Key files:
- `src/components/terminal/terminal-view.tsx` — xterm.js instance with WebGL, manages session attach/detach
- `src/components/terminal/terminal-toolbar.tsx` — Search, fullscreen, settings buttons
- `src/components/session/session-list.tsx` — Session sidebar with create/attach/kill
- `src/hooks/use-websocket.ts` — WebSocket connection management, message routing
- `src/lib/ws-client.ts` — RelayClient class with auto-reconnect
- `src/stores/` — Zustand stores for connection, session, terminal, file, command, settings, UI state

### Protocol Messages
All messages are in `packages/protocol/src/`:
- `client-messages.ts` — Messages from browser to relay (auth, session ops, terminal I/O, file ops)
- `server-messages.ts` — Messages from relay to browser (auth results, session events, terminal output, file data)
- `codec.ts` — Serialize/deserialize with Zod validation

### Relay Server
The relay at `apps/relay/src/`:
- `index.ts` — WebSocket server setup, auth handling, graceful shutdown
- `message-router.ts` — Routes authenticated messages to handlers
- `tmux-manager.ts` — tmux CLI operations (list, create, kill, rename sessions)
- `pty-bridge.ts` — node-pty bridge to tmux sessions for terminal I/O
- `file-service.ts` — File operations with path allow-listing
- `config.ts` — Zod-validated environment config

## How to Add a Protocol Message
1. Define Zod schema in `packages/protocol/src/client-messages.ts` or `server-messages.ts`
2. Add to the `ClientMessage` or `ServerMessage` discriminated union
3. Add handler in `apps/relay/src/message-router.ts` (for client messages)
4. Add handler in `apps/web/src/hooks/use-websocket.ts` (for server messages)

## How to Add a Package
1. Create directory under `packages/`
2. Add `package.json` with `@repo/<name>`, `"private": true`, `"type": "module"`
3. Extend `@repo/tsconfig/library.json` (or `node.json` for Node-only)
4. Extend `@repo/eslint-config/base` (or `/react` for React packages)
5. Export from `src/index.ts`
6. Consumers add `"@repo/<name>": "workspace:*"` to their dependencies

## How to Modify Relay Handlers
1. Find the message type in `apps/relay/src/message-router.ts`
2. Each `case` handles one `ClientMessage` type
3. Use `send(ws, msg)` for responses, `sendError(ws, code, message)` for errors
4. File operations must call `files.isPathAllowed()` before accessing paths
5. Session operations use `tmux.*` functions from `tmux-manager.ts`

## Review Checklist
- [ ] No raw Tailwind colors (use semantic: bg-background, text-foreground)
- [ ] Imports use `.js` extension for local files
- [ ] Environment variables validated with zod
- [ ] Docker compose updated if new service needed
- [ ] File access in relay uses `isPathAllowed()` guard
- [ ] Protocol messages added to both client and server schemas
- [ ] WebSocket message handlers added in both relay and web

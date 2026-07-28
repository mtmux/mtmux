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
mtmux
```

That's it. `start` is the default command. mtmux auto-generates a token, serves your tmux, prints a scannable code, and opens your browser. No config file, no Docker, no reverse proxy, no port forward.

Requires Node 22+ and `tmux` on your PATH.

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
- **Self-hosted** — your machine, your tmux, your token. No third party required.
- **Six-digit pairing** — get a phone on from anywhere, end-to-end encrypted
- **Single port** — HTTP and WS share one upstream behind nginx/Caddy
- **PWA** — installable on iOS/Android home screens

## Getting a phone on

```
$ mtmux

  ▄▄▄▄▄▄▄ ▄▄  ▄ ▄▄▄▄▄▄▄
  █ ▄▄▄ █ ▀▄▀▄█ █ ▄▄▄ █    Scan to open your terminal
  █ ███ █ ▀ ▄▄▄ █ ███ █
  █▄▄▄▄▄█ █ ▀ █ █▄▄▄▄▄█    or go to  app.mtmux.com
  ▄▄▄▄  ▄ ▄▀▀▄▀▄▄▄ ▄▄      and enter  48 29 13
```

**Scan it and you're in.** One command, no second terminal. Camera won't cooperate? Type the six digits at `app.mtmux.com`. Works the same on your wifi and on cellular from another country — mtmux takes the direct path when it can and falls back to a relayed tunnel when it can't.

The last four digits never reach our servers — they're the password for a [CPace](https://datatracker.ietf.org/doc/draft-irtf-cfrg-cpace/) PAKE, and everything afterwards is AES-256-GCM under keys the broker doesn't hold. The QR puts the code in a URL _fragment_, which browsers never send to a server. One wrong guess burns the code. [How it works →](https://docs.mtmux.com/docs/pairing)

Paired devices stay paired: restarting mtmux re-admits them, and reloading the browser doesn't force a re-pair. Revoke with `mtmux devices revoke <id>`.

Already at the browser instead of the terminal? Open `app.mtmux.com/pair` and run `mtmux pair <code>` — same handshake, other direction.

Prefer nothing to leave the building? `mtmux start --local` contacts no broker at all.

## Quick start

```bash
mtmux                          # serve, print a code, open a browser
mtmux start --local            # LAN and loopback only, no broker
mtmux start --port 8080        # different port
mtmux start --no-open          # don't open a browser here
mtmux pair 482913              # join a pairing the browser started
mtmux status                   # what's running here
mtmux stop                     # stop it
mtmux doctor                   # why isn't this working?
mtmux devices                  # browsers this machine trusts
mtmux token rotate             # new token; paired devices are kept
mtmux --help
```

[Full CLI reference →](https://docs.mtmux.com/docs/cli)

## Behind a reverse proxy

Usually unnecessary — pairing already gets a remote device on without exposing a
port. But if you want your own domain in front of it:

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
  proxy_read_timeout 3600s;
}
```

Caddy:

```caddy
mtmux.example.com {
  reverse_proxy 127.0.0.1:14100
}
```

## Configuration

| Flag                      | Default                              | Description                                          |
| ------------------------- | ------------------------------------ | ---------------------------------------------------- |
| `-p, --port <n>`          | `14100`                              | HTTP + WS port                                       |
| `-h, --host <addr>`       | `0.0.0.0` on a LAN, else `127.0.0.1` | Bind address. An explicit value always wins.         |
| `--local`                 | off                                  | LAN and loopback only — never contact a broker       |
| `-n, --name <label>`      | hostname                             | What to call this machine in the dashboard           |
| `--no-qr`                 | QR shown                             | Print the code without the QR block                  |
| `-t, --token <value>`     | auto                                 | Override the auth token for this run                 |
| `--allowed-paths <paths>` | `$HOME`                              | Comma-separated path allow-list for the file browser |
| `--no-open`               | opens                                | Don't open a browser on this machine                 |
| `--json`                  | off                                  | Machine-readable startup record                      |

There is deliberately **no fixed default host**: mtmux binds `0.0.0.0` when the machine has a usable private address on a real interface (container bridges and VPN overlays don't count) and `127.0.0.1` when it doesn't. You do not need `--host 0.0.0.0` to reach it from your phone.

| Env                   | Default                 | Description                                                 |
| --------------------- | ----------------------- | ----------------------------------------------------------- |
| `MTMUX_CONFIG_DIR`    | `~/.mtmux`              | Where `config.json` and `server.json` live                  |
| `MTMUX_API_URL`       | `https://api.mtmux.com` | Pairing broker. Point it at your own.                       |
| `MTMUX_BUILD_API_URL` | —                       | Build time only — bakes a broker origin into the web bundle |

The auto-generated token is stored at `~/.mtmux/config.json` (mode `0600`), alongside the device key and the list of paired browsers.

## Architecture

On your own network, one Node process and one HTTP server:

```
Browser  ⇄ http/ws ⇄  mtmux node  ⇄ pty ⇄  tmux
           (one port)  Next.js + ws         your sessions
```

For a device that can't reach your machine, a blind broker relays sealed frames:

```
Browser ──┬─ raced first ─────── direct ──────────────┬── mtmux ⇄ tmux
          └─ api.mtmux.com ── AES-256-GCM ciphertext ─┘
             (holds no key, sees no keystroke)
```

[Architecture →](https://docs.mtmux.com/docs/architecture) · [The sealed tunnel →](https://docs.mtmux.com/docs/sealed-tunnel)

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
pnpm dev:pairing  # the hosted-pairing topology, broker included
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
- **PM2** (`ecosystem.config.cjs`) — the five-app topology the hosted service runs

See [Deployment](https://docs.mtmux.com/docs/deployment) for the split-model details, and [Self-hosting](https://docs.mtmux.com/docs/self-hosting) for running your own pairing broker.

## Documentation

[docs.mtmux.com](https://docs.mtmux.com/docs) — or `apps/docs/content/docs/` in this repo.

- [Getting started](https://docs.mtmux.com/docs/getting-started)
- [CLI reference](https://docs.mtmux.com/docs/cli)
- [How pairing works](https://docs.mtmux.com/docs/pairing)
- [The sealed tunnel](https://docs.mtmux.com/docs/sealed-tunnel)
- [Security](https://docs.mtmux.com/docs/security)

## Contributing

PRs welcome. Conventional commits with an [enforced scope list](commitlint.config.js). See [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

Security reports: [SECURITY.md](SECURITY.md) — please don't open a public issue.

## License

MIT

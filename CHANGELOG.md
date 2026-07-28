# Changelog

All notable changes to **mtmux** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions refer to the published [`mtmux`](https://www.npmjs.com/package/mtmux)
npm package (`apps/cli`). Changes elsewhere in the monorepo are listed under the
release that shipped them.

## [Unreleased]

### Added

- **Scan-to-connect.** `app.mtmux.com/j` claims the code `mtmux start` prints,
  read from the URL fragment so it never reaches a server. Scanning the QR now
  connects with zero taps and no second command; with no fragment the page falls
  back to a six-digit field. `mtmux pair` remains the browser-initiated
  direction.
- **`API_TUNNEL_MAX_STREAMS`** (default 16) — concurrent streams per tunnel. A
  `stream:open` past the cap is refused rather than closing the tunnel.
- **Accounts and billing on the broker.** `/api/auth/*`, `/v1/me`,
  `/v1/servers`, `/v1/servers/register`, `/v1/servers/:id/heartbeat`,
  `PATCH`/`DELETE /v1/servers/:id`, `/v1/billing`, `/v1/billing/checkout`,
  `/v1/billing/portal`. All optional: with no `DATABASE_URL` they answer 503 and
  pairing is unaffected. Plan limits live in `packages/config/src/plans.ts`.
- **Documentation rewritten against the source.** The docs site now describes
  the `mtmux` CLI that actually ships. New pages: CLI reference, How pairing
  works, The sealed tunnel, Accounts and multiple servers, `mtmux doctor`. The
  duplicate marketing landing page in `apps/docs` was removed — `/` redirects to
  `/docs`, and mtmux.com (`apps/site`) is the only marketing site.

### Changed

- **Paired devices survive a restart.** The token derived with each browser is
  persisted against its peer record and replayed by `mtmux start`, so a restart,
  deploy, crash or reboot no longer un-pairs every phone. Bounded by the 90-day
  peer expiry and `mtmux devices revoke <id>`. LAN-nonce sign-ins are unchanged
  and still memory-only.
- **The sealed descriptor is durable.** It moved from `sessionStorage` to
  IndexedDB alongside the session keys, with a `sessionStorage` mirror for
  synchronous reads, so reloading the browser no longer forces a re-pair.
- **Tunnel ids are stable across agent reconnects**, so a dropped connection no
  longer strands paired browsers. Revocation still surrenders the id.
- `apps/docs` sitemap is generated from the Fumadocs page tree instead of a
  hand-maintained list that had already fallen behind the content directory.

### Fixed

- `mtmux start` wires the tunnel agent correctly and awaits the tunnel id
  through `onTunnelReady`, so the hosted path works rather than falling back to
  local-only.

## [0.3.0] — 2026

The release that made a phone on cellular work.

### Added

- **`mtmux pair` and the reverse tunnel agent.** A device that cannot reach your
  machine pairs with a six-digit code and its session rides a sealed tunnel. The
  agent holds one outbound socket to the broker and bridges sealed frames to a
  loopback relay socket, so no relay internals are touched and the machine's
  `AUTH_TOKEN` never crosses the tunnel.
- **`@repo/crypto`.** CPace (`CPACE-RISTR255-SHA512`, checked against the
  draft's published test vectors), an HKDF-SHA-256 key schedule with one label
  per purpose, AES-256-GCM sealed frames with per-direction nonces and a
  monotonic counter that rejects replays, Ed25519 device keys, and the
  slot+secret pairing code.
- **The blind pairing broker (`apps/api`).** Mailboxes indexed by a two-digit
  slot, claim fan-out, tunnel registry with byte and time quotas, and per-address
  rate limits that carry part of the security argument rather than being
  capacity management. It never sees the four-digit secret and holds no key that
  can open a frame.
- **Pairing and tunnel message schemas** in `@repo/protocol`, kept as a separate
  discriminated union from the relay protocol.
- **Sealed transport and the pairing page** in the web client, with direct
  candidate racing that only counts a candidate as reachable once it completes
  the relay auth handshake.
- **Scoped session tokens and failed-auth throttling** in the relay. A LAN QR
  sign-in redeems a single-use nonce for a 24-hour, memory-only session token,
  so the long-lived token is never typed and never crosses the network. Repeated
  failures from one address lock out with exponential backoff.
- **Accounts, optional.** `mtmux login`/`logout`/`whoami`/`servers`/`upgrade`
  via OAuth device authorization, so a headless box can sign in. Anonymous
  pairing is unaffected and always will be.
- **`mtmux doctor`, `mtmux status`, `mtmux stop`, `mtmux devices`.**
- **`pnpm dev:pairing`**, `pnpm build:hosted`, `pnpm prepare:standalone` and
  `pnpm deploy:hosted` for the hosted topology.

### Changed

- **`mtmux start` binds the LAN by default.** It now picks `0.0.0.0` when the
  machine has a usable private address on a non-virtual interface, and
  `127.0.0.1` when it does not. The old fixed `127.0.0.1` default made the
  phone-on-the-couch case — the whole point of the tool — require a restart with
  `--host 0.0.0.0`. An explicit `--host` still wins.
- **The startup banner** leads with a scannable code instead of a token.
- **Next.js 16 and React 19.2** across the monorepo.
- **Single-port serving with dev parity.** `pnpm dev` runs the same topology
  `mtmux start` ships, so single-port bugs surface while you work.

### Fixed

- The sealed tunnel now actually carries relay traffic.
- A stray build environment variable can no longer reach a published artifact.
- Unpublishable workspace dependencies are no longer shipped, and deploys verify
  themselves before reloading.
- `pnpm build` works under Next 16.

## Earlier

Before 0.3.0 the package was published as `tmuxremote`, and earlier still the
repository carried `ccremote` branding. Upgrading is safe: the CLI adopts a
token found at `~/.tmuxremote/config.json` rather than issuing a new one, so
bookmarked login URLs keep working.

[Unreleased]: https://github.com/GagnDeep/tmuxremote/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/GagnDeep/tmuxremote/releases/tag/v0.3.0

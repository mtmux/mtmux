# Security Policy

## Supported Versions

| Version                | Supported |
| ---------------------- | --------- |
| latest `mtmux` release | Yes       |
| anything older         | No        |

Only the latest published [`mtmux`](https://www.npmjs.com/package/mtmux) release
and the current `main` are actively supported with security updates.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly. **Do not
open a public issue.**

Email **security@mtmux.com** with:

- A description of the vulnerability
- Steps to reproduce it
- Which component is affected (CLI, relay, web client, broker, `@repo/crypto`)
- Any relevant logs or screenshots — **redacted**: never include a pairing code,
  an auth token, or a session token

## Response Timeline

- **Acknowledgement:** within 48 hours
- **Initial assessment:** within 5 business days
- **Fix or mitigation:** as soon as practical, depending on severity

We will coordinate disclosure with you and credit reporters in the release notes
unless anonymity is requested.

## Threat Surface

mtmux gives a browser a terminal on someone's machine, and since 0.3.0 it also
brokers connections between strangers' devices. Reports touching any of the
following are especially welcome.

### The CLI and relay

- Bypassing the WebSocket auth handshake, or the 5-second auth deadline.
- Escaping `ALLOWED_PATHS`, including via symlinks — the guard resolves symlinks
  on both the target and each allowed root before comparing.
- Command injection through the tmux CLI or the PTY bridge.
- Recovering `AUTH_TOKEN` by timing the comparison, which is SHA-256 digested
  and then `timingSafeEqual`'d.
- Defeating the failed-auth throttle, or using it to lock out a legitimate user.

### Pairing

- **Anything that lets the broker learn the four-digit secret.** It is generated
  in the browser, is the CPace password, and must never reach the broker — not
  even as a hash.
- Getting more than one guess per code. A failed key confirmation destroys the
  mailbox by design; a path that leaves it alive breaks the whole guessing
  bound.
- Defeating the claim or mailbox rate limits, including by forging
  `X-Forwarded-For`.
- Pairing a victim's CLI to an attacker's browser, or the reverse.
- Leaking the pairing code out of the URL fragment.

### The sealed tunnel

- Any way the broker, or anyone on the path, can read or modify a frame. Frames
  are AES-256-GCM under per-direction keys derived by HKDF-SHA-256 from the
  CPace ISK.
- Replay or reorder acceptance. The frame counter must strictly increase and the
  high-water mark must only advance on a frame that authenticates.
- Reaching the relay through a tunnel without a valid pairing — a stream whose
  first frame no key opens must be refused, not forwarded.
- Impersonating a device to the tunnel registry. Registration is a signature
  over a server-issued challenge.
- Errors in the CPace implementation in `packages/crypto/src/cpace.ts`. It is
  checked against the draft's Appendix B.3 vectors, which proves the encoding
  and group maths but not the surrounding protocol wiring. **That wiring has not
  had an independent security review.** Findings there are exactly what we want.

### Hosted accounts

- Forging a session, or session fixation across `app.` and `api.`.
- Escaping a plan limit, or reading another account's servers.

## Out of Scope

- Exposing the CLI's port directly to the internet without TLS. It serves plain
  HTTP by design and the documentation says not to.
- Anything requiring an attacker to already have the machine's `AUTH_TOKEN` or
  local shell access — both are, by construction, full access.
- Denial of service against your own machine by your own client.

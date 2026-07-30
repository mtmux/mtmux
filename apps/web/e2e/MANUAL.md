# The checklist automation cannot reach

Everything here was considered for Playwright and rejected for a stated reason,
not skipped. Run it before a release that touches auth, the lock, or sharing.

## Conditional UI (passkey autofill)

`signIn.passkey({ autoFill: true })` puts credentials into the browser's own
autofill dropdown. **That dropdown is not scriptable** — not by Playwright's
locators and not by CDP's `WebAuthn` domain, which can create a virtual
authenticator but cannot open the browser's UI chrome. So:

- [ ] macOS Safari — focus the email field on `/signin`; a passkey suggestion
      appears in the dropdown; choosing it signs in.
- [ ] Chrome desktop — same.
- [ ] iOS Safari — same, via Face ID.
- [ ] Move from the email step to any other step. The prompt must **abandon**;
      Safari otherwise leaves a stuck ceremony that blocks the next one.

## The read-only escape

This is the one that matters most, and no unit test reaches it — it is a
property of tmux, not of our code.

- [ ] `mtmux share work --read-only`, join from a second browser.
- [ ] In the read-only browser, press `(`, `)`, `prefix s`, `prefix :`,
      `prefix d`. **Nothing may happen.** `(` and `)` are bound to
      `switch-client` by default and still work under `attach-session -r`,
      which is why read-only attaches to a locked clone instead.
- [ ] Type into it. Nothing reaches the PTY.
- [ ] Meanwhile the owner's own client keeps its prefix key and bindings — the
      clone sets _session_ options, so it must not have touched them.

## The lock on a real phone

- [ ] iOS, installed to the home screen. Open the app switcher: the shell is
      blurred in the OS screenshot.
- [ ] With "lock when I switch apps" **on**: the Face ID prompt itself must not
      trigger a lock. This is the loop that makes the setting unusable if the
      ceremony suppression regresses.
- [ ] Kill the app and reopen: locked, every time.
- [ ] Unlock, then reload: locked again. A module variable does not survive a
      reload, and nothing may reintroduce persistence.

## The LAN origin

- [ ] `mtmux start`, open the printed `http://192.168.x.x:14100` URL.
- [ ] Enrolling a PIN works. (`crypto.subtle` is absent here — the AEAD and
      PBKDF2 fallbacks must both engage.)
- [ ] The passkey option says the origin is insecure rather than failing.

## End to end, on the box

- [ ] `pnpm dev:pairing`, real phone against the real broker.
- [ ] `echo $((6*7))` through the sealed tunnel.
- [ ] `grep` the broker log for any session name, code, slot or mailbox id.
      **Expect zero hits.**

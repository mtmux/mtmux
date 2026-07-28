import crypto from "node:crypto";
import type { TunnelServerMessage } from "@repo/protocol";

/**
 * Live reverse tunnels.
 *
 * A tunnel is one persistent outbound socket from a CLI plus zero or more
 * browser streams pinned to it. The broker copies sealed frames between them
 * and holds no key that could open one, so this file is pure plumbing plus
 * quotas — there is deliberately nothing here that inspects a payload.
 *
 * Interface-first for the same reason as MailboxStore: the wire protocol never
 * assumes a single process.
 */

export type TunnelSink = (message: TunnelServerMessage) => void;

export type Stream = {
  readonly id: string;
  readonly openedAt: number;
  browser: TunnelSink | null;
};

export type Tunnel = {
  readonly id: string;
  readonly deviceId: string;
  readonly publicKey: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Bytes forwarded in both directions, against the quota. */
  bytes: number;
  /**
   * The account this machine is registered to, once resolved, and why the
   * tunnel is refusing new streams if it is.
   *
   * Both are set asynchronously *after* registration, because resolving an
   * owner is a database read and making the agent wait on it would let an
   * accounts outage delay every reconnect. Until they resolve the tunnel
   * behaves exactly as an anonymous one — which is also the permanent state
   * for a self-hosted broker with no database at all.
   */
  userId: string | null;
  blocked: string | null;
  agent: TunnelSink;
  readonly streams: Map<string, Stream>;
};

export type Quotas = {
  maxBytes: number;
  maxMinutes: number;
  /** Concurrent streams one tunnel will carry. See `openStream`. */
  maxStreams: number;
};

export interface TunnelRegistry {
  /**
   * Attach an agent socket to this device's tunnel.
   *
   * The id is stable across reconnects — see `idForDevice` below — so a
   * reconnecting agent replaces its old socket without invalidating the tunnel
   * id already sealed into paired browsers' descriptors.
   */
  register(
    deviceId: string,
    publicKey: string,
    agent: TunnelSink,
    now?: number,
  ): Tunnel;
  get(tunnelId: string, now?: number): Tunnel | null;
  /** A device has at most one tunnel; re-registering replaces the old one. */
  byDevice(deviceId: string, now?: number): Tunnel | null;
  close(tunnelId: string, reason: CloseReason): void;

  /** Null when the tunnel is already carrying `maxStreams`. */
  openStream(tunnel: Tunnel, browser: TunnelSink, now?: number): Stream | null;
  attachBrowser(tunnel: Tunnel, streamId: string, browser: TunnelSink): boolean;
  closeStream(tunnel: Tunnel, streamId: string, reason?: string): void;

  /** Charge bytes against the quota. False means the tunnel must close. */
  charge(tunnel: Tunnel, bytes: number): boolean;

  sweep(now?: number): void;
  stats(): { tunnels: number; streams: number };
}

type CloseReason = Extract<
  TunnelServerMessage,
  { type: "tunnel:closed" }
>["reason"];

export function createTunnelRegistry(quotas: Quotas): TunnelRegistry {
  const tunnels = new Map<string, Tunnel>();
  const byDeviceId = new Map<string, string>();

  /**
   * deviceId → the tunnel id that device keeps getting back, and when the
   * reservation lapses.
   *
   * The browser seals the tunnel id into its connection descriptor at pairing
   * time and has no channel to be told a new one — the mailbox is destroyed the
   * moment pairing succeeds. So an agent that reconnected (a laptop lid, a
   * broker restart, a flaky uplink) used to mint a fresh id and silently strand
   * every browser it had already paired with: the descriptor's tunnel URL 404s
   * and the session is simply dead.
   *
   * Keeping the id costs nothing in safety. It is only ever handed to a device
   * that has just proved possession of the Ed25519 key it is a fingerprint of,
   * and knowing an id buys an attacker nothing on its own: the agent refuses
   * any stream whose first frame no pairing key can open. So the id is a
   * routing label bound to a signed identity, and treating it as one is
   * strictly better than a fresh random per connection.
   *
   * The reservation is refreshed on every registration and swept when it
   * lapses, so an agent that never comes back does not pin memory forever.
   */
  const idForDevice = new Map<string, { id: string; expiresAt: number }>();
  const RESERVATION_MS = quotas.maxMinutes * 60_000;

  function drop(tunnelId: string, reason: CloseReason): void {
    const tunnel = tunnels.get(tunnelId);
    if (!tunnel) return;
    for (const stream of tunnel.streams.values()) {
      stream.browser?.({ type: "tunnel:closed", reason });
    }
    tunnel.streams.clear();
    try {
      tunnel.agent({ type: "tunnel:closed", reason });
    } catch {
      // The agent socket may already be gone; teardown continues regardless.
    }
    tunnels.delete(tunnelId);
    if (byDeviceId.get(tunnel.deviceId) === tunnelId) {
      byDeviceId.delete(tunnel.deviceId);
    }
    // Revocation is the one close that must not be undone by reconnecting, so
    // it surrenders the id as well. Every other reason is transient.
    if (reason === "revoked") idForDevice.delete(tunnel.deviceId);
  }

  return {
    register(deviceId, publicKey, agent, now = Date.now()) {
      // One tunnel per device: a reconnecting CLI should replace its old
      // socket, not accumulate zombies that still count against quotas.
      const existing = byDeviceId.get(deviceId);
      if (existing) drop(existing, "agent-gone");

      const reserved = idForDevice.get(deviceId);
      const id =
        reserved && reserved.expiresAt > now
          ? reserved.id
          : `tnl-${crypto.randomBytes(16).toString("base64url")}`;

      const tunnel: Tunnel = {
        id,
        deviceId,
        publicKey,
        createdAt: now,
        expiresAt: now + quotas.maxMinutes * 60_000,
        bytes: 0,
        userId: null,
        blocked: null,
        agent,
        streams: new Map(),
      };
      tunnels.set(tunnel.id, tunnel);
      byDeviceId.set(deviceId, tunnel.id);
      idForDevice.set(deviceId, { id, expiresAt: now + RESERVATION_MS });
      return tunnel;
    },

    get(tunnelId, now = Date.now()) {
      const tunnel = tunnels.get(tunnelId);
      if (!tunnel) return null;
      if (tunnel.expiresAt <= now) {
        drop(tunnelId, "expired");
        return null;
      }
      return tunnel;
    },

    byDevice(deviceId, now = Date.now()) {
      const tunnelId = byDeviceId.get(deviceId);
      return tunnelId ? this.get(tunnelId, now) : null;
    },

    close: drop,

    openStream(tunnel, browser, now = Date.now()) {
      // `WS /v1/tunnel/:id` is deliberately unauthenticated — the agent's trial
      // decryption is what actually protects the session, and requiring auth
      // here would mean the broker learning who is talking to whom. But an
      // opened stream makes the *agent* dial a fresh loopback socket before any
      // frame arrives, so without a cap anyone who learned a tunnel id could
      // exhaust file descriptors on someone else's machine. Tunnel ids are now
      // stable across agent reconnects, which makes a leaked one worth more,
      // so the cap matters more than it used to.
      //
      // The limit is per tunnel and generous: one stream per open tab, and
      // nobody has sixteen tabs of the same terminal.
      if (tunnel.blocked) return null;
      if (tunnel.streams.size >= quotas.maxStreams) return null;

      const stream: Stream = {
        id: `str-${crypto.randomBytes(9).toString("base64url")}`,
        openedAt: now,
        browser,
      };
      tunnel.streams.set(stream.id, stream);
      tunnel.agent({ type: "stream:open", streamId: stream.id });
      return stream;
    },

    attachBrowser(tunnel, streamId, browser) {
      const stream = tunnel.streams.get(streamId);
      if (!stream) return false;
      stream.browser = browser;
      return true;
    },

    closeStream(tunnel, streamId, reason) {
      const stream = tunnel.streams.get(streamId);
      if (!stream) return;
      tunnel.streams.delete(streamId);
      stream.browser?.({ type: "stream:close", streamId, reason });
      tunnel.agent({ type: "stream:close", streamId, reason });
    },

    charge(tunnel, bytes) {
      tunnel.bytes += bytes;
      if (tunnel.bytes > quotas.maxBytes) {
        drop(tunnel.id, "quota-exceeded");
        return false;
      }
      return true;
    },

    sweep(now = Date.now()) {
      for (const [tunnelId, tunnel] of tunnels) {
        if (tunnel.expiresAt <= now) drop(tunnelId, "expired");
      }
      for (const [deviceId, reservation] of idForDevice) {
        if (reservation.expiresAt <= now) idForDevice.delete(deviceId);
      }
    },

    stats() {
      let streams = 0;
      for (const tunnel of tunnels.values()) streams += tunnel.streams.size;
      return { tunnels: tunnels.size, streams };
    },
  };
}

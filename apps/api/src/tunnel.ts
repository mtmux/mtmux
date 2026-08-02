import crypto from "node:crypto";
import type { TunnelServerMessage } from "@repo/protocol";
import {
  deriveTunnelId,
  resolveTunnelIdSecret,
  type TunnelIdSecret,
} from "./tunnel-id.js";

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
   * The id is stable across reconnects *and across broker restarts* — it is
   * derived, not remembered; see `tunnel-id.ts` — so neither a reconnecting
   * agent nor a deploy invalidates the tunnel id already sealed into paired
   * browsers' descriptors.
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

export function createTunnelRegistry(
  quotas: Quotas,
  options?: {
    /**
     * The HMAC key tunnel ids are derived from. Omitted means "resolve it" —
     * from `API_TUNNEL_ID_SECRET`, else a 0600 file, else a process-random key.
     * Tests pass one so they never touch the filesystem.
     */
    idSecret?: TunnelIdSecret;
  },
): TunnelRegistry {
  const tunnels = new Map<string, Tunnel>();
  const byDeviceId = new Map<string, string>();
  const idSecret = options?.idSecret ?? resolveTunnelIdSecret().secret;

  /**
   * deviceId → how many times its id has been deliberately rotated.
   *
   * This replaces a `deviceId → { id, expiresAt }` reservation map, and the
   * difference is the whole point. The browser seals the tunnel id into its
   * connection descriptor at pairing time and has no channel to be told a new
   * one — the mailbox is destroyed the moment pairing succeeds — so an agent
   * that reconnects must get the same id back or every browser it has ever
   * paired with is stranded on a url that no longer resolves.
   *
   * The map did that for a reconnecting agent and claimed to do it for a broker
   * restart. It could not: it lived in memory, so every deploy re-minted every
   * id and disconnected every device at once, with no way back but re-pairing.
   * That is not a hypothetical — it is what shipped, and what it cost.
   *
   * So the id is now derived from a persistent secret (`tunnel-id.ts`) and this
   * map holds only the epoch, which nothing bumps except revocation. An empty
   * map is therefore the correct state after a restart, rather than a lossy one.
   */
  const epochs = new Map<string, number>();

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
    // it rotates the id as well. Every other reason is transient.
    //
    // The epoch is in memory, so a revoked device's id returns after a restart.
    // That is the same lifetime revocation had before this change — the map it
    // used to delete from was in memory too — and making it durable means a
    // persistent record of which devices exist, which is the one thing this
    // broker is built not to keep. Worth revisiting if revocation ever grows a
    // caller; today it has none.
    if (reason === "revoked") {
      epochs.set(tunnel.deviceId, (epochs.get(tunnel.deviceId) ?? 0) + 1);
    }
  }

  return {
    register(deviceId, publicKey, agent, now = Date.now()) {
      // One tunnel per device: a reconnecting CLI should replace its old
      // socket, not accumulate zombies that still count against quotas.
      const existing = byDeviceId.get(deviceId);
      if (existing) drop(existing, "agent-gone");

      const id = deriveTunnelId(idSecret, deviceId, epochs.get(deviceId) ?? 0);

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
      // Nothing to sweep beside the tunnels themselves any more. The map this
      // used to expire held ids; the one that replaced it holds revocation
      // epochs, and an epoch that lapsed would un-revoke a device.
    },

    stats() {
      let streams = 0;
      for (const tunnel of tunnels.values()) streams += tunnel.streams.size;
      return { tunnels: tunnels.size, streams };
    },
  };
}

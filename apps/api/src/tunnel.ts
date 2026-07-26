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
  agent: TunnelSink;
  readonly streams: Map<string, Stream>;
};

export type Quotas = {
  maxBytes: number;
  maxMinutes: number;
};

export interface TunnelRegistry {
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

  openStream(tunnel: Tunnel, browser: TunnelSink, now?: number): Stream;
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
  }

  return {
    register(deviceId, publicKey, agent, now = Date.now()) {
      // One tunnel per device: a reconnecting CLI should replace its old
      // socket, not accumulate zombies that still count against quotas.
      const existing = byDeviceId.get(deviceId);
      if (existing) drop(existing, "agent-gone");

      const tunnel: Tunnel = {
        id: `tnl-${crypto.randomBytes(16).toString("base64url")}`,
        deviceId,
        publicKey,
        createdAt: now,
        expiresAt: now + quotas.maxMinutes * 60_000,
        bytes: 0,
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
    },

    stats() {
      let streams = 0;
      for (const tunnel of tunnels.values()) streams += tunnel.streams.size;
      return { tunnels: tunnels.size, streams };
    },
  };
}

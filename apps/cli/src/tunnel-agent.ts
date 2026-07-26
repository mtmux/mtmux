import WebSocket from "ws";
import {
  bytesToHex,
  hexToBytes,
  signChallenge,
  type DeviceKeyPair,
} from "@repo/crypto";
import {
  tryDeserializeTunnelServerMessage,
  type TunnelServerMessage,
} from "@repo/protocol";

/**
 * The reverse tunnel agent.
 *
 * Holds one outbound WebSocket to the broker. When the broker says a browser
 * wants a stream, the agent opens an ordinary local WebSocket to
 * `ws://127.0.0.1:<port>/_relay`, authenticates it with the local AUTH_TOKEN,
 * and copies bytes between the two.
 *
 * The isolation is the point: the relay sees a perfectly normal authenticated
 * local client and knows nothing about tunnels, brokers or pairing. No relay
 * internals are touched, so nothing here can regress the self-hosted path. It
 * also means the 64-hex AUTH_TOKEN is injected on this side of the tunnel and
 * never travels over it.
 */

export type LocalSocket = {
  send(data: string): void;
  close(): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
  onOpen(cb: () => void): void;
};

export type AgentSocket = LocalSocket;

export type TunnelAgentOptions = {
  apiBase: string;
  deviceKey: DeviceKeyPair;
  /** Opens the persistent socket to the broker. */
  connectBroker: (url: string) => AgentSocket;
  /** Opens a local relay socket for one stream. */
  connectLocal: () => LocalSocket;
  onTunnelReady?: (tunnelId: string) => void;
  onStatus?: (status: AgentStatus, detail?: string) => void;
  /** Injected for tests; real runs use exponential backoff with jitter. */
  scheduleRetry?: (attempt: number, run: () => void) => void;
};

export type AgentStatus =
  | "connecting"
  | "registered"
  | "disconnected"
  | "stopped";

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/** Mirrors apps/web/src/lib/ws-client.ts so reconnect behaviour is familiar. */
function defaultRetry(attempt: number, run: () => void): void {
  const capped = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  // Jitter: a fleet of agents reconnecting after a broker restart must not
  // arrive in lockstep.
  const delay = capped / 2 + Math.random() * (capped / 2);
  setTimeout(run, delay).unref?.();
}

export type TunnelAgent = {
  start(): void;
  stop(): void;
  readonly tunnelId: string | null;
  readonly status: AgentStatus;
};

export function createTunnelAgent(opts: TunnelAgentOptions): TunnelAgent {
  const retry = opts.scheduleRetry ?? defaultRetry;
  let broker: AgentSocket | null = null;
  let tunnelId: string | null = null;
  let status: AgentStatus = "disconnected";
  let attempt = 0;
  let stopped = false;

  /** streamId → local relay socket. */
  const streams = new Map<string, LocalSocket>();

  function setStatus(next: AgentStatus, detail?: string) {
    status = next;
    opts.onStatus?.(next, detail);
  }

  function teardownStreams() {
    for (const local of streams.values()) local.close();
    streams.clear();
  }

  function send(message: unknown) {
    broker?.send(JSON.stringify(message));
  }

  function openStream(streamId: string) {
    const local = opts.connectLocal();
    streams.set(streamId, local);

    // Frames produced before the local socket finishes opening would be lost,
    // so hold them until it does. In practice this is the browser's first
    // sealed frame racing the loopback connect.
    const queued: string[] = [];
    let open = false;

    local.onOpen(() => {
      open = true;
      for (const data of queued.splice(0)) local.send(data);
    });

    local.onMessage((data) => {
      send({ type: "stream:frame", streamId, data });
    });

    local.onClose(() => {
      if (streams.delete(streamId)) {
        send({ type: "stream:close", streamId, reason: "local closed" });
      }
    });

    return {
      write(data: string) {
        if (open) local.send(data);
        else queued.push(data);
      },
    };
  }

  /** streamId → the writer above, so frames can be buffered per stream. */
  const writers = new Map<string, { write(data: string): void }>();

  function handle(message: TunnelServerMessage) {
    switch (message.type) {
      case "tunnel:challenge": {
        const challenge = hexToBytes(message.challenge);
        send({
          type: "tunnel:register",
          deviceId: opts.deviceKey.deviceId,
          publicKey: bytesToHex(opts.deviceKey.publicKey),
          challenge: message.challenge,
          signature: bytesToHex(
            signChallenge(opts.deviceKey.secretKey, challenge),
          ),
        });
        return;
      }

      case "tunnel:ready": {
        tunnelId = message.tunnelId;
        attempt = 0;
        setStatus("registered");
        opts.onTunnelReady?.(message.tunnelId);
        return;
      }

      case "stream:open": {
        writers.set(message.streamId, openStream(message.streamId));
        return;
      }

      case "stream:frame": {
        // Sealed by the browser under a key this process holds but the broker
        // does not; the relay end unseals it. Nothing here inspects it.
        writers.get(message.streamId)?.write(message.data);
        return;
      }

      case "stream:close": {
        streams.get(message.streamId)?.close();
        streams.delete(message.streamId);
        writers.delete(message.streamId);
        return;
      }

      case "tunnel:closed": {
        setStatus("disconnected", message.reason);
        teardownStreams();
        broker?.close();
        return;
      }
    }
  }

  function connect() {
    if (stopped) return;
    setStatus("connecting");
    const socket = opts.connectBroker(
      `${opts.apiBase.replace(/^http/, "ws")}/v1/agent`,
    );
    broker = socket;

    socket.onMessage((raw) => {
      const parsed = tryDeserializeTunnelServerMessage(raw);
      // A frame the broker should never have sent is dropped, not fatal: the
      // tunnel is a best-effort fallback and must not take the CLI down.
      if (parsed.ok) handle(parsed.message);
    });

    socket.onClose(() => {
      broker = null;
      tunnelId = null;
      teardownStreams();
      writers.clear();
      if (stopped) {
        setStatus("stopped");
        return;
      }
      setStatus("disconnected");
      retry(attempt++, connect);
    });
  }

  return {
    start() {
      stopped = false;
      attempt = 0;
      connect();
    },
    stop() {
      stopped = true;
      teardownStreams();
      writers.clear();
      broker?.close();
      broker = null;
      setStatus("stopped");
    },
    get tunnelId() {
      return tunnelId;
    },
    get status() {
      return status;
    },
  };
}

/**
 * Real local relay socket: a plain WebSocket to loopback that authenticates
 * itself with the machine's own token before any tunnel traffic flows.
 */
export function localRelayConnector(
  port: number,
  token: string,
): () => LocalSocket {
  return () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/_relay`, {
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        "User-Agent": "mtmux-tunnel-agent",
      },
    });
    const openHandlers: (() => void)[] = [];

    ws.on("open", () => {
      // The relay's first-message-must-be-auth rule applies to this socket
      // like any other. The token stays on this machine.
      ws.send(JSON.stringify({ type: "auth", token }));
      for (const cb of openHandlers) cb();
    });

    return {
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
      close: () => ws.close(),
      onMessage: (cb) => ws.on("message", (raw) => cb(raw.toString())),
      onClose: (cb) => ws.on("close", cb),
      onOpen: (cb) => {
        if (ws.readyState === WebSocket.OPEN) cb();
        else openHandlers.push(cb);
      },
    };
  };
}

/** Real broker socket. */
export function brokerConnector(): (url: string) => AgentSocket {
  return (url) => {
    const ws = new WebSocket(url);
    const openHandlers: (() => void)[] = [];
    ws.on("open", () => {
      for (const cb of openHandlers) cb();
    });
    // A failed connect surfaces as a close, which drives the retry loop.
    ws.on("error", () => ws.close());
    return {
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
      close: () => ws.close(),
      onMessage: (cb) => ws.on("message", (raw) => cb(raw.toString())),
      onClose: (cb) => ws.on("close", cb),
      onOpen: (cb) => {
        if (ws.readyState === WebSocket.OPEN) cb();
        else openHandlers.push(cb);
      },
    };
  };
}

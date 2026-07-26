import WebSocket from "ws";
import {
  FrameOpener,
  FrameSealer,
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHex,
  hexToBytes,
  signChallenge,
  utf8ToBytes,
  type DeviceKeyPair,
  type SessionKeys,
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
 * and copies relay protocol lines between the two — unsealing what comes from
 * the browser and sealing what goes back.
 *
 * The isolation is the point: the relay sees a perfectly normal authenticated
 * local client and knows nothing about tunnels, brokers, pairing or AES. No
 * relay internals are touched, so nothing here can regress the self-hosted
 * path. It also means the 64-hex AUTH_TOKEN is injected on this side of the
 * tunnel and never travels over it.
 *
 * ## Why the crypto lives here
 *
 * The browser seals every relay line under the pairing keys, so the wire
 * carries AES-GCM ciphertext and the broker is a blind forwarder. Something has
 * to be the other end of that seal, and it cannot be the relay — teaching the
 * relay about pairing keys would put the tunnel on the self-hosted path's
 * critical code. So the agent is the cryptographic peer: ciphertext in from the
 * broker, plaintext JSON out to loopback, and the reverse coming back.
 *
 * ## Why streams are matched to keys by trial decryption
 *
 * One agent serves every browser paired with this machine, each with its own
 * key schedule, all multiplexed over one tunnel. The broker tells us a stream
 * opened but deliberately knows nothing about which pairing it belongs to —
 * making it say would hand it exactly the mapping the design denies it. So the
 * first frame decides: whichever key schedule authenticates it owns the stream.
 * AES-GCM's tag is precisely the right discriminator, the keyring is small, and
 * a stream no key opens is refused rather than forwarded. That is also what
 * stops an unpaired browser that guessed a tunnel id from reaching the relay.
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

/**
 * How many pairings one agent will try a frame against.
 *
 * Bounds the cost of trial decryption and, with it, the work an unpaired caller
 * can make us do by opening streams. Oldest entries are evicted first.
 */
const MAX_KEYRING = 8;

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
  /**
   * Admit a completed pairing's keys, so streams sealed under them can be
   * opened. Called once `mtmux pair` finishes its PAKE.
   */
  addSessionKeys(keys: SessionKeys): void;
  readonly tunnelId: string | null;
  readonly status: AgentStatus;
};

/** Everything one browser↔relay stream needs. */
type Stream = {
  local: LocalSocket;
  /** Bound on the first frame that authenticates. */
  opener: FrameOpener | null;
  sealer: FrameSealer | null;
  /**
   * Serializes the async seal/open calls. WebCrypto is promise-based, and the
   * relay protocol is order-sensitive, so frames must not be allowed to
   * overtake one another between the two sockets.
   */
  chain: Promise<void>;
  localOpen: boolean;
  /** Plaintext lines unsealed before the loopback socket finished opening. */
  toLocal: string[];
  /** Relay lines produced before the browser's first frame bound a sealer. */
  toBroker: string[];
  closed: boolean;
};

export function createTunnelAgent(opts: TunnelAgentOptions): TunnelAgent {
  const retry = opts.scheduleRetry ?? defaultRetry;
  let broker: AgentSocket | null = null;
  let tunnelId: string | null = null;
  let status: AgentStatus = "disconnected";
  let attempt = 0;
  let stopped = false;

  const streams = new Map<string, Stream>();
  /** Key schedules of every pairing this process has completed. */
  const keyring: SessionKeys[] = [];

  function setStatus(next: AgentStatus, detail?: string) {
    status = next;
    opts.onStatus?.(next, detail);
  }

  function send(message: unknown) {
    broker?.send(JSON.stringify(message));
  }

  function dropStream(streamId: string, reason: string, tellBroker = true) {
    const stream = streams.get(streamId);
    if (!stream || stream.closed) return;
    stream.closed = true;
    streams.delete(streamId);
    stream.local.close();
    if (tellBroker) send({ type: "stream:close", streamId, reason });
  }

  function teardownStreams() {
    for (const streamId of [...streams.keys()]) {
      dropStream(streamId, "agent shutting down", false);
    }
    streams.clear();
  }

  function writeLocal(stream: Stream, line: string) {
    if (stream.localOpen) stream.local.send(line);
    else stream.toLocal.push(line);
  }

  /** Seal one relay line and hand it to the broker. */
  async function sealToBroker(streamId: string, stream: Stream, line: string) {
    if (!stream.sealer) {
      // The relay answered our own `auth` before the browser's first frame
      // arrived, so we do not yet know which key to seal under. Hold it.
      stream.toBroker.push(line);
      return;
    }
    const sealed = await stream.sealer.seal(utf8ToBytes(line));
    if (stream.closed) return;
    send({
      type: "stream:frame",
      streamId,
      data: bytesToBase64Url(sealed),
    });
  }

  /**
   * Unseal one browser frame and write the relay line inside it to loopback.
   *
   * The first frame on a stream also picks the key schedule; see the note at
   * the top of this file.
   */
  async function openFromBroker(
    streamId: string,
    stream: Stream,
    data: string,
  ) {
    let bytes: Uint8Array;
    try {
      bytes = base64UrlToBytes(data);
    } catch {
      dropStream(streamId, "malformed frame");
      return;
    }

    if (!stream.opener) {
      for (const keys of keyring) {
        // A fresh opener per candidate: a failed trial must not advance the
        // replay window of a schedule that turns out to be the right one.
        const opener = new FrameOpener(keys.c2s, "c2s");
        let line: string;
        try {
          line = new TextDecoder().decode(await opener.open(bytes));
        } catch {
          continue;
        }
        if (stream.closed) return;
        stream.opener = opener;
        stream.sealer = new FrameSealer(keys.s2c, "s2c");
        writeLocal(stream, line);
        // Flush anything the relay said while we did not know the key.
        for (const held of stream.toBroker.splice(0)) {
          await sealToBroker(streamId, stream, held);
        }
        return;
      }
      // No pairing this process knows about can open it. Refuse rather than
      // forward: this is the check that keeps a guessed tunnel id worthless.
      dropStream(streamId, "no matching pairing");
      return;
    }

    try {
      const line = new TextDecoder().decode(await stream.opener.open(bytes));
      if (!stream.closed) writeLocal(stream, line);
    } catch {
      // Tampered, replayed or reordered. There is no safe way to continue on a
      // stream whose integrity has failed.
      dropStream(streamId, "frame authentication failed");
    }
  }

  function openStream(streamId: string) {
    const local = opts.connectLocal();
    const stream: Stream = {
      local,
      opener: null,
      sealer: null,
      chain: Promise.resolve(),
      localOpen: false,
      toLocal: [],
      toBroker: [],
      closed: false,
    };
    streams.set(streamId, stream);

    local.onOpen(() => {
      stream.localOpen = true;
      for (const line of stream.toLocal.splice(0)) local.send(line);
    });

    local.onMessage((line) => {
      stream.chain = stream.chain
        .then(() => sealToBroker(streamId, stream, line))
        .catch(() => dropStream(streamId, "seal failed"));
    });

    local.onClose(() => {
      if (!stream.closed) dropStream(streamId, "local closed");
    });
  }

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
        openStream(message.streamId);
        return;
      }

      case "stream:frame": {
        const stream = streams.get(message.streamId);
        if (!stream || stream.closed) return;
        stream.chain = stream.chain
          .then(() => openFromBroker(message.streamId, stream, message.data))
          .catch(() => dropStream(message.streamId, "open failed"));
        return;
      }

      case "stream:close": {
        dropStream(message.streamId, "browser closed", false);
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
      broker?.close();
      broker = null;
      setStatus("stopped");
    },
    addSessionKeys(keys) {
      keyring.push(keys);
      if (keyring.length > MAX_KEYRING) keyring.shift();
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
    // A failed connect surfaces as a close, which tears the stream down.
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

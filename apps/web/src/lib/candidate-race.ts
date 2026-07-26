/**
 * Pick a direct route to the paired machine, or give up quickly.
 *
 * Every candidate is probed at once and the first relay to *authenticate* wins.
 * The timeout is short and the tunnel is always available as a backstop, which
 * is what makes "direct first" safe to attempt: a candidate that is blocked —
 * by a rebind-protecting resolver, a guest network, or simply the wrong subnet
 * — costs a few hundred milliseconds and then degrades, never fails.
 *
 * ## Why this probes over WebSocket rather than fetching /health
 *
 * Two reasons, and the second is the load-bearing one.
 *
 * A `fetch` to `http://192.168.x.y:14100/health` needs `connect-src` to permit
 * arbitrary hosts. LAN addresses cannot be enumerated at build time, so that
 * means allowing all of `http:` — which throws the directive away. Relay
 * sockets already run under `ws:`/`wss:`, so probing the socket costs no new
 * privilege.
 *
 * More importantly, an unauthenticated 200 from `/health` only proves *some*
 * HTTP server answered on that address; a captive portal or an unrelated
 * service on the same port passes it. Completing the relay's auth handshake
 * with the token derived from this pairing proves the far end really is the
 * machine we paired with, which a hijacked candidate cannot fake.
 */

export const CANDIDATE_TIMEOUT_MS = 800;

const RELAY_PATH = "/_relay";

export type RaceResult = {
  /** The winning base URL, or null when every candidate failed. */
  winner: string | null;
  /** How long the race took, for the connection detail panel. */
  elapsedMs: number;
};

/** Minimal socket surface, so the race is testable without a real network. */
export type ProbeSocket = {
  send(data: string): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
};

export type ProbeConnector = (url: string) => ProbeSocket;

export const webSocketProbe: ProbeConnector = (url) => {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: () => {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        // Already closing.
      }
    },
    onOpen: (cb) => {
      ws.onopen = cb;
    },
    onMessage: (cb) => {
      ws.onmessage = (event) => cb(event.data as string);
    },
    onClose: (cb) => {
      ws.onclose = cb;
      // An unreachable candidate surfaces as an error then a close; treating
      // error as close keeps one failure path.
      ws.onerror = cb;
    },
  };
};

/** Turn `http://host:port` into `ws://host:port/_relay`. */
export function probeUrlFor(candidate: string): string {
  return `${candidate.replace(/^http/, "ws")}${RELAY_PATH}`;
}

function probe(
  candidate: string,
  token: string,
  connect: ProbeConnector,
): { promise: Promise<string>; cancel: () => void } {
  let settled = false;
  let socket: ProbeSocket | null = null;

  const promise = new Promise<string>((resolve, reject) => {
    try {
      socket = connect(probeUrlFor(candidate));
    } catch {
      reject(new Error("connect failed"));
      return;
    }

    socket.onOpen(() => {
      socket?.send(JSON.stringify({ type: "auth", token }));
    });

    socket.onMessage((raw) => {
      if (settled) return;
      let type: unknown;
      try {
        type = (JSON.parse(raw) as { type?: unknown }).type;
      } catch {
        return;
      }
      if (type === "auth:success") {
        settled = true;
        resolve(candidate);
      } else if (type === "auth:error") {
        settled = true;
        reject(new Error("auth rejected"));
      }
    });

    socket.onClose(() => {
      if (settled) return;
      settled = true;
      reject(new Error("closed"));
    });
  });

  return {
    promise,
    cancel: () => {
      settled = true;
      socket?.close();
    },
  };
}

export async function raceCandidates(
  candidates: readonly string[],
  token: string,
  timeoutMs: number = CANDIDATE_TIMEOUT_MS,
  connect: ProbeConnector = webSocketProbe,
): Promise<RaceResult> {
  const started = Date.now();
  if (candidates.length === 0 || !token) {
    return { winner: null, elapsedMs: 0 };
  }

  const probes = candidates.map((candidate) =>
    probe(candidate, token, connect),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });

  try {
    // Promise.any resolves on the first success and only rejects once every
    // probe has failed, which is exactly the semantics we want. Racing it
    // against the timeout bounds the wait even when a candidate accepts the
    // connection and then never answers.
    const winner = await Promise.race([
      Promise.any(probes.map((p) => p.promise)),
      timeout,
    ]);
    return { winner, elapsedMs: Date.now() - started };
  } catch {
    return { winner: null, elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    // Every probe is torn down, including the winner: the real connection is
    // opened by RelayClient, never reused from here.
    for (const p of probes) p.cancel();
  }
}

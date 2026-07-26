import { describe, it, expect } from "vitest";
import {
  raceCandidates,
  probeUrlFor,
  type ProbeConnector,
  type ProbeSocket,
} from "./candidate-race";

/**
 * A scripted relay endpoint.
 *
 * `behaviour` decides what the far end does once the probe authenticates, which
 * is where the interesting cases live: an address that accepts a TCP connection
 * but is not our relay must lose, not win.
 */
type Behaviour = "accept" | "reject" | "refuse" | "silent" | "garbage";

function connector(
  plan: Record<string, Behaviour>,
  opened: string[] = [],
  closed: string[] = [],
): ProbeConnector & { opened: string[]; closed: string[] } {
  const fn = ((url: string): ProbeSocket => {
    opened.push(url);
    const behaviour = plan[url] ?? "refuse";
    let onOpen = () => {};
    let onMessage: (data: string) => void = () => {};
    let onClose = () => {};

    // Deliver asynchronously, as a real socket does.
    queueMicrotask(() => {
      if (behaviour === "refuse") {
        onClose();
        return;
      }
      onOpen();
      if (behaviour === "accept")
        onMessage(JSON.stringify({ type: "auth:success" }));
      if (behaviour === "reject")
        onMessage(JSON.stringify({ type: "auth:error" }));
      if (behaviour === "garbage") onMessage("<html>not our relay</html>");
      // "silent" answers nothing at all, so only the timeout ends it.
    });

    return {
      send: () => {},
      close: () => closed.push(url),
      onOpen: (cb) => {
        onOpen = cb;
      },
      onMessage: (cb) => {
        onMessage = cb;
      },
      onClose: (cb) => {
        onClose = cb;
      },
    };
  }) as ProbeConnector & { opened: string[]; closed: string[] };
  fn.opened = opened;
  fn.closed = closed;
  return fn;
}

const TOKEN = "derived-token";

describe("probeUrlFor", () => {
  it("turns an http candidate into a relay websocket url", () => {
    expect(probeUrlFor("http://192.168.1.5:14100")).toBe(
      "ws://192.168.1.5:14100/_relay",
    );
  });

  it("keeps tls when the candidate is https", () => {
    expect(probeUrlFor("https://host.lan.mtmux.com")).toBe(
      "wss://host.lan.mtmux.com/_relay",
    );
  });
});

describe("raceCandidates", () => {
  it("returns no winner when there are no candidates", async () => {
    const result = await raceCandidates([], TOKEN, 50, connector({}));
    expect(result.winner).toBeNull();
  });

  it("returns no winner without a token to authenticate with", async () => {
    const connect = connector({ "ws://a/_relay": "accept" });
    const result = await raceCandidates(["http://a"], "", 50, connect);
    expect(result.winner).toBeNull();
    // Nothing was even dialled: an unauthenticated probe could not prove
    // anything, so it is not worth the connection.
    expect(connect.opened).toHaveLength(0);
  });

  it("picks the candidate whose relay authenticates", async () => {
    const connect = connector({
      "ws://dead/_relay": "refuse",
      "ws://live/_relay": "accept",
    });
    const result = await raceCandidates(
      ["http://dead", "http://live"],
      TOKEN,
      500,
      connect,
    );
    expect(result.winner).toBe("http://live");
  });

  it("rejects an address that answers but is not our relay", async () => {
    // A captive portal or unrelated service on the same port. The old /health
    // probe accepted any 200 here; completing the auth handshake does not.
    const connect = connector({ "ws://portal/_relay": "garbage" });
    const result = await raceCandidates(["http://portal"], TOKEN, 60, connect);
    expect(result.winner).toBeNull();
  });

  it("rejects a relay that refuses the derived token", async () => {
    const connect = connector({ "ws://other/_relay": "reject" });
    const result = await raceCandidates(["http://other"], TOKEN, 500, connect);
    expect(result.winner).toBeNull();
  });

  it("gives up on a candidate that connects and then goes quiet", async () => {
    const connect = connector({ "ws://blackhole/_relay": "silent" });
    const started = Date.now();
    const result = await raceCandidates(
      ["http://blackhole"],
      TOKEN,
      80,
      connect,
    );
    expect(result.winner).toBeNull();
    // Bounded by the timeout rather than hanging forever.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("still wins when one candidate hangs and another answers", async () => {
    const connect = connector({
      "ws://blackhole/_relay": "silent",
      "ws://live/_relay": "accept",
    });
    const result = await raceCandidates(
      ["http://blackhole", "http://live"],
      TOKEN,
      500,
      connect,
    );
    expect(result.winner).toBe("http://live");
  });

  it("tears down every probe, including the winner", async () => {
    const connect = connector({
      "ws://a/_relay": "accept",
      "ws://b/_relay": "silent",
    });
    await raceCandidates(["http://a", "http://b"], TOKEN, 500, connect);
    // RelayClient opens the real connection; a probe socket left open would be
    // a leaked connection per pairing.
    expect(connect.closed.sort()).toEqual(["ws://a/_relay", "ws://b/_relay"]);
  });

  it("reports how long the race took", async () => {
    const connect = connector({ "ws://live/_relay": "accept" });
    const result = await raceCandidates(["http://live"], TOKEN, 500, connect);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.elapsedMs).toBeLessThan(2000);
  });
});

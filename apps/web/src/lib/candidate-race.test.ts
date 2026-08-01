import { describe, it, expect } from "vitest";
import {
  raceCandidates,
  probeUrlFor,
  usableCandidates,
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

/**
 * The mixed-content filter.
 *
 * The CLI advertises LAN candidates as `http://192.168.x.y:14100`, which the
 * probe turns into `ws://…`. From an https page that is active mixed content:
 * Chrome blocks it *and* marks the origin "not secure", so on app.mtmux.com
 * these probes bought a security warning and 800 ms of blocked requests. On an
 * http origin — the self-hosted app served off the machine's own port — they
 * are the entire point of the direct path.
 */
describe("usableCandidates", () => {
  const withProtocol = <T>(protocol: string, run: () => T): T => {
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { location: { protocol } };
    try {
      return run();
    } finally {
      if (previous === undefined)
        delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = previous;
    }
  };

  const LAN = "http://192.168.1.5:14100";
  const SECURE = "https://box.example.com";

  it("drops http candidates on an https page", () => {
    withProtocol("https:", () => {
      expect(usableCandidates([LAN, SECURE])).toEqual([SECURE]);
    });
  });

  it("keeps http candidates on an http page", () => {
    withProtocol("http:", () => {
      expect(usableCandidates([LAN, SECURE])).toEqual([LAN, SECURE]);
    });
  });

  it("can empty the list entirely, which is the tunnel-only case", () => {
    withProtocol("https:", () => {
      expect(usableCandidates([LAN])).toEqual([]);
    });
  });

  it("leaves the list alone when there is no window at all", () => {
    // SSR and prerender. Filtering on a guess about the eventual origin would
    // be worse than not filtering.
    expect(usableCandidates([LAN, SECURE])).toEqual([LAN, SECURE]);
  });
});

describe("raceCandidates filters before it dials", () => {
  it("never opens a blocked candidate from an https page", async () => {
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      location: { protocol: "https:" },
    };
    try {
      const opened: string[] = [];
      const result = await raceCandidates(
        ["http://192.168.1.5:14100"],
        "token",
        50,
        connector({}, opened),
      );
      // Not merely lost — never attempted. A blocked request is not a probe,
      // it is a console error and a warning badge on the origin.
      expect(opened).toEqual([]);
      expect(result.winner).toBeNull();
    } finally {
      if (previous === undefined)
        delete (globalThis as { window?: unknown }).window;
      else (globalThis as { window?: unknown }).window = previous;
    }
  });
});

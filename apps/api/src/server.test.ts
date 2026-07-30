import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import {
  bytesToHex,
  hexToBytes,
  generateDeviceKey,
  signChallenge,
} from "@repo/crypto";
import {
  startApiServer,
  routeSocketPath,
  clientIp,
  type ApiServer,
} from "./server.js";

/**
 * Drives the real HTTP server and real WebSockets, so the transport wiring —
 * routing, upgrade handling, the `ws` adapter — is covered rather than just
 * the broker logic underneath it.
 */
let api: ApiServer;
let base: string;

beforeAll(async () => {
  api = await startApiServer(0, "127.0.0.1");
  const { port } = api.server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await api.close();
});

async function post(path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as unknown,
  };
}

/** Open a socket and collect messages until `predicate` is satisfied. */
function open(path: string) {
  const url = base.replace("http:", "ws:") + path;
  const ws = new WebSocket(url);
  const received: Record<string, unknown>[] = [];
  const waiters: {
    type: string;
    resolve: (m: Record<string, unknown>) => void;
  }[] = [];

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    received.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.type === msg.type) {
        waiters.splice(i, 1)[0]!.resolve(msg);
      }
    }
  });

  return {
    ws,
    received,
    opened: new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    }),
    closed: new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once("close", (code, reason) =>
        resolve({ code, reason: reason.toString() }),
      );
    }),
    waitFor(type: string, timeoutMs = 3000) {
      const already = received.find((m) => m.type === type);
      if (already) return Promise.resolve(already);
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${type}`)),
          timeoutMs,
        );
        waiters.push({
          type,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      });
    },
    send(msg: unknown) {
      ws.send(JSON.stringify(msg));
    },
  };
}

describe("HTTP surface", () => {
  it("serves /health", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as { status: string }).status).toBe("ok");
  });

  it("echoes the caller's address from /v1/discover", async () => {
    const res = await fetch(`${base}/v1/discover`);
    expect(res.status).toBe(200);
    expect(typeof ((await res.json()) as { ip: string }).ip).toBe("string");
  });

  it("opens a mailbox", async () => {
    const { status, body } = await post("/v1/pair/new");
    expect(status).toBe(200);
    expect((body as { slot: string }).slot).toMatch(/^\d{2}$/);
  });

  it("404s an unknown path", async () => {
    expect((await fetch(`${base}/v1/nope`)).status).toBe(404);
  });

  it("rejects a malformed claim body", async () => {
    expect((await post("/v1/pair/claim", { slot: "bad" })).status).toBe(400);
  });

  it("survives a body that is not JSON", async () => {
    const res = await fetch(`${base}/v1/pair/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{{{",
    });
    expect(res.status).toBe(400);
  });

  it("answers CORS preflight", async () => {
    const res = await fetch(`${base}/v1/pair/new`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });
});

describe("websocket routing", () => {
  it("maps known paths and rejects everything else", () => {
    expect(routeSocketPath("/v1/agent")).toEqual({ kind: "agent" });
    expect(routeSocketPath("/v1/pair/mbx-abcdefgh")).toEqual({
      kind: "pair",
      id: "mbx-abcdefgh",
    });
    expect(routeSocketPath("/v1/claim/clm-abcdefgh")).toEqual({
      kind: "claim",
      id: "clm-abcdefgh",
    });
    expect(routeSocketPath("/v1/tunnel/tnl-abcdefgh")).toEqual({
      kind: "tunnel",
      id: "tnl-abcdefgh",
    });
    expect(routeSocketPath("/v1/pair/short")).toBeNull();
    expect(routeSocketPath("/v1/pair/../etc")).toBeNull();
    expect(routeSocketPath("/")).toBeNull();
    expect(routeSocketPath("/_relay")).toBeNull();
  });

  it("destroys an upgrade on an unknown path", async () => {
    const sock = open("/nope");
    await expect(sock.opened).rejects.toThrow();
  });

  it("delivers pair:ready over a real socket", async () => {
    const { body } = await post("/v1/pair/new");
    const { mailboxId, slot } = body as { mailboxId: string; slot: string };
    const sock = open(`/v1/pair/${mailboxId}`);
    await sock.opened;
    const ready = await sock.waitFor("pair:ready");
    expect(ready.slot).toBe(slot);
    sock.ws.close();
  });

  it("closes a socket for an unknown mailbox", async () => {
    const sock = open("/v1/pair/mbx-doesnotexist");
    await sock.opened;
    const failed = await sock.waitFor("pair:failed");
    expect(failed.reason).toBe("expired");
    expect((await sock.closed).code).toBe(1008);
  });

  it("carries a claim from HTTP through to the browser's socket", async () => {
    const { body } = await post("/v1/pair/new");
    const { mailboxId, slot } = body as { mailboxId: string; slot: string };
    const browser = open(`/v1/pair/${mailboxId}`);
    await browser.opened;
    await browser.waitFor("pair:ready");

    const claim = await post("/v1/pair/claim", {
      slot,
      share: "a".repeat(64),
      ad: "cli",
      sid: "b".repeat(32),
    });
    expect((claim.body as { waiting: boolean }).waiting).toBe(true);

    const peerShare = await browser.waitFor("pair:peer-share");
    expect(peerShare.share).toBe("a".repeat(64));
    expect(typeof peerShare.peer).toBe("string");
    browser.ws.close();
  });

  it("buffers messages produced before the CLI's socket attaches", async () => {
    // The CLI POSTs its claim and only then connects, so fan-out replies can
    // legitimately beat the socket. Nothing may be lost in that window.
    const { body } = await post("/v1/pair/new");
    const { mailboxId, slot } = body as { mailboxId: string; slot: string };
    const browser = open(`/v1/pair/${mailboxId}`);
    await browser.opened;
    await browser.waitFor("pair:ready");

    const claim = await post("/v1/pair/claim", {
      slot,
      share: "a".repeat(64),
      ad: "cli",
      sid: "b".repeat(32),
    });
    const { claimId } = claim.body as { claimId: string };

    const peerShare = await browser.waitFor("pair:peer-share");
    // Browser answers while the CLI is still not connected.
    browser.send({
      type: "pair:share",
      peer: peerShare.peer,
      share: "c".repeat(64),
      ad: "browser",
    });
    await new Promise((r) => setTimeout(r, 50));

    const cli = open(`/v1/claim/${claimId}`);
    await cli.opened;
    const buffered = await cli.waitFor("pair:peer-share");
    expect(buffered.share).toBe("c".repeat(64));

    browser.ws.close();
    cli.ws.close();
  });

  it("runs an agent registration over a real socket", async () => {
    const agent = open("/v1/agent");
    await agent.opened;
    const challenge = (await agent.waitFor("tunnel:challenge"))
      .challenge as string;

    const key = generateDeviceKey();
    agent.send({
      type: "tunnel:register",
      deviceId: key.deviceId,
      publicKey: bytesToHex(key.publicKey),
      challenge,
      signature: bytesToHex(
        signChallenge(key.secretKey, hexToBytes(challenge)),
      ),
    });

    const ready = await agent.waitFor("tunnel:ready");
    expect(typeof ready.tunnelId).toBe("string");

    // A browser can then open a stream on it and exchange sealed frames.
    const browser = open(`/v1/tunnel/${ready.tunnelId as string}`);
    await browser.opened;
    const open1 = await browser.waitFor("stream:open");
    await agent.waitFor("stream:open");

    browser.send({
      type: "stream:frame",
      streamId: open1.streamId,
      data: "dXAtZnJhbWU",
    });
    const forwarded = await agent.waitFor("stream:frame");
    expect(forwarded.data).toBe("dXAtZnJhbWU");

    browser.ws.close();
    agent.ws.close();
  });

  it("closes a browser tunnel socket for an unknown tunnel", async () => {
    const sock = open("/v1/tunnel/tnl-doesnotexist");
    await sock.opened;
    const closed = await sock.waitFor("tunnel:closed");
    expect(closed.reason).toBe("agent-gone");
  });
});

describe("clientIp", () => {
  const req = (headers: Record<string, string | string[]>, remote?: string) =>
    ({
      headers,
      socket: { remoteAddress: remote },
    }) as unknown as Parameters<typeof clientIp>[0];

  it("prefers CF-Connecting-IP behind a trusted proxy", () => {
    // In production the vhost sets `X-Forwarded-For $remote_addr`, and in front
    // of nginx sits Cloudflare — so XFF holds the *PoP's* address. Bucketing on
    // that put every visitor behind a PoP in one window: a denial of service
    // against honest users, and a limiter isolating no attacker.
    expect(
      clientIp(
        req(
          {
            "cf-connecting-ip": "203.0.113.7",
            "x-forwarded-for": "162.158.1.1",
          },
          "127.0.0.1",
        ),
      ),
    ).toBe("203.0.113.7");
  });

  it("falls back to the left-most X-Forwarded-For entry", () => {
    // A self-hosted install behind a plain reverse proxy has no Cloudflare.
    expect(
      clientIp(
        req({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }, "127.0.0.1"),
      ),
    ).toBe("203.0.113.7");
  });

  it("ignores both headers from an untrusted peer", () => {
    // Otherwise any direct caller picks its own rate-limit bucket — or someone
    // else's — just by setting a header.
    expect(
      clientIp(
        req(
          {
            "cf-connecting-ip": "203.0.113.7",
            "x-forwarded-for": "203.0.113.8",
          },
          "198.51.100.4",
        ),
      ),
    ).toBe("198.51.100.4");
  });

  it("falls back to the socket peer", () => {
    expect(clientIp(req({}, "198.51.100.4"))).toBe("198.51.100.4");
  });

  it("never returns an empty string", () => {
    // A blank header falls through to the peer, which behind the proxy is the
    // proxy itself — one shared bucket, but never an empty key.
    expect(clientIp(req({ "x-forwarded-for": "  " }, "127.0.0.1"))).toBe(
      "127.0.0.1",
    );
    expect(clientIp(req({ "cf-connecting-ip": " " }, "127.0.0.1"))).toBe(
      "127.0.0.1",
    );
    expect(clientIp(req({}))).toBe("unknown");
  });
});

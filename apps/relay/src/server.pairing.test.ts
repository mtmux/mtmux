import { describe, it, expect, beforeEach } from "vitest";
import { Readable } from "node:stream";
import type http from "node:http";
import { handleRelayRequest, PAIR_LOCAL_PATH } from "./server.js";
import { issuePairingNonce, resetPairingState } from "./pairing-local.js";
import { authenticateMessage } from "./auth.js";
import { resetAuthThrottle } from "./auth-throttle.js";
import { config } from "./config.js";

type Captured = {
  status: number;
  headers: Record<string, unknown>;
  body: string;
};

function mockRequest(
  method: string,
  url: string,
  body?: string,
): http.IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  const req = stream as unknown as http.IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1:14100" };
  return req;
}

function mockResponse(): {
  res: http.ServerResponse;
  captured: Captured;
  done: Promise<void>;
} {
  const captured: Captured = { status: 0, headers: {}, body: "" };
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));

  const res = {
    setHeader(name: string, value: unknown) {
      captured.headers[name] = value;
    },
    writeHead(status: number, headers?: Record<string, unknown>) {
      captured.status = status;
      Object.assign(captured.headers, headers ?? {});
      return res;
    },
    end(chunk?: string) {
      if (chunk) captured.body += chunk;
      resolve();
      return res;
    },
  } as unknown as http.ServerResponse;

  return { res, captured, done };
}

async function post(body?: string): Promise<Captured> {
  const { res, captured, done } = mockResponse();
  const handled = await handleRelayRequest(
    mockRequest("POST", PAIR_LOCAL_PATH, body),
    res,
  );
  expect(handled).toBe(true);
  await done;
  return captured;
}

describe("POST /_pair/local", () => {
  beforeEach(() => {
    resetPairingState();
    resetAuthThrottle();
  });

  it("turns a live nonce into a session token the relay will accept", async () => {
    const { nonce } = issuePairingNonce();

    const captured = await post(JSON.stringify({ nonce }));
    expect(captured.status).toBe(200);

    const { token } = JSON.parse(captured.body) as { token: string };
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // The whole point: this is NOT the long-lived AUTH_TOKEN.
    expect(token).not.toBe(config.authToken);

    // A LAN pairing is a full grant — it is the machine's owner, standing in
    // front of the machine, scanning the QR it printed.
    const paired = authenticateMessage({ type: "auth", token }, "192.168.1.9");
    expect(paired.authenticated).toBe(true);
    expect(paired.grant?.scope.kind).toBe("all");
  });

  it("never caches the response", async () => {
    const { nonce } = issuePairingNonce();
    const captured = await post(JSON.stringify({ nonce }));
    expect(captured.headers["Cache-Control"]).toBe("no-store");
  });

  it("refuses a nonce that was already spent", async () => {
    const { nonce } = issuePairingNonce();
    expect((await post(JSON.stringify({ nonce }))).status).toBe(200);

    const second = await post(JSON.stringify({ nonce }));
    expect(second.status).toBe(401);
    expect(second.body).not.toContain(nonce);
  });

  it("refuses an unknown nonce", async () => {
    issuePairingNonce();
    expect((await post(JSON.stringify({ nonce: "wrong" }))).status).toBe(401);
  });

  it("refuses everything when no nonce was ever armed (split mode)", async () => {
    expect((await post(JSON.stringify({ nonce: "anything" }))).status).toBe(
      401,
    );
  });

  it("rejects a missing or malformed body", async () => {
    expect((await post()).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    expect((await post("{}")).status).toBe(400);
    expect((await post(JSON.stringify({ nonce: 42 }))).status).toBe(400);
  });

  it("rejects GET — the nonce must never ride in a query string", async () => {
    const { res, captured, done } = mockResponse();
    await handleRelayRequest(mockRequest("GET", PAIR_LOCAL_PATH), res);
    await done;
    expect(captured.status).toBe(405);
    expect(captured.headers.Allow).toBe("POST");
  });

  it("leaves unrelated routes to fall through to Next", async () => {
    const { res } = mockResponse();
    const handled = await handleRelayRequest(mockRequest("GET", "/login"), res);
    expect(handled).toBe(false);
  });
});

describe("session tokens and the auth throttle together", () => {
  beforeEach(() => {
    resetPairingState();
    resetAuthThrottle();
  });

  const IP = "192.168.1.77";

  it("locks out an address after five bad tokens, then honours a good one", async () => {
    for (let i = 0; i < 4; i++) {
      expect(
        authenticateMessage({ type: "auth", token: "guess" }, IP).authenticated,
      ).toBe(false);
    }
    // Fifth failure trips the backoff…
    const fifth = authenticateMessage({ type: "auth", token: "guess" }, IP);
    expect(fifth.authenticated).toBe(false);
    expect(fifth.retryAfterMs).toBeGreaterThan(0);

    // …and even the *correct* token is refused while it is in force.
    const locked = authenticateMessage(
      { type: "auth", token: config.authToken },
      IP,
    );
    expect(locked.authenticated).toBe(false);
    expect(locked.reason).toMatch(/Too many failed attempts/);

    // A different address is unaffected.
    expect(
      authenticateMessage(
        { type: "auth", token: config.authToken },
        "10.0.0.1",
      ),
    ).toMatchObject({ authenticated: true });
  });

  it("still accepts the long-lived AUTH_TOKEN alongside session tokens", () => {
    expect(
      authenticateMessage({ type: "auth", token: config.authToken }, IP),
    ).toMatchObject({ authenticated: true });
  });

  it("rejects a session token after the pairing state is reset", async () => {
    const { nonce } = issuePairingNonce();
    const { token } = JSON.parse(
      (await post(JSON.stringify({ nonce }))).body,
    ) as {
      token: string;
    };
    expect(authenticateMessage({ type: "auth", token }, IP).authenticated).toBe(
      true,
    );

    resetPairingState();
    resetAuthThrottle();
    expect(authenticateMessage({ type: "auth", token }, IP).authenticated).toBe(
      false,
    );
  });
});

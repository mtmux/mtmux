import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { redeemLocalPairingNonce, PAIR_LOCAL_PATH } from "./local-pairing";

type FetchCall = { url: string; init: RequestInit };

function stubFetch(reply: { status: number; body?: unknown }): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: () => Promise.resolve(reply.body),
    } as Response);
  });
  return calls;
}

describe("redeemLocalPairingNonce", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the nonce in the body, never the URL", async () => {
    const calls = stubFetch({
      status: 200,
      body: { token: "a".repeat(64), expiresAt: 123 },
    });

    await redeemLocalPairingNonce("nonce-value");

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toContain(PAIR_LOCAL_PATH);
    // The credential must not be reachable from an access log or Referer.
    expect(call!.url).not.toContain("nonce-value");
    expect(call!.init.method).toBe("POST");
    expect(JSON.parse(call!.init.body as string)).toEqual({
      nonce: "nonce-value",
    });
  });

  it("returns the issued session token", async () => {
    const token = "b".repeat(64);
    stubFetch({ status: 200, body: { token, expiresAt: 999 } });
    await expect(redeemLocalPairingNonce("n")).resolves.toEqual({
      token,
      expiresAt: 999,
    });
  });

  it("explains a spent or expired code on 401", async () => {
    stubFetch({ status: 401, body: { error: "nope" } });
    await expect(redeemLocalPairingNonce("n")).rejects.toThrow(
      /expired or was already used/,
    );
  });

  it("surfaces other failures with their status", async () => {
    stubFetch({ status: 500 });
    await expect(redeemLocalPairingNonce("n")).rejects.toThrow(
      /Pairing failed \(500\)/,
    );
  });

  it("rejects a malformed success payload rather than storing junk", async () => {
    stubFetch({ status: 200, body: { expiresAt: 1 } });
    await expect(redeemLocalPairingNonce("n")).rejects.toThrow(/malformed/);
  });

  it("defaults expiresAt when the server omits it", async () => {
    const token = "c".repeat(64);
    stubFetch({ status: 200, body: { token } });
    await expect(redeemLocalPairingNonce("n")).resolves.toEqual({
      token,
      expiresAt: 0,
    });
  });
});

import { describe, it, expect } from "vitest";
import { rearmDecision, resolveHost, resolveLanUrl } from "./start.js";
import { PairingError } from "../pairing-client.js";

const LAN = { address: "192.168.1.5", iface: "wlp3s0" };

describe("resolveHost", () => {
  it("binds every interface when there is a LAN to serve", () => {
    expect(resolveHost(undefined, LAN)).toBe("0.0.0.0");
  });

  it("stays on loopback when there is no LAN", () => {
    expect(resolveHost(undefined, null)).toBe("127.0.0.1");
  });

  it("always honours an explicit --host", () => {
    expect(resolveHost("127.0.0.1", LAN)).toBe("127.0.0.1");
    expect(resolveHost("10.0.0.4", null)).toBe("10.0.0.4");
    expect(resolveHost("0.0.0.0", null)).toBe("0.0.0.0");
  });
});

describe("resolveLanUrl", () => {
  it("resolves a wildcard bind to the real LAN address", () => {
    expect(resolveLanUrl("0.0.0.0", 14100, LAN)).toBe(
      "http://192.168.1.5:14100",
    );
    expect(resolveLanUrl("::", 14100, LAN)).toBe("http://192.168.1.5:14100");
  });

  it("suppresses the network URL on a loopback bind", () => {
    for (const host of ["127.0.0.1", "::1", "localhost"]) {
      expect(resolveLanUrl(host, 14100, LAN)).toBeNull();
    }
  });

  it("returns nothing for a wildcard bind with no LAN", () => {
    expect(resolveLanUrl("0.0.0.0", 14100, null)).toBeNull();
  });

  it("echoes an explicitly pinned non-loopback host", () => {
    expect(resolveLanUrl("10.0.0.4", 8080, LAN)).toBe("http://10.0.0.4:8080");
  });

  it("never produces a URL containing 0.0.0.0", () => {
    const urls = [
      resolveLanUrl("0.0.0.0", 14100, LAN),
      resolveLanUrl("0.0.0.0", 14100, null),
    ];
    for (const url of urls) expect(url ?? "").not.toContain("0.0.0.0");
  });
});

describe("rearmDecision", () => {
  const expired = () => new PairingError("expired", undefined, "expired");
  const wrongCode = () => new PairingError("nope", undefined, "no-match");

  it("keeps arming while codes keep expiring, up to the budget", () => {
    let expiries = 0;
    for (let i = 1; i < 5; i += 1) {
      const d = rearmDecision(expired(), expiries, 5);
      expiries = d.expiries;
      expect(d.rearm).toBe(true);
      expect(d.expiries).toBe(i);
    }
  });

  it("stops arming once the budget is spent", () => {
    // The exposure window was the process lifetime, not the code's three
    // minutes: an abandoned terminal handed out unlimited independent draws.
    const d = rearmDecision(expired(), 4, 5);
    expect(d.rearm).toBe(false);
    expect(d.expiries).toBe(5);
  });

  it("resets the budget when somebody actually tries", () => {
    // A wrong code proves a human is at the other end. Only silence should
    // count against an unwatched terminal.
    const d = rearmDecision(wrongCode(), 4, 5);
    expect(d.rearm).toBe(true);
    expect(d.expiries).toBe(0);
  });

  it("treats an unknown failure as engagement rather than silence", () => {
    const d = rearmDecision(new Error("socket died"), 4, 5);
    expect(d.rearm).toBe(true);
    expect(d.expiries).toBe(0);
  });
});

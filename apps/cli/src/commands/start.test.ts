import { describe, it, expect } from "vitest";
import { resolveHost, resolveLanUrl } from "./start.js";

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

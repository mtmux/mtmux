import { describe, it, expect } from "vitest";
import type os from "node:os";
import { getLanAddresses, primaryLanAddress } from "./lan.js";

type Iface = os.NetworkInterfaceInfo;

function ipv4(address: string, internal = false): Iface {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}

function ipv6(address: string): Iface {
  return {
    address,
    netmask: "ffff:ffff:ffff:ffff::",
    family: "IPv6",
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/64`,
    scopeid: 0,
  };
}

describe("getLanAddresses", () => {
  it("returns nothing when only loopback is present", () => {
    expect(getLanAddresses({ lo: [ipv4("127.0.0.1", true)] })).toEqual([]);
  });

  it("finds a single wifi address", () => {
    expect(
      getLanAddresses({
        lo: [ipv4("127.0.0.1", true)],
        wlp3s0: [ipv4("192.168.1.5")],
      }),
    ).toEqual([{ address: "192.168.1.5", iface: "wlp3s0" }]);
  });

  it("ranks 192.168 above 10.x above 172.16-31 above link-local", () => {
    const result = getLanAddresses({
      a0: [ipv4("169.254.10.1")],
      b0: [ipv4("172.20.0.4")],
      c0: [ipv4("10.1.2.3")],
      d0: [ipv4("192.168.0.9")],
    });
    expect(result.map((r) => r.address)).toEqual([
      "192.168.0.9",
      "10.1.2.3",
      "172.20.0.4",
      "169.254.10.1",
    ]);
  });

  it("treats 172.15 and 172.32 as outside the private block", () => {
    const result = getLanAddresses({
      lo: [ipv4("127.0.0.1", true)],
      e0: [ipv4("172.15.0.1")],
      e1: [ipv4("172.32.0.1")],
      e2: [ipv4("172.16.0.1")],
      e3: [ipv4("172.31.255.254")],
    });
    expect(result.map((r) => r.address)).toEqual([
      "172.16.0.1",
      "172.31.255.254",
    ]);
  });

  it("skips container bridges, VM host-only nets and VPN overlays", () => {
    const result = getLanAddresses({
      docker0: [ipv4("172.17.0.1")],
      "br-1a2b3c": [ipv4("172.18.0.1")],
      veth9f2: [ipv4("10.0.5.1")],
      virbr0: [ipv4("192.168.122.1")],
      vboxnet0: [ipv4("192.168.56.1")],
      tailscale0: [ipv4("100.101.102.103")],
      wg0: [ipv4("10.9.0.2")],
      eth0: [ipv4("192.168.1.20")],
    });
    expect(result).toEqual([{ address: "192.168.1.20", iface: "eth0" }]);
  });

  it("drops public addresses — a VPS IP is not 'your network'", () => {
    expect(
      getLanAddresses({
        eth0: [ipv4("203.0.113.7")],
        lo: [ipv4("127.0.0.1", true)],
      }),
    ).toEqual([]);
  });

  it("drops CGNAT (100.64/10) addresses", () => {
    expect(getLanAddresses({ eth0: [ipv4("100.64.1.1")] })).toEqual([]);
  });

  it("ignores IPv6 addresses", () => {
    expect(
      getLanAddresses({ eth0: [ipv6("fe80::1"), ipv4("192.168.4.4")] }),
    ).toEqual([{ address: "192.168.4.4", iface: "eth0" }]);
  });

  it("accepts the legacy numeric family reported by older Node", () => {
    const legacy = {
      ...ipv4("192.168.7.7"),
      family: 4 as unknown as "IPv4",
    };
    expect(getLanAddresses({ eth0: [legacy] })).toEqual([
      { address: "192.168.7.7", iface: "eth0" },
    ]);
  });

  it("orders same-rank addresses by interface name so output is stable", () => {
    const result = getLanAddresses({
      wlan0: [ipv4("192.168.1.9")],
      eth0: [ipv4("192.168.1.8")],
    });
    expect(result.map((r) => r.iface)).toEqual(["eth0", "wlan0"]);
  });

  it("tolerates interfaces with no address list", () => {
    expect(
      getLanAddresses({ eth0: undefined, wlan0: [ipv4("10.0.0.2")] }),
    ).toEqual([{ address: "10.0.0.2", iface: "wlan0" }]);
  });

  it("rejects malformed dotted-quads", () => {
    expect(
      getLanAddresses({
        a: [ipv4("192.168.1")],
        b: [ipv4("192.168.1.1.1")],
        c: [ipv4("192.168.01x.4")],
        d: [ipv4("192.168.300.4")],
      }),
    ).toEqual([]);
  });
});

describe("primaryLanAddress", () => {
  it("returns the best-ranked address", () => {
    expect(
      primaryLanAddress({
        eth0: [ipv4("10.0.0.5")],
        wlan0: [ipv4("192.168.1.5")],
      }),
    ).toEqual({ address: "192.168.1.5", iface: "wlan0" });
  });

  it("returns null when there is no LAN", () => {
    expect(primaryLanAddress({ lo: [ipv4("127.0.0.1", true)] })).toBeNull();
  });
});

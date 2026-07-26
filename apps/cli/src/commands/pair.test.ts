import { describe, it, expect } from "vitest";
import type os from "node:os";
import {
  FrameOpener,
  deriveSessionKeys,
  randomBytes,
  utf8ToBytes,
} from "@repo/crypto";
import { SealedDescriptor } from "@repo/protocol";
import { buildCandidates, deviceLabel, sealDescriptor } from "./pair.js";

function ipv4(address: string, internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}

describe("buildCandidates", () => {
  it("lists LAN addresses best-first with the serving port", () => {
    expect(
      buildCandidates(14100, null, {
        eth0: [ipv4("10.0.0.5")],
        wlan0: [ipv4("192.168.1.5")],
      }),
    ).toEqual(["http://192.168.1.5:14100", "http://10.0.0.5:14100"]);
  });

  it("appends the discovered public address last", () => {
    expect(
      buildCandidates(14100, "203.0.113.9", { wlan0: [ipv4("192.168.1.5")] }),
    ).toEqual(["http://192.168.1.5:14100", "http://203.0.113.9:14100"]);
  });

  it("returns nothing to race when there is no LAN and no public address", () => {
    expect(
      buildCandidates(14100, null, { lo: [ipv4("127.0.0.1", true)] }),
    ).toEqual([]);
  });

  it("excludes container bridges, which are unreachable from a phone", () => {
    expect(
      buildCandidates(14100, null, {
        docker0: [ipv4("172.17.0.1")],
        wlan0: [ipv4("192.168.1.5")],
      }),
    ).toEqual(["http://192.168.1.5:14100"]);
  });

  it("stays within the schema's eight-candidate cap", () => {
    const many: Record<string, os.NetworkInterfaceInfo[]> = {};
    for (let i = 0; i < 12; i++) many[`eth${i}`] = [ipv4(`192.168.1.${i + 2}`)];
    const candidates = buildCandidates(14100, "203.0.113.9", many);
    expect(candidates.length).toBeLessThanOrEqual(8);
    expect(
      SealedDescriptor.safeParse({
        candidates,
        tunnelId: "tnl-abcdefgh",
        deviceId: "0".repeat(16),
        publicKey: "1".repeat(64),
        label: "x",
      }).success,
    ).toBe(true);
  });

  it("produces URLs the descriptor schema accepts", () => {
    const candidates = buildCandidates(14100, "203.0.113.9", {
      wlan0: [ipv4("192.168.1.5")],
    });
    for (const url of candidates) expect(() => new URL(url)).not.toThrow();
  });
});

describe("deviceLabel", () => {
  it("is user@host and non-empty", () => {
    const label = deviceLabel();
    expect(label).toMatch(/^.+@.+$/);
    expect(label.length).toBeLessThanOrEqual(128);
  });
});

describe("sealDescriptor", () => {
  const keys = deriveSessionKeys(randomBytes(64), utf8ToBytes("transcript"));
  const descriptor = {
    candidates: ["http://192.168.1.5:14100"],
    tunnelId: "tnl-abcdefgh",
    deviceId: "0".repeat(16),
    publicKey: "1".repeat(64),
    label: "gagan@thinkpad",
  };

  it("is readable only by a peer holding the CLI→browser key", async () => {
    const sealed = await sealDescriptor(keys, descriptor);
    const opened = await new FrameOpener(keys.s2c, "s2c").open(sealed);
    expect(JSON.parse(new TextDecoder().decode(opened))).toEqual(descriptor);
  });

  it("hides the LAN topology from anyone without the key", async () => {
    const sealed = await sealDescriptor(keys, descriptor);
    const asText = new TextDecoder().decode(sealed);
    expect(asText).not.toContain("192.168.1.5");
    expect(asText).not.toContain("tnl-abcdefgh");

    const wrongKey = deriveSessionKeys(randomBytes(64), utf8ToBytes("other"));
    await expect(
      new FrameOpener(wrongKey.s2c, "s2c").open(sealed),
    ).rejects.toThrow(/failed authentication/);
  });

  it("produces something the descriptor schema round-trips", async () => {
    const sealed = await sealDescriptor(keys, descriptor);
    const opened = await new FrameOpener(keys.s2c, "s2c").open(sealed);
    expect(
      SealedDescriptor.safeParse(JSON.parse(new TextDecoder().decode(opened)))
        .success,
    ).toBe(true);
  });
});

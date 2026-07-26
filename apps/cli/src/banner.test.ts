import { describe, it, expect } from "vitest";
import { renderBannerLines, qrLines } from "./banner.js";

const TOKEN = "a".repeat(64);

function render(overrides: Partial<Parameters<typeof renderBannerLines>[0]>) {
  return renderBannerLines({
    localUrl: "http://localhost:14100",
    token: TOKEN,
    columns: 120,
    ...overrides,
  });
}

describe("renderBannerLines", () => {
  it("always shows the loopback URL", () => {
    const out = render({}).join("\n");
    expect(out).toContain("On this machine");
    expect(out).toContain("http://localhost:14100");
  });

  it("omits the network section when there is no LAN URL", () => {
    const out = render({ lanUrl: null }).join("\n");
    expect(out).not.toContain("On your network");
  });

  it("prints the real LAN URL and its interface — never '0.0.0.0'", () => {
    const out = render({
      lanUrl: "http://192.168.1.5:14100",
      lanInterface: "wlp3s0",
    }).join("\n");
    expect(out).toContain("On your network");
    expect(out).toContain("http://192.168.1.5:14100");
    expect(out).toContain("(wlp3s0)");
    expect(out).not.toContain("0.0.0.0");
  });

  it("prints the token so the manual flow still works", () => {
    expect(render({}).join("\n")).toContain(TOKEN);
  });

  it("mentions scanning only when a QR is present", () => {
    expect(render({}).join("\n")).not.toContain("Scan the code");
    expect(
      render({ qrPayload: "http://192.168.1.5:14100/login#n=abc" }).join("\n"),
    ).toContain("Scan the code");
  });

  it("places the QR beside the text on a wide terminal", () => {
    const out = render({
      lanUrl: "http://192.168.1.5:14100",
      qrPayload: "http://192.168.1.5:14100/login#n=" + "a".repeat(32),
      columns: 120,
    });
    // The heading row carries QR blocks to its right rather than sitting alone.
    const heading = out.find((l) => l.includes("›  mtmux"))!;
    expect(heading).toMatch(/[█▀▄]/);
  });

  it("stacks the QR below the text when the terminal is narrow", () => {
    const out = render({
      lanUrl: "http://192.168.1.5:14100",
      qrPayload: "http://192.168.1.5:14100/login#n=" + "a".repeat(32),
      columns: 40,
    });
    const heading = out.find((l) => l.includes("›  mtmux"))!;
    expect(heading).not.toMatch(/[█▀▄]/);
    // …but the QR is still rendered, just further down.
    expect(out.some((l) => /[█▀▄]/.test(l))).toBe(true);
  });

  it("never lets a line exceed the terminal width", () => {
    const columns = 100;
    const out = render({
      lanUrl: "http://192.168.1.5:14100",
      lanInterface: "wlp3s0",
      qrPayload: "http://192.168.1.5:14100/login#n=" + "a".repeat(32),
      columns,
    });
    for (const line of out) {
      expect([...line].length).toBeLessThanOrEqual(columns);
    }
  });
});

describe("qrLines", () => {
  it("produces a square-ish block of QR rows with no blank lines", () => {
    const lines = qrLines("http://192.168.1.5:14100/login#n=" + "a".repeat(32));
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.every((l) => l.trim().length > 0)).toBe(true);
    const widths = new Set(lines.map((l) => [...l].length));
    expect(widths.size).toBe(1);
  });
});

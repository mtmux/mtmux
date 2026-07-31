import { describe, it, expect } from "vitest";
import kleur from "kleur";
import { formatLogLine } from "./logs.js";

// Colour off, so the assertions read as the text a user sees.
kleur.enabled = false;

const line = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    level: 30,
    time: Date.UTC(2026, 6, 31, 14, 5, 9),
    pid: 4242,
    hostname: "thinkpad",
    name: "relay:tmux",
    msg: "Session attached",
    ...over,
  });

describe("formatLogLine", () => {
  it("turns a pino record into something scannable", () => {
    expect(formatLogLine(line())).toBe(
      "14:05:09 info  relay:tmux Session attached",
    );
  });

  it("drops pid and hostname, which are the same on every line", () => {
    const out = formatLogLine(line());
    expect(out).not.toContain("4242");
    expect(out).not.toContain("thinkpad");
  });

  it("keeps the fields that carry the actual information", () => {
    const out = formatLogLine(line({ sessionId: "work", panes: 3 }));
    expect(out).toContain("sessionId=work");
    expect(out).toContain("panes=3");
  });

  it("names each level", () => {
    const levels: [number, string][] = [
      [10, "trace"],
      [20, "debug"],
      [30, "info"],
      [40, "warn"],
      [50, "error"],
      [60, "fatal"],
    ];
    for (const [level, label] of levels) {
      expect(formatLogLine(line({ level }))).toContain(label);
    }
  });

  it("passes anything that is not a log record straight through", () => {
    // A truncated last line mid-rotation, or a stray console.log from a
    // dependency. Both are still worth seeing and neither is worth crashing on.
    for (const raw of ["", "not json at all", '{"partial":', "{}"]) {
      expect(formatLogLine(raw)).toBe(raw);
    }
  });
});

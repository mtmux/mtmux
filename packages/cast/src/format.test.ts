import { describe, expect, it } from "vitest";

import {
  castDuration,
  encodeCast,
  encodeEvent,
  encodeSize,
  parseCast,
  parseSize,
  type Cast,
} from "./format.js";

const HEADER = { version: 2 as const, width: 80, height: 24 };

function cast(events: Cast["events"]): string {
  return encodeCast({ header: HEADER, events });
}

describe("encodeCast / parseCast", () => {
  it("round-trips a recording", () => {
    const events = [
      { time: 0, type: "o" as const, data: "hello\r\n" },
      { time: 1.25, type: "r" as const, data: "120x40" },
      { time: 2.5, type: "o" as const, data: "world" },
    ];
    const parsed = parseCast(cast(events));
    expect(parsed.header).toEqual(HEADER);
    expect(parsed.events).toEqual(events);
    expect(parsed.truncated).toBe(false);
  });

  it("survives escape sequences, tabs and CRs verbatim", () => {
    const data = "[2J[H\tcol\r\n[38;2;255;0;0mred[0m";
    const parsed = parseCast(cast([{ time: 0, type: "o", data }]));
    expect(parsed.events[0]!.data).toBe(data);
  });

  it("survives a lone surrogate", () => {
    // node-pty hands us a string, and a multi-byte character split across two
    // reads leaves one half of a surrogate pair in a chunk. JSON.stringify
    // escapes it; JSON.parse gives it back. If either ever stopped doing that,
    // every recording of a session printing emoji would corrupt.
    const data = "before\ud83d after";
    const parsed = parseCast(cast([{ time: 0, type: "o", data }]));
    expect(parsed.events[0]!.data).toBe(data);
  });

  it("rounds times to microseconds", () => {
    expect(encodeEvent({ time: 1.2345678, type: "o", data: "x" })).toBe(
      '[1.234568,"o","x"]',
    );
  });

  it("drops a torn final line and says so", () => {
    // The `kill -9` case. Everything before the tear must still be readable.
    const text = `${cast([{ time: 0, type: "o", data: "kept" }])}[1.0,"o","ha`;
    const parsed = parseCast(text);
    expect(parsed.events.map((e) => e.data)).toEqual(["kept"]);
    expect(parsed.truncated).toBe(true);
  });

  it("skips a malformed interior line without truncating", () => {
    const text = [
      JSON.stringify(HEADER),
      '[0,"o","a"]',
      "not json at all",
      '[1,"o","b"]',
      "",
    ].join("\n");
    const parsed = parseCast(text);
    expect(parsed.events.map((e) => e.data)).toEqual(["a", "b"]);
    expect(parsed.truncated).toBe(false);
  });

  it("ignores events with the wrong shape", () => {
    const text = [
      JSON.stringify(HEADER),
      '[0,"i","keystroke"]',
      '["nope","o","a"]',
      "{}",
      '[1,"o","b"]',
      "",
    ].join("\n");
    expect(parseCast(text).events.map((e) => e.data)).toEqual(["b"]);
  });

  it("throws on an empty file, a bad header, or the wrong version", () => {
    expect(() => parseCast("")).toThrow(/Empty recording/);
    expect(() => parseCast("nonsense\n")).toThrow(/not valid JSON/);
    expect(() => parseCast('{"version":1}\n')).toThrow(/Unsupported/);
  });

  it("keeps the timestamp in seconds", () => {
    // A milliseconds value here dates the recording to the year 56000, and
    // nothing in our own UI would notice.
    const parsed = parseCast(
      `${JSON.stringify({ ...HEADER, timestamp: 1717171717 })}\n`,
    );
    expect(parsed.header.timestamp).toBeLessThan(4_000_000_000);
  });
});

describe("size helpers", () => {
  it("round-trips", () => {
    expect(parseSize(encodeSize(120, 40))).toEqual({ cols: 120, rows: 40 });
  });

  it("returns null for anything else", () => {
    for (const bad of ["", "80", "80x", "ax24", "80 x 24", "-1x24"]) {
      expect(parseSize(bad)).toBeNull();
    }
  });
});

describe("castDuration", () => {
  it("is the last event's time, or zero when there are none", () => {
    expect(castDuration({ events: [] })).toBe(0);
    expect(
      castDuration({ events: [{ time: 4.5, type: "o", data: "x" }] }),
    ).toBe(4.5);
  });
});

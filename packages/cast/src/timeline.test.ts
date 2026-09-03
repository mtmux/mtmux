import { describe, expect, it } from "vitest";

import type { Cast, CastEvent } from "./format.js";
import {
  compileCast,
  indexAt,
  sizeAt,
  sliceBetween,
  sliceUpTo,
  squashIdle,
  textOf,
} from "./timeline.js";

const events: CastEvent[] = [
  { time: 0, type: "o", data: "a" },
  { time: 1, type: "o", data: "b" },
  { time: 1, type: "r", data: "120x40" },
  { time: 2.5, type: "o", data: "c" },
  { time: 9, type: "o", data: "d" },
];

const cast: Cast = {
  header: { version: 2, width: 80, height: 24 },
  events,
  truncated: false,
};

describe("indexAt", () => {
  it("is -1 before the first event", () => {
    expect(indexAt(cast, -1)).toBe(-1);
  });

  it("returns the last event at or before t", () => {
    expect(indexAt(cast, 0)).toBe(0);
    expect(indexAt(cast, 0.5)).toBe(0);
    // Ties resolve to the *last* event sharing the timestamp, so a seek to a
    // boundary replays everything stamped at it.
    expect(indexAt(cast, 1)).toBe(2);
    expect(indexAt(cast, 100)).toBe(events.length - 1);
  });
});

describe("sliceUpTo", () => {
  it("is everything at or before t", () => {
    expect(sliceUpTo(cast, 2.5).map((e) => e.data)).toEqual([
      "a",
      "b",
      "120x40",
      "c",
    ]);
    expect(sliceUpTo(cast, -1)).toEqual([]);
  });
});

describe("sliceBetween", () => {
  it("is half-open at the start and closed at the end", () => {
    expect(sliceBetween(cast, 0, 1).map((e) => e.data)).toEqual([
      "b",
      "120x40",
    ]);
    expect(sliceBetween(cast, 1, 2.5).map((e) => e.data)).toEqual(["c"]);
  });

  it("is empty when the span is empty or inverted", () => {
    expect(sliceBetween(cast, 2, 2)).toEqual([]);
    expect(sliceBetween(cast, 5, 1)).toEqual([]);
  });

  it("tiles the timeline with no gap and no overlap", () => {
    // The property that matters: stepping frame by frame must emit every event
    // exactly once, and a scrubber must never land in a hole. Asserted the way
    // `apps/site/src/lib/demo/player.test.ts` asserts it for chapter spans.
    const duration = 9;
    const step = 0.37;
    const seen: CastEvent[] = [];
    let from = -Infinity;
    for (let t = 0; t <= duration + step; t += step) {
      seen.push(...sliceBetween(cast, from, Math.min(t, duration)));
      from = Math.min(t, duration);
    }
    expect(seen).toEqual(events);
  });

  it("agrees with sliceUpTo at every boundary", () => {
    for (const t of [-1, 0, 0.5, 1, 2.5, 8.9, 9, 20]) {
      expect(sliceBetween(cast, -Infinity, t)).toEqual(sliceUpTo(cast, t));
    }
  });
});

describe("compileCast", () => {
  it("counts only output bytes", () => {
    const compiled = compileCast(cast);
    expect(compiled.totalBytes).toBe(4);
    expect(compiled.duration).toBe(9);
    expect(compiled.cumulativeBytes).toEqual([0, 1, 2, 2, 3]);
  });
});

describe("sizeAt", () => {
  it("starts at the header size and follows resize events", () => {
    expect(sizeAt(cast, 0)).toEqual({ cols: 80, rows: 24 });
    expect(sizeAt(cast, 1)).toEqual({ cols: 120, rows: 40 });
    expect(sizeAt(cast, 100)).toEqual({ cols: 120, rows: 40 });
  });
});

describe("squashIdle", () => {
  it("compresses gaps past the limit and leaves shorter ones alone", () => {
    const squashed = squashIdle(events, 2);
    expect(squashed.map((e) => e.time)).toEqual([0, 1, 1, 2.5, 4.5]);
  });

  it("is a no-op for a non-positive limit", () => {
    expect(squashIdle(events, 0)).toEqual(events);
  });

  it("never reorders or drops events", () => {
    const squashed = squashIdle(events, 0.5);
    expect(squashed.map((e) => e.data)).toEqual(events.map((e) => e.data));
    for (let i = 1; i < squashed.length; i += 1) {
      expect(squashed[i]!.time).toBeGreaterThanOrEqual(squashed[i - 1]!.time);
    }
  });

  it("does not mutate its input", () => {
    const copy = events.map((e) => ({ ...e }));
    squashIdle(events, 1);
    expect(events).toEqual(copy);
  });
});

describe("textOf", () => {
  it("concatenates output and skips resizes", () => {
    expect(textOf(events)).toBe("abcd");
  });
});

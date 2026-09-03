import { describe, expect, it } from "vitest";

import {
  formatTimecode,
  initialPlayerState,
  nextSpeed,
  playerReducer,
  type PlayerAction,
  type PlayerState,
} from "./player-clock";

function run(state: PlayerState, ...actions: PlayerAction[]): PlayerState {
  return actions.reduce(playerReducer, state);
}

const loaded = () => run(initialPlayerState(), { type: "load", duration: 10 });

describe("playerReducer", () => {
  it("starts paused at zero", () => {
    const state = loaded();
    expect(state).toMatchObject({
      t: 0,
      playing: false,
      speed: 1,
      duration: 10,
    });
  });

  it("advances by wall-clock time scaled by speed", () => {
    const state = run(
      loaded(),
      { type: "play" },
      { type: "advance", deltaMs: 1000 },
    );
    expect(state.t).toBe(1);

    const fast = run(
      loaded(),
      { type: "speed", speed: 2 },
      { type: "play" },
      { type: "advance", deltaMs: 1000 },
    );
    expect(fast.t).toBe(2);
  });

  it("does not advance while paused", () => {
    const state = run(loaded(), { type: "advance", deltaMs: 5000 });
    expect(state.t).toBe(0);
  });

  it("stops at the end rather than looping", () => {
    // A recording that silently restarted would look like one that never ended.
    const state = run(
      loaded(),
      { type: "play" },
      { type: "advance", deltaMs: 60_000 },
    );
    expect(state.t).toBe(10);
    expect(state.playing).toBe(false);
  });

  it("restarts when play is pressed at the end", () => {
    const ended = run(
      loaded(),
      { type: "play" },
      { type: "advance", deltaMs: 60_000 },
    );
    const restarted = playerReducer(ended, { type: "play" });
    expect(restarted).toMatchObject({ t: 0, playing: true, needsRedraw: true });
  });

  it("flags a backward seek as needing a redraw and a forward one as not", () => {
    // A terminal's state is a fold over every byte before it, so backwards
    // means reset-and-replay. Forwards is an append, which is cheap.
    const at5 = run(loaded(), { type: "seek", t: 5 });
    expect(at5.needsRedraw).toBe(false);

    const back = playerReducer(at5, { type: "seek", t: 2 });
    expect(back).toMatchObject({ t: 2, previousT: 5, needsRedraw: true });

    const forward = playerReducer(at5, { type: "seek", t: 8 });
    expect(forward).toMatchObject({ t: 8, previousT: 5, needsRedraw: false });
  });

  it("makes a seek to where it already is free", () => {
    // A held finger on a scrubber emits a stream of these. Each one costing a
    // full replay is the difference between a smooth scrub and a locked tab.
    const at5 = run(loaded(), { type: "seek", t: 5 });
    const again = playerReducer(at5, { type: "seek", t: 5 });
    expect(again.needsRedraw).toBe(false);
  });

  it("is idempotent for a repeated backward seek to the same point", () => {
    const at2 = run(loaded(), { type: "seek", t: 5 }, { type: "seek", t: 2 });
    const twice = playerReducer(at2, { type: "seek", t: 2 });
    expect(twice.t).toBe(2);
    expect(twice.needsRedraw).toBe(false);
  });

  it("clamps a seek to the recording", () => {
    expect(run(loaded(), { type: "seek", t: -5 }).t).toBe(0);
    expect(run(loaded(), { type: "seek", t: 99 }).t).toBe(10);
    expect(run(loaded(), { type: "seek", t: NaN }).t).toBe(0);
  });

  it("toggles", () => {
    const playing = playerReducer(loaded(), { type: "toggle" });
    expect(playing.playing).toBe(true);
    expect(playerReducer(playing, { type: "toggle" }).playing).toBe(false);
  });

  it("ignores a non-positive speed", () => {
    expect(run(loaded(), { type: "speed", speed: 0 }).speed).toBe(1);
    expect(run(loaded(), { type: "speed", speed: -2 }).speed).toBe(1);
  });

  it("resets everything on load", () => {
    const dirty = run(
      loaded(),
      { type: "play" },
      { type: "advance", deltaMs: 3000 },
      { type: "speed", speed: 4 },
    );
    expect(playerReducer(dirty, { type: "load", duration: 42 })).toMatchObject({
      t: 0,
      playing: false,
      speed: 1,
      duration: 42,
    });
  });
});

describe("nextSpeed", () => {
  it("cycles and wraps", () => {
    expect([0.5, 1, 2, 4].map(nextSpeed)).toEqual([1, 2, 4, 0.5]);
  });

  it("falls back to the first speed for anything off the list", () => {
    expect(nextSpeed(3)).toBe(0.5);
  });
});

describe("formatTimecode", () => {
  it("is m:ss under an hour and h:mm:ss past one", () => {
    expect(formatTimecode(0)).toBe("0:00");
    expect(formatTimecode(9.9)).toBe("0:09");
    expect(formatTimecode(75)).toBe("1:15");
    expect(formatTimecode(3661)).toBe("1:01:01");
  });

  it("never renders a negative", () => {
    expect(formatTimecode(-5)).toBe("0:00");
  });
});

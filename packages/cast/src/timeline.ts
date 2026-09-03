import {
  castDuration,
  parseSize,
  type Cast,
  type CastEvent,
} from "./format.js";

/**
 * Playback maths, kept pure.
 *
 * The player component owns a `requestAnimationFrame` loop and an xterm
 * instance; neither is testable without a browser. Everything that decides
 * *what* to draw lives here instead — the same split `apps/site/src/lib/demo`
 * already uses for the marketing replay, and for the same reason: the risk
 * surface is "does seeking to 7.5s produce the right bytes", which is a
 * question about arrays.
 *
 * ## Why there is no keyframe index
 *
 * A terminal's state is a fold over every byte that came before it. xterm.js
 * exposes no way to snapshot or restore that fold, so seeking to `t` means
 * `reset()` and replaying the whole prefix — cost linear in bytes, with no
 * shortcut available at any price. That is not a limitation of this module; it
 * is the reason `MAX_RECORDING_BYTES` in the relay is 16 MiB rather than
 * unbounded.
 */

export type CompiledCast = {
  cast: Cast;
  /** Seconds. */
  duration: number;
  /** Byte offset of each event's data within the concatenated output stream. */
  cumulativeBytes: number[];
  /** Total output bytes, for the progress readout and the size cap. */
  totalBytes: number;
};

export function compileCast(cast: Cast): CompiledCast {
  const cumulativeBytes: number[] = [];
  let total = 0;
  for (const event of cast.events) {
    cumulativeBytes.push(total);
    if (event.type === "o") total += event.data.length;
  }
  return {
    cast,
    duration: castDuration(cast),
    cumulativeBytes,
    totalBytes: total,
  };
}

/**
 * The index of the last event at or before `t`, or `-1` before the first.
 *
 * Binary search, because a scrubber calls this on every pointer move and a
 * four-hour recording can hold hundreds of thousands of events.
 */
export function indexAt(cast: Pick<Cast, "events">, t: number): number {
  const events = cast.events;
  let low = 0;
  let high = events.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (events[mid]!.time <= t) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** Every event with `time <= t`. What a seek replays. */
export function sliceUpTo(cast: Pick<Cast, "events">, t: number): CastEvent[] {
  return cast.events.slice(0, indexAt(cast, t) + 1);
}

/**
 * Events in `(from, to]` — half-open at the start, closed at the end.
 *
 * The asymmetry is what makes consecutive slices tile the timeline exactly: a
 * frame boundary belongs to the slice that ends on it and to no other, so
 * advancing frame by frame emits every event exactly once, and a scrubber can
 * never land in a gap. `timeline.test.ts` asserts that as a property, the same
 * way `apps/site/src/lib/demo/player.test.ts` asserts it for chapter spans.
 */
export function sliceBetween(
  cast: Pick<Cast, "events">,
  from: number,
  to: number,
): CastEvent[] {
  if (to <= from) return [];
  return cast.events.slice(indexAt(cast, from) + 1, indexAt(cast, to) + 1);
}

/** The terminal size in force at time `t`, given the header's starting size. */
export function sizeAt(cast: Cast, t: number): { cols: number; rows: number } {
  let size = { cols: cast.header.width, rows: cast.header.height };
  for (const event of cast.events) {
    if (event.time > t) break;
    if (event.type !== "r") continue;
    const parsed = parseSize(event.data);
    if (parsed) size = parsed;
  }
  return size;
}

/**
 * Compress gaps longer than `limit` seconds down to `limit`.
 *
 * A recording of a long agent run is mostly nothing happening. Playing that
 * back in real time is not a feature. Returns a new event list with rewritten
 * timestamps; the original is untouched, because the player offers this as a
 * toggle and has to be able to go back.
 */
export function squashIdle(
  events: readonly CastEvent[],
  limit: number,
): CastEvent[] {
  if (limit <= 0) return [...events];

  const out: CastEvent[] = [];
  let previousSource = 0;
  let shift = 0;

  for (const event of events) {
    const gap = event.time - previousSource;
    if (gap > limit) shift += gap - limit;
    previousSource = event.time;
    out.push({ ...event, time: event.time - shift });
  }
  return out;
}

/** Concatenate the output bytes of a run of events. */
export function textOf(events: readonly CastEvent[]): string {
  let out = "";
  for (const event of events) if (event.type === "o") out += event.data;
  return out;
}

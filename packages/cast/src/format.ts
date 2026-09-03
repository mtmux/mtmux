/**
 * asciinema v2 (`.cast`) encoding and parsing.
 *
 * The format was chosen rather than invented. A recording is a file the user
 * owns and may well want to open in something that is not us — `asciinema
 * play`, `agg`, `asciinema-player`, a gist — and a bespoke container would
 * have made "share a recording" mean "share a recording that only mtmux can
 * read". It is also, conveniently, the simplest thing that could work: a JSON
 * header line, then one JSON array per event.
 *
 * ```
 * {"version":2,"width":80,"height":24,"timestamp":1717171717,"title":"work"}
 * [0.123456,"o","hello\r\n"]
 * [1.500000,"r","120x40"]
 * ```
 *
 * Everything here is pure and dependency-free, because both ends need it: the
 * relay writes casts through `./writer.js`, and the browser player parses them.
 * `node:fs` appears in this package exactly once, in `writer.ts`, which is why
 * that is a separate export path.
 */

/** The event kinds we emit. asciinema also defines `"i"` (input); we never record keystrokes. */
export type CastEventType = "o" | "r";

export type CastEvent = {
  /** Seconds since the recording started, to microsecond precision. */
  time: number;
  type: CastEventType;
  /** Terminal output for `"o"`; `"COLSxROWS"` for `"r"`. */
  data: string;
};

export type CastHeader = {
  version: 2;
  width: number;
  height: number;
  /**
   * UNIX time in **seconds**, not milliseconds.
   *
   * asciinema's own tooling reads this as seconds, and a millisecond value
   * here renders as a date in the year 56000 — wrong in a way no test of ours
   * would notice, because we only ever display it as "when was this".
   */
  timestamp?: number;
  /** Seconds of dead air after which a player should skip ahead. */
  idle_time_limit?: number;
  title?: string;
  /**
   * `{ TERM }` only.
   *
   * asciinema conventionally records `SHELL` here too. We do not: this is a
   * file whose entire purpose is being handed to somebody else, and which
   * shell the recorder uses is a detail of the machine, not of the recording.
   */
  env?: { TERM?: string };
};

export type Cast = {
  header: CastHeader;
  events: CastEvent[];
  /**
   * True when the last line of the file was not a complete JSON value.
   *
   * A cast is an append-only log, so `kill -9` halfway through a write is a
   * normal way for one to end. Refusing to open the file over a torn final
   * line would throw away everything before it, which is the opposite of what
   * the reader wants.
   */
  truncated: boolean;
};

/** Six decimal places: microseconds, which is finer than any terminal event. */
const TIME_PRECISION = 6;

export function formatTime(seconds: number): number {
  return Number(seconds.toFixed(TIME_PRECISION));
}

export function encodeHeader(header: CastHeader): string {
  return JSON.stringify(header);
}

export function encodeEvent(event: CastEvent): string {
  return JSON.stringify([formatTime(event.time), event.type, event.data]);
}

/** A whole cast as a string, newline-terminated. */
export function encodeCast(cast: Pick<Cast, "header" | "events">): string {
  return [encodeHeader(cast.header), ...cast.events.map(encodeEvent), ""].join(
    "\n",
  );
}

function isCastEventType(value: unknown): value is CastEventType {
  return value === "o" || value === "r";
}

/**
 * Parse one `.cast` file.
 *
 * Tolerant on purpose. A malformed *interior* line is skipped rather than
 * fatal, and a malformed final line sets `truncated`. The only thing that
 * throws is a header that is not a version-2 asciinema header, because at that
 * point there is nothing to be tolerant about.
 */
export function parseCast(text: string): Cast {
  const lines = text.split("\n");
  const headerLine = lines.shift();
  if (headerLine === undefined || headerLine.trim() === "") {
    throw new Error("Empty recording: no header line.");
  }

  let header: CastHeader;
  try {
    header = JSON.parse(headerLine) as CastHeader;
  } catch {
    throw new Error("Recording header is not valid JSON.");
  }
  if (header?.version !== 2) {
    throw new Error(
      `Unsupported recording version: ${String(header?.version)} (expected 2).`,
    );
  }

  const events: CastEvent[] = [];
  let truncated = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A torn line can only be the last one with content; anything earlier is
      // corruption we skip rather than surface.
      if (i === lines.length - 1) truncated = true;
      continue;
    }

    if (
      !Array.isArray(parsed) ||
      parsed.length < 3 ||
      typeof parsed[0] !== "number" ||
      !isCastEventType(parsed[1]) ||
      typeof parsed[2] !== "string"
    ) {
      continue;
    }

    events.push({ time: parsed[0], type: parsed[1], data: parsed[2] });
  }

  return { header, events, truncated };
}

/** Wall-clock length of a cast, in seconds. */
export function castDuration(cast: Pick<Cast, "events">): number {
  const last = cast.events[cast.events.length - 1];
  return last ? last.time : 0;
}

/** The `"COLSxROWS"` string a resize event carries. */
export function encodeSize(cols: number, rows: number): string {
  return `${cols}x${rows}`;
}

/** The inverse, returning null for anything that is not `COLSxROWS`. */
export function parseSize(data: string): { cols: number; rows: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(data);
  if (!match) return null;
  return { cols: Number(match[1]), rows: Number(match[2]) };
}

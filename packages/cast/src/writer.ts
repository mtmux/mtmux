import { createWriteStream, type WriteStream } from "node:fs";
import { once } from "node:events";

import {
  encodeEvent,
  encodeHeader,
  encodeSize,
  formatTime,
  type CastEvent,
  type CastHeader,
} from "./format.js";

/**
 * The node-only half of `@repo/cast`.
 *
 * Reached as `@repo/cast/writer`, never through the package root, so the
 * browser player can import `@repo/cast` without dragging `node:fs` into a
 * bundle. That is the whole reason this package has two export entry points.
 */

export type CastWriterOptions = {
  path: string;
  cols: number;
  rows: number;
  title?: string;
  term?: string;
  idleTimeLimit?: number;
  /** Stop cleanly once this many bytes have been written. */
  maxBytes?: number;
  /** Stop cleanly once the recording has run this long, in milliseconds. */
  maxMs?: number;
  /** Injected for tests. Defaults to a monotonic clock. */
  now?: () => number;
};

export type StopReason = "requested" | "limit" | "error";

export type CastWriter = {
  /** Append terminal output. No-op once stopped. */
  write(data: string): void;
  /** Append a resize event. No-op once stopped, or if the size is unchanged. */
  resize(cols: number, rows: number): void;
  /** Flush and close. Idempotent. Resolves once the file is on disk. */
  stop(reason?: StopReason): Promise<StopReason>;
  readonly bytes: number;
  readonly events: number;
  readonly stopped: boolean;
  /** Why it stopped, or null while it is still running. */
  readonly stopReason: StopReason | null;
};

/** Milliseconds since some arbitrary origin, immune to a wall-clock step. */
function monotonicNow(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/**
 * Open a `.cast` for writing.
 *
 * `flags: "wx"` — exclusive create, never append. A recording id collision
 * must fail loudly rather than interleave two sessions into one file, and
 * `"a"` would do exactly that. `mode: 0o600` because a cast contains every
 * byte that was on screen, which routinely includes secrets: an API key echoed
 * by a misconfigured tool, a token in a curl command, the contents of a
 * `.env`. There is no encoding trick that fixes that. The file is the user's
 * and the permissions say so.
 */
export async function createCastWriter(
  options: CastWriterOptions,
): Promise<CastWriter> {
  const now = options.now ?? monotonicNow;
  const startedAt = now();

  const header: CastHeader = {
    version: 2,
    width: options.cols,
    height: options.rows,
    timestamp: Math.floor(Date.now() / 1000),
    ...(options.idleTimeLimit
      ? { idle_time_limit: options.idleTimeLimit }
      : {}),
    ...(options.title ? { title: options.title } : {}),
    ...(options.term ? { env: { TERM: options.term } } : {}),
  };

  const stream: WriteStream = createWriteStream(options.path, {
    flags: "wx",
    mode: 0o600,
  });
  // `wx` fails asynchronously. Waiting for `open` here turns a collision into
  // a rejected promise the caller can report, rather than an 'error' event
  // arriving after the recording has been announced as started.
  await once(stream, "open");

  let bytes = 0;
  let events = 0;
  let stopped = false;
  let stopReason: StopReason | null = null;
  let cols = options.cols;
  let rows = options.rows;
  let closing: Promise<StopReason> | null = null;

  const headerLine = `${encodeHeader(header)}\n`;
  stream.write(headerLine);

  function elapsed(): number {
    return formatTime((now() - startedAt) / 1000);
  }

  function append(event: CastEvent): void {
    const line = `${encodeEvent(event)}\n`;
    stream.write(line);
    bytes += Buffer.byteLength(line);
    events += 1;
  }

  function overLimit(): boolean {
    if (options.maxBytes !== undefined && bytes >= options.maxBytes)
      return true;
    if (options.maxMs !== undefined && now() - startedAt >= options.maxMs) {
      return true;
    }
    return false;
  }

  const writer: CastWriter = {
    write(data: string): void {
      if (stopped || data === "") return;
      append({ time: elapsed(), type: "o", data });
      // Checked *after* the append, so the recording always contains the chunk
      // that crossed the line rather than stopping just short of it. A cast
      // that stops mid-thought reads as corruption; one that stops a chunk
      // late reads as a limit, which is what it is.
      if (overLimit()) void writer.stop("limit");
    },

    resize(nextCols: number, nextRows: number): void {
      if (stopped) return;
      if (nextCols === cols && nextRows === rows) return;
      cols = nextCols;
      rows = nextRows;
      append({ time: elapsed(), type: "r", data: encodeSize(cols, rows) });
      if (overLimit()) void writer.stop("limit");
    },

    stop(reason: StopReason = "requested"): Promise<StopReason> {
      if (closing) return closing;
      stopped = true;
      stopReason = reason;
      closing = new Promise<StopReason>((resolve) => {
        stream.end(() => resolve(reason));
      });
      return closing;
    },

    get bytes() {
      return bytes;
    },
    get events() {
      return events;
    },
    get stopped() {
      return stopped;
    },
    get stopReason() {
      return stopReason;
    },
  };

  return writer;
}

import { execFile } from "node:child_process";
import { createReadStream, type ReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { promisify } from "node:util";

import { createCastWriter, type CastWriter } from "@repo/cast/writer";
import { createLogger } from "@repo/logger";
import type {
  RecordingInfo,
  RecordingStopReason,
  RecordingTarget,
} from "@repo/protocol";

import { config } from "./config.js";
import { createPtyBridge, type PtyBridge } from "./pty-bridge.js";
import * as index from "./recordings-index.js";
import { createRecordingClone, destroyClone } from "./tmux-clone.js";
import * as tmux from "./tmux-manager.js";

const execFileAsync = promisify(execFile);
const logger = createLogger("relay:recorder");

/**
 * Capture a tmux session or pane to a `.cast` on this machine's disk.
 *
 * ## The recorder owns its own pty
 *
 * The obvious implementation is a second `bridge.onData(...)` on the viewer's
 * existing bridge. It is one line, and it is wrong three ways. That bridge is
 * created inside `case "session:attach"` and killed when the browser detaches,
 * so recording would stop the moment a phone locked. Websocket backpressure
 * calls `bridge.pause()`, which pauses the **pty**, so the recorder would stall
 * whenever the viewer's connection did and then be silently truncated by
 * `bridge.kill()`. And `pty-bridge.ts` has no `offData`, so every recording
 * would leave a callback behind forever.
 *
 * So a recording gets its own pty attached to its own locked grouped clone —
 * the same cost read-only sharing already pays, and the same lockdown.
 *
 * ## What is *not* recorded
 *
 * Keystrokes. asciinema defines an `"i"` event for input and we never write
 * one. A recording is what was on the screen, which is bad enough: it contains
 * every secret anything printed. `0600`, and the share banner says so.
 */

/**
 * 16 MiB per recording.
 *
 * Sized by the cost of scrubbing, not by disk. A terminal's state is a fold
 * over every byte before it and xterm.js cannot be snapshotted, so seeking to
 * `t` means `reset()` plus a replay of the whole prefix — linear in bytes, with
 * no keyframe shortcut available at any price. 16 MiB is roughly where a seek
 * stops feeling instant on a phone. A safety limit like `MAX_LOG_BYTES`, not a
 * plan limit: see `recordings-index.ts` for why nothing here is metered.
 */
export const MAX_RECORDING_BYTES = 16 * 1024 * 1024;

/** Four hours. Long enough for the agent run this exists for; not open-ended. */
export const MAX_RECORDING_MS = 4 * 60 * 60 * 1000;

/** Gaps longer than this are a hint to a player, not a truncation. */
export const IDLE_TIME_LIMIT_SECONDS = 2;

/** How often the session's real dimensions are re-read. */
const RESIZE_POLL_MS = 5000;

export class RecordingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RecordingError";
  }
}

type ActiveRecording = {
  info: RecordingInfo;
  writer: CastWriter;
  /** Null for a pane recording, which uses `pipe-pane` rather than a pty. */
  bridge: PtyBridge | null;
  /** Null for a session recording. */
  paneId: string | null;
  /** The FIFO `pipe-pane` writes into, for a pane recording. */
  fifoPath: string | null;
  fifo: ReadStream | null;
  cloneName: string | null;
  poll: ReturnType<typeof setInterval> | null;
};

const active = new Map<string, ActiveRecording>();

function tmuxArgs(): string[] {
  return config.tmuxSocket ? ["-S", config.tmuxSocket] : [];
}

/**
 * The paths `pipe-pane` is allowed to see.
 *
 * `pipe-pane` hands its argument to `/bin/sh -c`, so this is the one place in
 * the relay where a string becomes a shell command. Every path we pass is built
 * by `recordingFilename` from a timestamp, a sanitised slug and 16 bytes of
 * `randomBytes` — no caller input reaches it — and it is single-quoted at the
 * call site. This assertion is the belt to that braces: if a path ever contains
 * anything outside this set, the recording fails rather than the shell
 * interpreting it.
 */
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

export function assertShellSafePath(path: string): void {
  if (!SAFE_PATH.test(path)) {
    throw new RecordingError(
      "UNSAFE_PATH",
      "Refusing to build a shell command from this path.",
    );
  }
}

/** The session's current size, so a recorder never resizes what it records. */
async function sessionSize(
  session: string,
): Promise<{ cols: number; rows: number }> {
  try {
    const windows = await tmux.listWindows(session);
    const dimensions = windows.find((w) => w.active)?.dimensions;
    if (dimensions) return { cols: dimensions.cols, rows: dimensions.rows };
    const first = windows[0]?.dimensions;
    if (first) return { cols: first.cols, rows: first.rows };
  } catch (err) {
    logger.warn({ err, session }, "Could not read session size");
  }
  return { cols: 80, rows: 24 };
}

/** True when a pane already has a `pipe-pane` running. */
async function paneIsPiped(paneId: string): Promise<boolean> {
  const { stdout } = await execFileAsync("tmux", [
    ...tmuxArgs(),
    "display-message",
    "-p",
    "-t",
    paneId,
    "#{pane_pipe}",
  ]);
  return stdout.trim() === "1";
}

export function listActive(): RecordingInfo[] {
  return [...active.values()].map((r) => r.info);
}

export function isRecording(id: string): boolean {
  return active.has(id);
}

/** Is this session or pane already being recorded? */
export function activeFor(target: RecordingTarget): RecordingInfo | null {
  for (const recording of active.values()) {
    const t = recording.info.target;
    if (t.kind !== target.kind) continue;
    if (t.kind === "session" && t.session === target.session) {
      return recording.info;
    }
    if (
      t.kind === "pane" &&
      target.kind === "pane" &&
      t.paneId === target.paneId
    ) {
      return recording.info;
    }
  }
  return null;
}

export async function start(options: {
  target: RecordingTarget;
  title?: string;
  maxBytes?: number;
  maxMs?: number;
}): Promise<RecordingInfo> {
  const { target } = options;
  const existing = activeFor(target);
  if (existing) {
    throw new RecordingError(
      "ALREADY_RECORDING",
      "That is already being recorded.",
    );
  }

  if (!(await tmux.sessionExists(target.session))) {
    throw new RecordingError(
      "SESSION_NOT_FOUND",
      `Session "${target.session}" not found`,
    );
  }

  const id = index.newRecordingId();
  const title = options.title?.trim() || target.session;
  const filename = index.recordingFilename(id, target.session);
  const path = index.recordingPath(filename);
  const { cols, rows } = await sessionSize(target.session);

  await index.ensureDir();
  const writer = await createCastWriter({
    path,
    cols,
    rows,
    title,
    term: "xterm-256color",
    idleTimeLimit: IDLE_TIME_LIMIT_SECONDS,
    maxBytes: options.maxBytes ?? MAX_RECORDING_BYTES,
    maxMs: options.maxMs ?? MAX_RECORDING_MS,
  });

  const info = index.startedRecording({
    id,
    filename,
    target,
    title,
    cols,
    rows,
  });

  const recording: ActiveRecording = {
    info,
    writer,
    bridge: null,
    paneId: target.kind === "pane" ? target.paneId : null,
    fifoPath: null,
    fifo: null,
    cloneName: null,
    poll: null,
  };
  active.set(id, recording);

  try {
    if (target.kind === "session") {
      await startSessionCapture(recording, target.session, cols, rows);
    } else {
      await startPaneCapture(recording, target.paneId, filename);
    }
  } catch (err) {
    active.delete(id);
    await writer.stop("error");
    await index.remove(id).catch(() => {});
    throw err;
  }

  await index.put(info);

  // Dimensions come from the session monitor's view of tmux, never from a
  // viewer's `terminal:resize`. Recording a viewer's geometry would make the
  // cast's dimensions jump every time somebody rotated a phone.
  recording.poll = setInterval(() => {
    void (async () => {
      const size = await sessionSize(target.session);
      recording.writer.resize(size.cols, size.rows);
      if (recording.writer.stopped) await stop(id, "limit");
    })();
  }, RESIZE_POLL_MS);
  recording.poll.unref?.();

  logger.info({ id, target: target.kind }, "Recording started");
  return info;
}

/**
 * Session capture: a pty on a locked grouped clone.
 *
 * No `capture-pane` seed here, deliberately — and note that pane capture below
 * does the exact opposite. Attaching a tmux client forces a full redraw, so the
 * first chunk this pty sees already carries the whole screen with the right
 * cursor position, SGR state and alternate-screen flag. A reconstruction would
 * be strictly worse *and* would double-paint frame zero. (`message-router.ts`
 * calls `capture-pane` on attach because a **websocket** attach has no redraw
 * to piggyback on. A pty attach does.)
 */
async function startSessionCapture(
  recording: ActiveRecording,
  session: string,
  cols: number,
  rows: number,
): Promise<void> {
  const cloneName = await createRecordingClone(session, recording.info.id);
  recording.cloneName = cloneName;

  const bridge = createPtyBridge(cloneName, { cols, rows }, { readOnly: true });
  if (bridge.spawnError) {
    await destroyClone(cloneName);
    throw new RecordingError(
      "RECORDER_FAILED",
      bridge.spawnError.message || "Could not attach a recorder.",
    );
  }
  recording.bridge = bridge;

  bridge.onData((data) => {
    recording.writer.write(data);
    if (recording.writer.stopped) void stop(recording.info.id, "limit");
  });
  bridge.onExit(() => {
    void stop(recording.info.id, "ended");
  });
}

/**
 * Pane capture: `pipe-pane` into a FIFO, and an explicit first frame.
 *
 * ## Why a FIFO and not `cat >> the.cast`
 *
 * The obvious `pipe-pane -o -t %7 'cat >> recording.cast'` appends the pane's
 * **raw bytes** to the file. A `.cast` is one JSON header line followed by one
 * JSON array per event, so that produces a file whose first two lines are valid
 * and whose remainder is escape sequences — it parses as a recording with no
 * events, which is worse than failing. Every byte has to go through
 * `CastWriter` to be timestamped and encoded, which means the recorder has to
 * *read* the stream rather than let the shell write it.
 *
 * So `pipe-pane` writes into a named pipe we own and we read the other end.
 * That also gets the timing right: the timestamp on each event is when we read
 * the chunk, from the same monotonic clock the session path uses.
 *
 * The FIFO is opened `r+` rather than `r` deliberately. Opening a FIFO
 * read-only blocks until a writer appears, and the writer here is a `cat` that
 * `pipe-pane` has not spawned yet — the two would deadlock. `r+` opens both
 * ends at once, which also means the read stream never sees EOF when `cat`
 * exits, so teardown is ours to do rather than something to wait for.
 *
 * ## The first frame
 *
 * The inverse of the session case, and the asymmetry is the point. `pipe-pane`
 * starts mid-stream — it copies what the pane writes from now on and knows
 * nothing about what is already on screen — so a recording of a pane that has
 * been sitting at a prompt for an hour would open on a blank terminal. Here a
 * `capture-pane` seed is exactly right: clear, home, then the pane's current
 * contents, written as the event at t=0.
 */
async function startPaneCapture(
  recording: ActiveRecording,
  paneId: string,
  filename: string,
): Promise<void> {
  if (await paneIsPiped(paneId)) {
    // Starting a second pipe on a pane silently replaces the first. Somebody
    // running their own `pipe-pane` should not lose it to a UI button.
    throw new RecordingError(
      "PANE_ALREADY_PIPED",
      "That pane already has a pipe running.",
    );
  }

  const fifoPath = index.recordingPath(`${filename}.pipe`);
  assertShellSafePath(fifoPath);
  try {
    await execFileAsync("mkfifo", ["-m", "600", fifoPath]);
  } catch (err) {
    // POSIX requires `mkfifo`, so this is a stripped container rather than a
    // normal machine — but an ENOENT surfacing as "spawn mkfifo ENOENT" tells
    // the user nothing about which half of the feature is unavailable.
    throw new RecordingError(
      "MKFIFO_UNAVAILABLE",
      `Could not create the pipe this needs (${(err as Error).message}). ` +
        "Recording a whole session does not use one.",
    );
  }
  recording.fifoPath = fifoPath;

  const screen = await tmux.capturePaneById(paneId).catch(() => "");
  recording.writer.write(`\x1b[H\x1b[2J${screen}`);

  // `r+`, not `r`: see the docblock. Reading as UTF-8 matches node-pty, which
  // hands the session path a string.
  const fifo = createReadStream(fifoPath, {
    flags: "r+",
    encoding: "utf8",
  });
  recording.fifo = fifo;
  fifo.on("data", (chunk) => {
    recording.writer.write(String(chunk));
    if (recording.writer.stopped) void stop(recording.info.id, "limit");
  });
  fifo.on("error", () => {
    void stop(recording.info.id, "error");
  });

  try {
    await execFileAsync("tmux", [
      ...tmuxArgs(),
      "pipe-pane",
      "-o",
      "-t",
      paneId,
      // Single-quoted, and the path is asserted above against a charset with no
      // quote in it, so there is nothing here for `/bin/sh -c` to reinterpret.
      `cat >> '${fifoPath}'`,
    ]);
  } catch (err) {
    fifo.destroy();
    await unlink(fifoPath).catch(() => {});
    throw err;
  }
}

export async function stop(
  id: string,
  reason: RecordingStopReason = "requested",
): Promise<RecordingInfo | null> {
  const recording = active.get(id);
  if (!recording) return index.get(id);
  active.delete(id);

  if (recording.poll) clearInterval(recording.poll);

  if (recording.paneId) {
    try {
      await execFileAsync("tmux", [
        ...tmuxArgs(),
        "pipe-pane",
        "-t",
        recording.paneId,
      ]);
    } catch (err) {
      logger.warn({ err, id }, "Could not stop pipe-pane");
    }
  }

  if (recording.fifo) recording.fifo.destroy();
  if (recording.fifoPath) {
    await unlink(recording.fifoPath).catch(() => {});
  }

  if (recording.bridge) {
    recording.bridge.markDetaching();
    recording.bridge.kill();
  }
  if (recording.cloneName) await destroyClone(recording.cloneName);

  // The writer may already have closed itself on a limit; `stop` keeps the
  // first reason, so a limit stop is never relabelled as "requested".
  const stopReason = recording.writer.stopped
    ? (recording.writer.stopReason ?? reason)
    : reason;
  await recording.writer.stop(stopReason === "limit" ? "limit" : "requested");

  const updated = await index.patch(id, {
    endedAt: Date.now(),
    bytes: recording.writer.bytes,
    events: recording.writer.events,
    stopReason: stopReason as RecordingStopReason,
  });

  logger.info({ id, reason: stopReason }, "Recording stopped");
  return updated;
}

/** Stop everything. Called on relay shutdown so nothing is left half-written. */
export async function stopAll(
  reason: RecordingStopReason = "ended",
): Promise<void> {
  await Promise.all([...active.keys()].map((id) => stop(id, reason)));
}

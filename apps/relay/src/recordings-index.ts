import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createLogger } from "@repo/logger";
import type { RecordingInfo, RecordingTarget } from "@repo/protocol";
import { RecordingFile } from "@repo/protocol";

const logger = createLogger("relay:recordings");

/**
 * Where recordings live, and the sidecar that maps an id to a path.
 *
 * **The path never crosses the protocol boundary.** A client names a recording
 * by its `rec_…` id and this module resolves the file; nothing on the wire
 * carries a filesystem path in either direction. That is the single property
 * that keeps `recording:fetch` from becoming `file:read` with a different name
 * — and it is why the LAN-only `GET /recording` route takes an `id` and has no
 * `path` parameter at all.
 *
 * The index is a separate file from `grants.json` for the reason that file
 * gives for being separate from `config.json`: different churn rates, and a
 * torn write of the noisy one must not cost you the quiet one.
 */

const DIR = process.env.MTMUX_CONFIG_DIR ?? join(homedir(), ".mtmux");

export const RECORDINGS_DIR = join(DIR, "recordings");
const INDEX_PATH = join(RECORDINGS_DIR, "index.json");

const EMPTY: RecordingFile = { version: 1, recordings: [] };

/**
 * 1 GiB across all recordings, swept oldest-first at startup.
 *
 * A safety limit, not a plan limit — the same category as `MAX_LOG_BYTES` and
 * `MAX_FILE_SIZE`. These are files on the user's own disk that cost us nothing
 * to store, so metering them would be gating a local feature on an account,
 * which invariant 5 forbids. What this number is for is the laptop that
 * quietly fills up because a `mtmux record` was left running in July.
 */
export const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

/** `rec_` + 16 base32 characters, minted the way `newGrantId` mints grant ids. */
export function newRecordingId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "";
  for (const byte of randomBytes(16)) out += alphabet[byte % 32];
  return `rec_${out}`;
}

/**
 * The filename for a recording.
 *
 * Built entirely from values we generate — a timestamp, a sanitised slug and
 * the random id — and never from anything a caller supplied. `pipe-pane` in
 * `recorder.ts` interpolates this path into `/bin/sh -c`, so "no caller input
 * reaches a filename" is not tidiness, it is the reason that call is safe.
 */
export function recordingFilename(
  id: string,
  label: string,
  at: Date = new Date(),
): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);
  const slug = label.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "session";
  return `${stamp}-${slug}-${id}.cast`;
}

export function recordingPath(filename: string): string {
  return join(RECORDINGS_DIR, filename);
}

export async function load(): Promise<RecordingFile> {
  try {
    const raw = await readFile(INDEX_PATH, "utf8");
    const parsed = RecordingFile.safeParse(JSON.parse(raw));
    // A file we cannot read reads as empty, never as fatal — the same call
    // `grants-store.ts` makes. A hand-edit should not stop the relay booting.
    return parsed.success ? parsed.data : EMPTY;
  } catch {
    return EMPTY;
  }
}

/**
 * Make sure the recordings directory exists, 0700.
 *
 * Called before the cast file is opened, not only before the index is written:
 * `createCastWriter` opens with `wx`, which fails on a missing directory, and
 * the index is written *after* a successful start.
 */
export async function ensureDir(): Promise<void> {
  await mkdir(RECORDINGS_DIR, { recursive: true, mode: 0o700 });
}

/** Temp-file-then-rename, 0600. A half-written index loses every recording. */
async function save(file: RecordingFile): Promise<void> {
  await ensureDir();
  const tmp = `${INDEX_PATH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2));
  await chmod(tmp, 0o600);
  await rename(tmp, INDEX_PATH);
}

export async function list(): Promise<RecordingInfo[]> {
  return (await load()).recordings;
}

export async function get(id: string): Promise<RecordingInfo | null> {
  return (await list()).find((r) => r.id === id) ?? null;
}

export async function put(recording: RecordingInfo): Promise<void> {
  const file = await load();
  await save({
    version: 1,
    recordings: [
      ...file.recordings.filter((r) => r.id !== recording.id),
      recording,
    ],
  });
}

export async function patch(
  id: string,
  changes: Partial<RecordingInfo>,
): Promise<RecordingInfo | null> {
  const file = await load();
  const existing = file.recordings.find((r) => r.id === id);
  if (!existing) return null;
  const updated = { ...existing, ...changes, id: existing.id };
  await save({
    version: 1,
    recordings: file.recordings.map((r) => (r.id === id ? updated : r)),
  });
  return updated;
}

/** Forget a recording and delete its file. Missing files are not an error. */
export async function remove(id: string): Promise<boolean> {
  const file = await load();
  const existing = file.recordings.find((r) => r.id === id);
  if (!existing) return false;

  await save({
    version: 1,
    recordings: file.recordings.filter((r) => r.id !== id),
  });
  try {
    await unlink(recordingPath(existing.filename));
  } catch {
    // Already gone. The index row was the authoritative half and it is.
  }
  return true;
}

/** A row for a recording that has just started. */
export function startedRecording(options: {
  id: string;
  filename: string;
  target: RecordingTarget;
  title: string;
  cols: number;
  rows: number;
  startedAt?: number;
}): RecordingInfo {
  return {
    id: options.id,
    filename: options.filename,
    target: options.target,
    title: options.title,
    cols: options.cols,
    rows: options.rows,
    startedAt: options.startedAt ?? Date.now(),
    endedAt: null,
    bytes: 0,
    events: 0,
    truncated: false,
    stopReason: null,
  };
}

/**
 * Close out recordings a previous process left open, and enforce the disk cap.
 *
 * Two failures, one pass. A `kill -9` leaves a row with `endedAt: null` and a
 * file that is as complete as it got: those are closed from the row's own byte
 * count and marked `truncated`, because a recording that claims to still be
 * running after a reboot is worse than one that admits it was cut off. Then the
 * oldest recordings are dropped until the total is under `MAX_TOTAL_BYTES`.
 *
 * Never throws. It runs at boot, and a relay that will not start because a
 * recording directory is odd is a worse outcome than a stale row.
 */
export async function sweepRecordings(
  maxTotalBytes = MAX_TOTAL_BYTES,
): Promise<{ closed: number; dropped: number }> {
  let closed = 0;
  let dropped = 0;

  try {
    const file = await load();
    if (file.recordings.length === 0) return { closed, dropped };

    const rows = file.recordings.map((row) => {
      if (row.endedAt !== null) return row;
      closed += 1;
      return {
        ...row,
        endedAt: row.startedAt,
        truncated: true,
        stopReason: "interrupted" as const,
      };
    });

    // Newest first, keeping rows until the budget runs out.
    const newestFirst = [...rows].sort((a, b) => b.startedAt - a.startedAt);
    const kept: RecordingInfo[] = [];
    const evicted: RecordingInfo[] = [];
    let total = 0;
    for (const row of newestFirst) {
      if (total + row.bytes > maxTotalBytes && kept.length > 0) {
        evicted.push(row);
        continue;
      }
      total += row.bytes;
      kept.push(row);
    }

    await save({
      version: 1,
      recordings: kept.sort((a, b) => a.startedAt - b.startedAt),
    });

    for (const row of evicted) {
      dropped += 1;
      try {
        await unlink(recordingPath(row.filename));
      } catch {
        // Already gone.
      }
    }

    if (closed > 0 || dropped > 0) {
      logger.info({ closed, dropped }, "Swept recordings");
    }
  } catch (err) {
    logger.warn({ err }, "Could not sweep recordings");
  }

  return { closed, dropped };
}

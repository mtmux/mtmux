import { homedir } from "node:os";
import { join } from "node:path";
import { createReadStream, statSync, watch } from "node:fs";
import { chmod, mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import { createInterface } from "node:readline";

/**
 * Where the embedded relay's log goes, and how to read it back.
 *
 * `mtmux start` runs the relay in its own process, and `packages/logger` writes
 * to fd 1 — the same stream as the banner. In production it also skips
 * pino-pretty, so what landed on top of the QR code was raw NDJSON with a pid
 * and a hostname in every line. Moving it to a file is only half the fix: taking
 * logs off the terminal without giving them somewhere is a debuggability
 * regression, so `mtmux logs` is the other half.
 */

const DIR = process.env.MTMUX_CONFIG_DIR ?? join(homedir(), ".mtmux");

export const LOG_DIR = join(DIR, "logs");
export const LOG_PATH = join(LOG_DIR, "mtmux.log");

/**
 * Roll at 4 MiB and keep three files behind the live one.
 *
 * Small, because this is a debugging aid on someone's laptop or VPS rather than
 * an archive: a few megabytes covers the session that went wrong, and anything
 * larger is a surprise disk bill for a tool nobody asked to keep records.
 */
export const MAX_LOG_BYTES = 4 * 1024 * 1024;
export const KEEP_ROTATED = 3;

/**
 * Roll the log if it has grown past the cap.
 *
 * Called once at startup rather than on a timer or per line. Rotating while
 * pino holds the fd would leave it writing into an unlinked inode, so the only
 * safe moment is before the logger is constructed — which is also the only
 * moment `mtmux start` has, since the relay is imported exactly once.
 */
export async function rotateIfNeeded(
  path: string = LOG_PATH,
  maxBytes: number = MAX_LOG_BYTES,
): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true, mode: 0o700 }).catch(() => {});
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return; // No log yet. Nothing to roll.
  }
  if (size < maxBytes) return;

  // Shift the numbered files up, dropping the oldest.
  await unlink(`${path}.${KEEP_ROTATED}`).catch(() => {});
  for (let i = KEEP_ROTATED - 1; i >= 1; i -= 1) {
    await rename(`${path}.${i}`, `${path}.${i + 1}`).catch(() => {});
  }
  await rename(path, `${path}.1`).catch(() => {});
  // The rotated copy carries whatever the live log had; the *next* live file
  // is created by pino at the umask default, so pin it here. Terminal logs
  // name sessions, paths and device labels — not world-readable material.
  await chmod(`${path}.1`, 0o600).catch(() => {});
}

/** Every log file, newest content first: the live one, then the rotated ones. */
export async function logFiles(path: string = LOG_PATH): Promise<string[]> {
  const base = path.split("/").pop()!;
  const entries = await readdir(LOG_DIR).catch(() => [] as string[]);
  const rotated = entries
    .filter((name) => name.startsWith(`${base}.`))
    .sort((a, b) => Number(a.split(".").pop()) - Number(b.split(".").pop()))
    .map((name) => join(LOG_DIR, name));
  return [path, ...rotated];
}

/**
 * The last `count` lines, oldest first.
 *
 * Streamed rather than read whole, because the file is capped at megabytes and
 * a `tail -n 50` should not pull all of it into memory. Rotated files are read
 * only when the live one is shorter than what was asked for.
 */
export async function tailLines(
  count: number,
  path: string = LOG_PATH,
): Promise<string[]> {
  const out: string[] = [];
  for (const file of await logFiles(path)) {
    const lines = await readAllLines(file);
    out.unshift(...lines);
    if (out.length >= count) break;
  }
  return out.slice(-count);
}

async function readAllLines(file: string): Promise<string[]> {
  // Checked first, because a missing file is the *normal* case — nothing has
  // been logged yet, or a rotated file this run never created — and a stream
  // that errors re-emits on the readline interface, where an unhandled `error`
  // event is a thrown exception rather than a rejected promise.
  try {
    await stat(file);
  } catch {
    return [];
  }
  return new Promise((resolve) => {
    const lines: string[] = [];
    const stream = createReadStream(file, { encoding: "utf8" });
    stream.on("error", () => resolve([]));
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("error", () => resolve([]));
    rl.on("line", (line) => {
      if (line.trim().length > 0) lines.push(line);
    });
    rl.on("close", () => resolve(lines));
  });
}

/**
 * Call `onLine` for everything appended to `path` from `startAt` onwards.
 *
 * `fs.watch` plus a byte offset rather than a polling `stat`, so an idle
 * terminal costs nothing. A file that shrinks has been rotated underneath us,
 * so the offset resets to zero rather than seeking past the new end.
 */
export function followLog(
  onLine: (line: string) => void,
  path: string = LOG_PATH,
): () => void {
  let offset = safeSize(path);
  let reading = false;
  let again = false;

  const pump = () => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    const size = safeSize(path);
    if (size < offset) offset = 0;
    if (size === offset) {
      reading = false;
      if (again) {
        again = false;
        pump();
      }
      return;
    }
    const stream = createReadStream(path, {
      encoding: "utf8",
      start: offset,
      end: size - 1,
    });
    let buffered = "";
    stream.on("data", (chunk) => {
      buffered += chunk as string;
    });
    const finish = () => {
      offset = size;
      for (const line of buffered.split("\n")) {
        if (line.trim().length > 0) onLine(line);
      }
      reading = false;
      if (again) {
        again = false;
        pump();
      }
    };
    stream.on("end", finish);
    stream.on("error", finish);
  };

  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(LOG_DIR, (_event, filename) => {
      if (filename && !path.endsWith(filename)) return;
      pump();
    });
  } catch {
    // No watch support (some network filesystems). Fall back to a slow poll
    // rather than silently following nothing.
    const timer = setInterval(pump, 1000);
    timer.unref();
    return () => clearInterval(timer);
  }
  return () => watcher?.close();
}

function safeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

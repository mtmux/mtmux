/**
 * A record of the server running on this machine, so `mtmux status` and
 * `mtmux stop` have something to talk about.
 *
 * The file is a hint, not a lock. A machine can be power-cycled mid-session, a
 * process can be `kill -9`ed, and a stale record left behind by either would
 * make `status` lie. So every read is validated against reality — the pid must
 * still exist and the port must still answer — and a record that fails is
 * cleaned up rather than reported.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";

const DIR = process.env.MTMUX_CONFIG_DIR ?? join(homedir(), ".mtmux");
const FILE = join(DIR, "server.json");

export type ServerState = {
  pid: number;
  port: number;
  host: string;
  /** Loopback URL, always correct on this machine. */
  localUrl: string;
  lanUrl: string | null;
  /** Whether this server opened a tunnel or is LAN-only. */
  mode: "tunnel" | "local";
  /** The join URL currently on offer, when one is armed. */
  inviteUrl: string | null;
  startedAt: number;
  version: string;
};

export async function write(state: ServerState): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(state, null, 2));
}

export async function clear(): Promise<void> {
  await unlink(FILE).catch(() => {
    // Already gone, which is the state we wanted.
  });
}

/** True when `pid` names a live process we are allowed to signal. */
function alive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks without delivering
    // anything.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — still "running".
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function answering(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The running server, or null.
 *
 * A record whose process is gone is deleted on the way past: leaving it would
 * make the next `mtmux start` think a port was taken when it is not.
 */
export async function read(): Promise<ServerState | null> {
  let state: ServerState;
  try {
    state = JSON.parse(await readFile(FILE, "utf8")) as ServerState;
  } catch {
    return null;
  }
  if (!state?.pid || !alive(state.pid)) {
    await clear();
    return null;
  }
  if (!(await answering(state.port))) {
    // The process is alive but not serving — mid-boot, or wedged. Report it as
    // running rather than deleting a record that may become valid a moment
    // later; `status` distinguishes the two.
    return { ...state, localUrl: state.localUrl };
  }
  return state;
}

export type StopOutcome = "stopped" | "not-running" | "denied";

/**
 * Ask the running server to stop, and wait for it to actually go.
 *
 * SIGTERM rather than SIGKILL because the server has a shutdown path that
 * closes the tunnel cleanly; killing it outright leaves the broker holding a
 * tunnel until its own sweep notices.
 */
export async function stop(timeoutMs = 8000): Promise<StopOutcome> {
  const state = await read();
  if (!state) return "not-running";

  try {
    process.kill(state.pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return "denied";
    await clear();
    return "not-running";
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(state.pid)) {
      await clear();
      return "stopped";
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // It ignored SIGTERM. Escalate rather than reporting a stop that did not
  // happen.
  try {
    process.kill(state.pid, "SIGKILL");
  } catch {
    // Raced with its own exit.
  }
  await clear();
  return "stopped";
}

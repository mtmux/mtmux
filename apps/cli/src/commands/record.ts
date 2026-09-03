import kleur from "kleur";

import type { RecordingInfo, RecordingTarget } from "@repo/protocol";

import * as configStore from "../config-store.js";
import { RECORD_PATH, type RecordAction } from "../record-control.js";
import * as serverState from "../server-state.js";
import { parseDuration } from "../share-grants.js";

import { share } from "./share.js";

/**
 * `mtmux record` — capture a session or pane to a file you own.
 *
 * A control command, like `mtmux devices` and `mtmux approve`: it talks to the
 * running server over loopback rather than doing anything itself, because the
 * server is what holds the tmux connection, the recorder's ptys and the index.
 *
 * Recordings are local files under `~/.mtmux/recordings/`, mode 0600. Nothing
 * about them reaches the broker — sharing one reuses the same CPace pairing and
 * the same grant machinery a session share does, so the `.cast` leaves the
 * machine only as AES-GCM frames a recipient has paired for.
 */

const TIMEOUT_MS = 10_000;

type ControlResult<T> =
  | { ok: true; body: T }
  | { ok: false; message: string; code?: string };

async function call<T>(
  port: number,
  body: RecordAction,
): Promise<ControlResult<T>> {
  const state = await serverState.read();
  if (!state) {
    return {
      ok: false,
      message: "No mtmux server is running. Start one with `mtmux`.",
    };
  }

  let cfg: Awaited<ReturnType<typeof configStore.load>>;
  try {
    cfg = await configStore.load();
  } catch {
    return { ok: false, message: "Could not read this machine's config." };
  }

  try {
    const res = await fetch(
      `http://127.0.0.1:${state.port || port}${RECORD_PATH}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    const parsed = (await res.json()) as T & { error?: string; code?: string };
    if (!res.ok) {
      return {
        ok: false,
        message: parsed.error ?? `The server answered ${res.status}.`,
        ...(parsed.code ? { code: parsed.code } : {}),
      };
    }
    return { ok: true, body: parsed };
  } catch {
    return { ok: false, message: "Could not reach the mtmux server." };
  }
}

function fail(result: { message: string; code?: string }): void {
  console.error(kleur.red(`  ✗ ${result.message}`));
  if (result.code === "PANE_ALREADY_PIPED") {
    console.error(
      kleur.dim(
        "    Something is already piping that pane. mtmux will not replace it,\n" +
          "    because tmux would do so silently.",
      ),
    );
  }
  process.exitCode = 1;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(recording: RecordingInfo): string {
  const end = recording.endedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - recording.startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function describeTarget(target: RecordingTarget): string {
  return target.kind === "pane"
    ? `${target.session} ${target.paneId}`
    : target.session;
}

export async function recordStart(opts: {
  session: string;
  port: number;
  pane?: string;
  title?: string;
}): Promise<void> {
  const target: RecordingTarget = opts.pane
    ? { kind: "pane", session: opts.session, paneId: opts.pane }
    : { kind: "session", session: opts.session };

  const result = await call<{ recording: RecordingInfo }>(opts.port, {
    action: "start",
    target,
    ...(opts.title ? { title: opts.title } : {}),
  });
  if (!result.ok) return fail(result);

  const { recording } = result.body;
  console.log("");
  console.log(
    kleur.green(`  ● Recording ${describeTarget(target)}`) +
      kleur.dim(`  ${recording.cols}×${recording.rows}`),
  );
  console.log(kleur.dim(`    ${recording.id}`));
  console.log("");
  // Said here rather than only in the docs. By the time somebody reads the
  // docs the secret is already in the file.
  console.log(
    kleur.yellow(
      "    A recording contains everything printed on screen, including",
    ),
  );
  console.log(
    kleur.yellow("    anything secret. The file is yours alone (0600)."),
  );
  console.log("");
  console.log(
    kleur.dim(`    Stop with `) +
      kleur.bold(`mtmux record stop ${recording.id}`),
  );
  console.log("");
}

export async function recordList(json = false): Promise<void> {
  const result = await call<{ recordings: RecordingInfo[] }>(14100, {
    action: "list",
  });
  if (!result.ok) return fail(result);

  const { recordings } = result.body;
  if (json) {
    console.log(JSON.stringify({ recordings }, null, 2));
    return;
  }

  if (recordings.length === 0) {
    console.log(kleur.dim("  No recordings on this machine."));
    console.log(
      kleur.dim("  Make one with ") + kleur.bold("mtmux record <session>"),
    );
    return;
  }

  console.log("");
  for (const recording of [...recordings].reverse()) {
    const live = recording.endedAt === null;
    const state = live
      ? kleur.green("● recording")
      : recording.truncated
        ? kleur.yellow("cut off")
        : kleur.dim(recording.stopReason ?? "done");
    console.log(
      `  ${kleur.bold(recording.id)}  ${state}  ${recording.title}` +
        kleur.dim(
          `  ${formatDuration(recording)}  ${formatBytes(recording.bytes)}`,
        ),
    );
  }
  console.log("");
  console.log(
    kleur.dim("  Share one with ") + kleur.bold("mtmux record share <id>"),
  );
  console.log("");
}

export async function recordStop(
  id: string | undefined,
  port: number,
  all = false,
): Promise<void> {
  if (all) {
    const result = await call<{ ok: boolean }>(port, { action: "stopAll" });
    if (!result.ok) return fail(result);
    console.log(kleur.green("  ✓ Stopped every recording."));
    return;
  }

  if (!id) {
    console.error(kleur.red("  ✗ Which recording? Pass an id, or --all."));
    process.exitCode = 1;
    return;
  }

  const result = await call<{ recording: RecordingInfo }>(port, {
    action: "stop",
    id,
  });
  if (!result.ok) return fail(result);

  const { recording } = result.body;
  console.log(
    kleur.green(`  ✓ Stopped.`) +
      kleur.dim(
        `  ${formatDuration(recording)}, ${formatBytes(recording.bytes)}`,
      ),
  );
  if (recording.stopReason === "limit") {
    console.log(
      kleur.dim("    It had already hit its size or time limit and closed."),
    );
  }
}

export async function recordRemove(id: string, port: number): Promise<void> {
  const result = await call<{ ok: boolean }>(port, { action: "delete", id });
  if (!result.ok) return fail(result);
  console.log(kleur.green(`  ✓ Deleted ${id}.`));
}

/**
 * `mtmux record share <id>` — hand somebody a recording.
 *
 * Reuses `share()` wholesale with a recordings-scoped grant. What differs is
 * the banner, and the difference matters: the read-write shell warning does not
 * apply to a fixed artefact and would read as boilerplate, while the risk that
 * *is* here — that a copy cannot be recalled — has no analogue in a session
 * share. `shareBanner` branches on the scope kind for exactly that reason.
 */
export async function recordShare(opts: {
  id: string;
  port: number;
  api?: string;
  expires: string;
  label?: string;
  qr: boolean;
}): Promise<void> {
  if (parseDuration(opts.expires) === undefined) {
    console.error(
      kleur.red(
        `  ✗ Could not read --expires "${opts.expires}". Try 24h, 7d, or never.`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  const listed = await call<{ recordings: RecordingInfo[] }>(opts.port, {
    action: "list",
  });
  if (!listed.ok) return fail(listed);

  const recording = listed.body.recordings.find((r) => r.id === opts.id);
  if (!recording) {
    console.error(kleur.red(`  ✗ No recording with id ${opts.id}.`));
    console.error(kleur.dim("    Run `mtmux record list` to see them."));
    process.exitCode = 1;
    return;
  }
  if (recording.endedAt === null) {
    console.error(kleur.red("  ✗ That recording is still running."));
    console.error(
      kleur.dim(`    Stop it first: mtmux record stop ${recording.id}`),
    );
    process.exitCode = 1;
    return;
  }

  await share({
    session: "",
    port: opts.port,
    api: opts.api,
    // A recordings share is read-only and file-less by construction: the scope
    // arm permits neither a session nor the file tree, so these two are saying
    // out loud what the scope already guarantees.
    readOnly: true,
    files: "none",
    expires: opts.expires,
    label: opts.label ?? `Recording: ${recording.title}`,
    qr: opts.qr,
    scope: { kind: "recordings", recordings: [recording.id] },
  });
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import kleur from "kleur";
import { resolveApiBase } from "../api.js";
import {
  cliVersion,
  describeUpdate,
  fetchBrokerVersion,
} from "../update-check.js";
import * as serverState from "../server-state.js";

const exec = promisify(execFile);

/**
 * `mtmux doctor` — answer "why isn't this working?" without a support thread.
 *
 * Every check reports one of three things, and the distinction matters: a
 * failure means nothing will work, a warning means the hosted path is
 * unavailable but local still works, and ok means move on. The checks run in
 * dependency order so the first failure is the real cause rather than a
 * symptom of an earlier one.
 */

type Level = "ok" | "warn" | "fail";

type Check = {
  name: string;
  level: Level;
  detail: string;
  /** What to actually do about it, in the imperative. */
  fix?: string;
};

const MIN_NODE_MAJOR = 22;

async function checkNode(): Promise<Check> {
  const version = process.versions.node;
  const major = parseInt(version.split(".")[0]!, 10);
  return major >= MIN_NODE_MAJOR
    ? { name: "Node", level: "ok", detail: `v${version}` }
    : {
        name: "Node",
        level: "fail",
        detail: `v${version}, need v${MIN_NODE_MAJOR}+`,
        fix: "Install Node 22 or newer — https://nodejs.org",
      };
}

async function checkTmux(): Promise<Check> {
  try {
    const { stdout } = await exec("tmux", ["-V"]);
    return { name: "tmux", level: "ok", detail: stdout.trim() };
  } catch {
    const hint =
      process.platform === "darwin"
        ? "brew install tmux"
        : process.platform === "linux"
          ? "sudo apt install tmux   (or your distro's equivalent)"
          : "https://github.com/tmux/tmux";
    return {
      name: "tmux",
      level: "fail",
      detail: "not found on PATH",
      fix: hint,
    };
  }
}

/**
 * `mkfifo`, which only `mtmux record --pane` needs.
 *
 * A `warn`, never a `fail`: everything else in mtmux works without it, and so
 * does recording a whole session — only pane capture uses a named pipe, and
 * only because `pipe-pane` writes raw bytes that have to be timestamped and
 * encoded on the way to a `.cast`. POSIX requires it, so this is really only
 * ever a very stripped container.
 */
async function checkMkfifo(): Promise<Check> {
  try {
    await exec("mkfifo", ["--version"]);
    return { name: "mkfifo", level: "ok", detail: "available" };
  } catch {
    // BSD `mkfifo` (macOS) has no `--version` and exits non-zero on it, so a
    // failure here is not yet an answer. `command -v` is.
    try {
      await exec("sh", ["-c", "command -v mkfifo"]);
      return { name: "mkfifo", level: "ok", detail: "available" };
    } catch {
      return {
        name: "mkfifo",
        level: "warn",
        detail: "not found — `mtmux record --pane` will not work",
        fix: "Install coreutils. Recording a whole session does not need it.",
      };
    }
  }
}

/**
 * Whether the tmux server is reachable, which is not the same as tmux being
 * installed: a socket owned by another user is the classic "no sessions
 * listed" cause on a shared box.
 */
async function checkTmuxServer(): Promise<Check> {
  try {
    const { stdout } = await exec("tmux", ["list-sessions"]);
    const count = stdout.trim().split("\n").filter(Boolean).length;
    return {
      name: "tmux server",
      level: "ok",
      detail: `${count} session${count === 1 ? "" : "s"}`,
    };
  } catch (err) {
    const message = String((err as { stderr?: string }).stderr ?? "").trim();
    // "no server running" is the normal cold-start state, not a problem —
    // mtmux creates a session on demand.
    if (/no server running|no such file/i.test(message)) {
      return {
        name: "tmux server",
        level: "ok",
        detail: "not started yet (mtmux will start one)",
      };
    }
    return {
      name: "tmux server",
      level: "warn",
      detail: message || "could not list sessions",
      fix: "Run mtmux as the user that owns the tmux socket, or set TMUX_SOCKET.",
    };
  }
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

async function checkPort(port: number): Promise<Check> {
  const running = await serverState.read();
  if (running && running.port === port) {
    return {
      name: `Port ${port}`,
      level: "ok",
      detail: `in use by this mtmux (pid ${running.pid})`,
    };
  }
  if (await portFree(port)) {
    return { name: `Port ${port}`, level: "ok", detail: "free" };
  }
  return {
    name: `Port ${port}`,
    level: "fail",
    detail: "in use by another process",
    fix: `Pick another port with --port, or stop whatever holds ${port}.`,
  };
}

async function checkConfigPermissions(): Promise<Check> {
  const file = join(
    process.env.MTMUX_CONFIG_DIR ?? join(homedir(), ".mtmux"),
    "config.json",
  );
  try {
    const info = await stat(file);
    const mode = info.mode & 0o777;
    if (mode & 0o077) {
      return {
        name: "Config",
        level: "warn",
        detail: `${file} is ${mode.toString(8)} — readable by others`,
        fix: `chmod 600 ${file}`,
      };
    }
    return { name: "Config", level: "ok", detail: file };
  } catch {
    return {
      name: "Config",
      level: "ok",
      detail: "none yet (created on first run)",
    };
  }
}

/**
 * Can we reach the broker? A failure here is a warning, never an error —
 * `mtmux start --local` is fully functional without it, and saying "failed"
 * would misrepresent an offline machine as a broken install.
 */
async function checkBroker(base: string): Promise<Check> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const started = Date.now();
  try {
    const res = await fetch(`${base}/health`, { signal: controller.signal });
    if (!res.ok) {
      return {
        name: "Broker",
        level: "warn",
        detail: `${base} answered ${res.status}`,
        fix: "Hosted pairing is unavailable. `mtmux start --local` still works.",
      };
    }
    return {
      name: "Broker",
      level: "ok",
      detail: `${base} (${Date.now() - started}ms)`,
    };
  } catch {
    return {
      name: "Broker",
      level: "warn",
      detail: `${base} unreachable`,
      fix: "Check your network, or use `mtmux start --local` for LAN only.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is this CLI still one the broker will talk to?
 *
 * A warning, never a failure, and never blocking: `mtmux start --local` does
 * not care what any broker thinks, so reporting "fail" here would tell an
 * offline user their install is broken when it is not. A broker with nothing
 * to say produces a plain ok line.
 */
async function checkVersion(base: string): Promise<Check> {
  const current = await cliVersion().catch(() => "unknown");
  const notice = describeUpdate(current, await fetchBrokerVersion(base));
  const detail = notice.advisory
    ? `${notice.detail} — ${notice.advisory}`
    : notice.detail;
  if (notice.kind === "current") {
    return { name: "mtmux", level: notice.advisory ? "warn" : "ok", detail };
  }
  return {
    name: "mtmux",
    level: "warn",
    detail,
    fix: notice.fix ?? "npm i -g mtmux@latest",
  };
}

const GLYPH: Record<Level, string> = {
  ok: kleur.green("✓"),
  warn: kleur.yellow("!"),
  fail: kleur.red("✗"),
};

export type DoctorOpts = { port: number; api?: string };

export async function doctor(opts: DoctorOpts): Promise<void> {
  const base = await resolveApiBase(opts.api);

  const checks: Check[] = [
    await checkNode(),
    await checkTmux(),
    await checkTmuxServer(),
    await checkMkfifo(),
    await checkPort(opts.port),
    await checkConfigPermissions(),
    await checkBroker(base),
    await checkVersion(base),
  ];

  const width = Math.max(...checks.map((c) => c.name.length));
  console.log("");
  for (const check of checks) {
    console.log(
      `  ${GLYPH[check.level]} ${check.name.padEnd(width)}  ${kleur.dim(check.detail)}`,
    );
    if (check.fix && check.level !== "ok") {
      console.log(`    ${kleur.dim("→ " + check.fix)}`);
    }
  }

  const failed = checks.filter((c) => c.level === "fail").length;
  const warned = checks.filter((c) => c.level === "warn").length;
  console.log("");
  if (failed > 0) {
    console.log(
      kleur.red(`  ${failed} problem${failed === 1 ? "" : "s"} to fix first.`),
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    warned > 0
      ? kleur.yellow(
          `  Ready, with ${warned} caveat${warned === 1 ? "" : "s"}.`,
        )
      : kleur.green("  Everything checks out."),
  );
}

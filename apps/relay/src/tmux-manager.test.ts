import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Integration test for the capture-pane bound.
 *
 * `capture-pane -S -` on a host with a large `history-limit` produces tens of
 * megabytes, which blows past execFile's default 1 MiB `maxBuffer` and REJECTS
 * (it does not truncate). That rejection happened after the old PTY had already
 * been killed, so attaching to any long-lived session left a dead terminal.
 *
 * This builds a throwaway tmux server on a private socket, fills a pane with
 * >1 MiB of scrollback, and asserts the fixture really does reproduce the old
 * failure before checking that `capturePane` stays bounded.
 *
 * tmux-manager reads `config.tmuxSocket` at import time, so the socket is set on
 * process.env before the dynamic import (same pattern as file-service.test.ts).
 */

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const tmuxAvailable = hasTmux();
const describeTmux = tmuxAvailable ? describe : describe.skip;

const SESSION = "relay-capture-fixture";
const LINE = "x".repeat(120);
const LINE_COUNT = 12_000; // ~1.45 MiB, comfortably over the 1 MiB default
const MARKER = "COLOURED-MARKER";
const ESC = "\u001b"; // SGR sequences start here

let tmux: typeof import("./tmux-manager.js");
let base: string;
let socket: string;
let conf: string;

function tmuxExec(args: string[], maxBuffer = 64 * 1024 * 1024): string {
  return execFileSync("tmux", ["-f", conf, "-S", socket, ...args], {
    encoding: "utf8",
    maxBuffer,
  });
}

beforeAll(async () => {
  if (!tmuxAvailable) return;

  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-tmux-")));
  socket = path.join(base, "sock");

  // Run the fixture as the session's own command rather than send-keys into a
  // shell: no prompt to race, and nothing echoes the script text into the pane
  // (which would make the completion sentinel match before it had run).
  const script = path.join(base, "fixture.sh");
  fs.writeFileSync(
    script,
    [
      `awk 'BEGIN{for(i=0;i<${LINE_COUNT};i++) print "${LINE}"}'`,
      // Coloured sentinel: doubles as the completion marker and the SGR probe.
      `printf '\\033[31m${MARKER}\\033[0m\\n'`,
      // Keep the pane alive so the session doesn't exit out from under us.
      "sleep 600",
    ].join("\n"),
  );

  // history-limit must already be raised when the pane starts producing output,
  // so set it in the config the server boots with rather than after the fact.
  conf = path.join(base, "tmux.conf");
  fs.writeFileSync(conf, "set -g history-limit 200000\n");

  tmuxExec([
    "new-session",
    "-d",
    "-s",
    SESSION,
    "-x",
    "200",
    "-y",
    "50",
    `sh ${script}`,
  ]);

  const deadline = Date.now() + 60_000;
  for (;;) {
    const tail = tmuxExec(["capture-pane", "-t", SESSION, "-p", "-S", "-5"]);
    if (tail.includes(MARKER)) break;
    if (Date.now() > deadline) throw new Error("tmux fixture never finished");
    await new Promise((r) => setTimeout(r, 100));
  }

  process.env.TMUX_SOCKET = socket;
  tmux = await import("./tmux-manager.js");
}, 90_000);

afterAll(() => {
  if (!tmuxAvailable) return;
  try {
    tmuxExec(["kill-server"]);
  } catch {
    // server may already be gone
  }
  fs.rmSync(base, { recursive: true, force: true });
});

describeTmux("capturePane", () => {
  it("has a fixture that would overrun the default 1 MiB maxBuffer", () => {
    const full = tmuxExec(["capture-pane", "-t", SESSION, "-p", "-S", "-"]);
    expect(full.length).toBeGreaterThan(1024 * 1024);
  });

  it("returns bounded output instead of throwing", async () => {
    const out = await tmux.capturePane(SESSION);
    expect(out.length).toBeLessThan(1024 * 1024);
    // `-S -2000` means "2000 lines above the visible pane", so the result is
    // the bound plus one pane height — never the full 12k-line history.
    const lines = out.split("\n").length;
    expect(lines).toBeGreaterThan(2000);
    expect(lines).toBeLessThan(LINE_COUNT / 2);
  });

  it("honours an explicit line bound", async () => {
    const bounded = await tmux.capturePane(SESSION, { lines: 10 });
    const dflt = await tmux.capturePane(SESSION);
    expect(bounded.split("\n").length).toBeLessThan(dflt.split("\n").length);
    expect(bounded.split("\n").length).toBeLessThan(200);
  });

  it("keeps SGR escapes by default so colours survive the replay", async () => {
    const out = await tmux.capturePane(SESSION, { lines: 5 });
    expect(out).toContain(MARKER);
    expect(out).toContain(ESC);
  });

  it("can omit escapes for plain-text consumers", async () => {
    const out = await tmux.capturePane(SESSION, { lines: 5, escapes: false });
    expect(out).toContain(MARKER);
    expect(out).not.toContain(ESC);
  });
});

describeTmux("capturePaneById", () => {
  it("is bounded and plain-text by default (copy-mode overlay)", async () => {
    const paneId = tmuxExec([
      "list-panes",
      "-t",
      SESSION,
      "-F",
      "#{pane_id}",
    ]).trim();
    const out = await tmux.capturePaneById(paneId);
    expect(out.length).toBeLessThan(1024 * 1024);
    expect(out).not.toContain(ESC);
  });
});

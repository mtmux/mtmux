import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseCast } from "@repo/cast";

/**
 * The recorder, against a fake tmux and a fake pty.
 *
 * Everything that would touch a real tmux server is mocked — this repo has a
 * standing rule that any tmux run by hand must be scoped to a throwaway socket
 * with `-L`, and a unit test that spawns real sessions is the failure mode that
 * rule exists for. What is actually under test is the argv the recorder builds,
 * which is where the `pipe-pane` shell risk lives.
 */

const execFileMock = vi.hoisted(() =>
  vi.fn(
    (
      _cmd: string,
      _args: string[],
      cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
    ) => cb(null, { stdout: "", stderr: "" }),
  ),
);
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const ptyHandlers = vi.hoisted(() => ({
  data: [] as Array<(d: string) => void>,
  exit: [] as Array<(c: number) => void>,
  killed: false,
}));

vi.mock("./pty-bridge.js", () => ({
  createPtyBridge: vi.fn(() => ({
    spawnError: null,
    onData: (cb: (d: string) => void) => ptyHandlers.data.push(cb),
    onExit: (cb: (c: number) => void) => ptyHandlers.exit.push(cb),
    onReady: () => {},
    onSpawnError: () => {},
    markDetaching: () => {},
    kill: () => {
      ptyHandlers.killed = true;
    },
    write: () => {},
    resize: () => {},
    pause: () => {},
    resume: () => {},
    pid: 1234,
    sessionName: "clone",
    detaching: false,
  })),
}));

vi.mock("./tmux-clone.js", () => ({
  createRecordingClone: vi.fn(async (_t: string, id: string) =>
    Promise.resolve(`__mtmux_rec_${id}`),
  ),
  destroyClone: vi.fn(async () => Promise.resolve()),
}));

vi.mock("./tmux-manager.js", () => ({
  sessionExists: vi.fn(async () => Promise.resolve(true)),
  listWindows: vi.fn(async () =>
    Promise.resolve([
      { id: "@1", active: true, dimensions: { cols: 120, rows: 40 } },
    ]),
  ),
  capturePaneById: vi.fn(async () => Promise.resolve("PANE CONTENTS")),
}));

const original = process.env.MTMUX_CONFIG_DIR;
let dir: string;
let recorder: typeof import("./recorder.js");
let index: typeof import("./recordings-index.js");

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mtmux-recorder-"));
  process.env.MTMUX_CONFIG_DIR = dir;
  ptyHandlers.data = [];
  ptyHandlers.exit = [];
  ptyHandlers.killed = false;
  execFileMock.mockClear();
  vi.resetModules();
  recorder = await import("./recorder.js");
  index = await import("./recordings-index.js");
});

afterEach(async () => {
  await recorder.stopAll("ended").catch(() => {});
  if (original === undefined) delete process.env.MTMUX_CONFIG_DIR;
  else process.env.MTMUX_CONFIG_DIR = original;
});

/** The argv of the last call whose args include every one of `parts`. */
function lastCall(...parts: string[]): string[] | null {
  for (let i = execFileMock.mock.calls.length - 1; i >= 0; i -= 1) {
    const args = execFileMock.mock.calls[i]![1];
    if (parts.every((part) => args.includes(part))) return args;
  }
  return null;
}

/** The command and argv of the last call to a given binary. */
function lastBinary(bin: string): string[] | null {
  for (let i = execFileMock.mock.calls.length - 1; i >= 0; i -= 1) {
    const [cmd, args] = execFileMock.mock.calls[i]!;
    if (cmd === bin) return args;
  }
  return null;
}

async function castFor(id: string) {
  const info = await index.get(id);
  const file = index.recordingPath(info!.filename);
  return parseCast(await readFile(file, "utf8"));
}

describe("session recording", () => {
  it("writes what the pty emits, and adopts the session's own size", async () => {
    const info = await recorder.start({
      target: { kind: "session", session: "work" },
    });

    // The recorder joins at the size already in force. Attaching at 80x24 to a
    // session being viewed at 120x40 would shrink the owner's panes.
    expect(info.cols).toBe(120);
    expect(info.rows).toBe(40);

    for (const cb of ptyHandlers.data) cb("hello\r\n");
    await recorder.stop(info.id);

    const cast = await castFor(info.id);
    expect(cast.header.width).toBe(120);
    expect(cast.events.map((e) => e.data)).toEqual(["hello\r\n"]);
  });

  it("does not seed a capture-pane frame", async () => {
    // Attaching a tmux client forces a full redraw, so the first chunk already
    // carries the whole screen. A reconstruction would double-paint frame 0.
    const info = await recorder.start({
      target: { kind: "session", session: "work" },
    });
    for (const cb of ptyHandlers.data) cb("REDRAW");
    await recorder.stop(info.id);

    const cast = await castFor(info.id);
    expect(cast.events[0]!.data).toBe("REDRAW");
  });

  it("titles the cast after the session, and lets that be overridden", async () => {
    // A session name is itself a disclosure, and the title travels with the
    // file to whoever it is shared with.
    const a = await recorder.start({
      target: { kind: "session", session: "work" },
    });
    await recorder.stop(a.id);
    expect((await castFor(a.id)).header.title).toBe("work");

    const b = await recorder.start({
      target: { kind: "session", session: "work" },
      title: "a refactor",
    });
    await recorder.stop(b.id);
    expect((await castFor(b.id)).header.title).toBe("a refactor");
  });

  it("refuses a second recording of the same session", async () => {
    const info = await recorder.start({
      target: { kind: "session", session: "work" },
    });
    await expect(
      recorder.start({ target: { kind: "session", session: "work" } }),
    ).rejects.toMatchObject({ code: "ALREADY_RECORDING" });
    await recorder.stop(info.id);
  });

  it("refuses a session that does not exist", async () => {
    const tmux = await import("./tmux-manager.js");
    vi.mocked(tmux.sessionExists).mockResolvedValueOnce(false);
    await expect(
      recorder.start({ target: { kind: "session", session: "ghost" } }),
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  it("closes the recording when the pty exits", async () => {
    const info = await recorder.start({
      target: { kind: "session", session: "work" },
    });
    for (const cb of ptyHandlers.exit) cb(0);
    await vi.waitFor(async () => {
      expect((await index.get(info.id))?.stopReason).toBe("ended");
    });
  });

  it("stops cleanly at the byte limit and says so", async () => {
    // A recording that silently stops growing is a bug report; one that says
    // why is a feature.
    const info = await recorder.start({
      target: { kind: "session", session: "work" },
      maxBytes: 64,
    });
    for (const cb of ptyHandlers.data) cb("x".repeat(200));
    await vi.waitFor(async () => {
      expect((await index.get(info.id))?.stopReason).toBe("limit");
    });
  });

  it("records the byte and event counts on stop", async () => {
    const info = await recorder.start({
      target: { kind: "session", session: "work" },
    });
    for (const cb of ptyHandlers.data) cb("abc");
    const stopped = await recorder.stop(info.id);
    expect(stopped?.events).toBe(1);
    expect(stopped?.bytes).toBeGreaterThan(0);
    expect(stopped?.endedAt).not.toBeNull();
  });

  it("tears the clone down and kills the pty on stop", async () => {
    const clone = await import("./tmux-clone.js");
    const info = await recorder.start({
      target: { kind: "session", session: "work" },
    });
    await recorder.stop(info.id);
    expect(ptyHandlers.killed).toBe(true);
    expect(clone.destroyClone).toHaveBeenCalledWith(`__mtmux_rec_${info.id}`);
  });
});

describe("pane recording", () => {
  it("seeds a clear and the pane's current contents as the first frame", async () => {
    // The inverse of the session case, and the asymmetry is the point:
    // `pipe-pane` starts mid-stream and knows nothing about what is on screen.
    const info = await recorder.start({
      target: { kind: "pane", session: "work", paneId: "%7" },
    });
    await recorder.stop(info.id);

    const cast = await castFor(info.id);
    expect(cast.events[0]!.data).toBe("\x1b[H\x1b[2JPANE CONTENTS");
  });

  it("pipes into a FIFO, never into the cast file itself", async () => {
    // `cat >> the.cast` would append the pane's raw bytes to a file whose
    // format is one JSON value per line — producing something that parses as a
    // recording with no events, which is worse than failing outright.
    const info = await recorder.start({
      target: { kind: "pane", session: "work", paneId: "%7" },
    });

    const mkfifo = lastBinary("mkfifo")!;
    expect(mkfifo[0]).toBe("-m");
    expect(mkfifo[1]).toBe("600");
    expect(mkfifo[2]).toMatch(/\.cast\.pipe$/);

    const args = lastCall("pipe-pane", "-o")!;
    expect(args.slice(0, 4)).toEqual(["pipe-pane", "-o", "-t", "%7"]);
    expect(args[4]).toMatch(/^cat >> '\/.*\.cast\.pipe'$/);
    // Nothing in the path can close the quote or reach the shell.
    expect(args[4]).not.toMatch(/[;&|$`\\]/);
    await recorder.stop(info.id);
  });

  it("stops the pipe when the recording stops", async () => {
    const info = await recorder.start({
      target: { kind: "pane", session: "work", paneId: "%7" },
    });
    await recorder.stop(info.id);
    expect(lastCall("pipe-pane")).toEqual(["pipe-pane", "-t", "%7"]);
  });

  it("refuses a pane that already has a pipe rather than clobbering it", async () => {
    // Starting a second pipe on a pane silently replaces the first. Somebody
    // running their own must not lose it to a UI button.
    execFileMock.mockImplementationOnce((_cmd, _args, cb) =>
      cb(null, { stdout: "1\n", stderr: "" }),
    );
    await expect(
      recorder.start({
        target: { kind: "pane", session: "work", paneId: "%7" },
      }),
    ).rejects.toMatchObject({ code: "PANE_ALREADY_PIPED" });
  });

  it("names mkfifo when the pipe cannot be created", async () => {
    // POSIX requires it, so this is a stripped container — but "spawn mkfifo
    // ENOENT" tells the user nothing about which half of the feature is gone.
    execFileMock.mockImplementationOnce((_cmd, _args, cb) =>
      // `display-message #{pane_pipe}` — not piped.
      cb(null, { stdout: "0\n", stderr: "" }),
    );
    execFileMock.mockImplementationOnce((_cmd, _args, cb) =>
      cb(new Error("spawn mkfifo ENOENT"), { stdout: "", stderr: "" }),
    );
    await expect(
      recorder.start({
        target: { kind: "pane", session: "work", paneId: "%7" },
      }),
    ).rejects.toMatchObject({ code: "MKFIFO_UNAVAILABLE" });
  });

  it("leaves no index row behind when a start fails", async () => {
    execFileMock.mockImplementationOnce((_cmd, _args, cb) =>
      cb(null, { stdout: "1\n", stderr: "" }),
    );
    await recorder
      .start({ target: { kind: "pane", session: "work", paneId: "%7" } })
      .catch(() => {});
    expect(await index.list()).toEqual([]);
    expect(recorder.listActive()).toEqual([]);
  });
});

describe("assertShellSafePath", () => {
  it("accepts the paths this module generates", () => {
    expect(() =>
      recorder.assertShellSafePath(
        "/home/u/.mtmux/recordings/20260903-174439-work-rec_aaaaaaaaaaaaaaaa.cast",
      ),
    ).not.toThrow();
  });

  it("refuses anything a shell could reinterpret", () => {
    for (const bad of [
      "/tmp/a'b.cast",
      "/tmp/a b.cast",
      "/tmp/$(id).cast",
      "/tmp/a`whoami`.cast",
      "/tmp/a;rm -rf ~.cast",
      "/tmp/a|b.cast",
      "/tmp/a\\b.cast",
      "/tmp/a\nb.cast",
    ]) {
      expect(() => recorder.assertShellSafePath(bad), bad).toThrow(
        /shell command/,
      );
    }
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WebSocket } from "ws";
import type {
  ClientMessage,
  PaneInfo,
  ServerMessage,
  SessionInfo,
  TerminalSize,
  WindowInfo,
} from "@repo/protocol";
import type { ConnectionState } from "./connection-manager.js";
import type { PtyBridge, PtyBridgeOptions } from "./pty-bridge.js";
import { FULL_GRANT } from "./grant.js";

const capturePane = vi.fn<(name: string) => Promise<string>>();
const sessionExists = vi.fn<(name: string) => Promise<boolean>>();
const listSessions = vi.fn<() => Promise<SessionInfo[]>>();
const listPanes = vi.fn<(session: string) => Promise<PaneInfo[]>>();
const listWindows = vi.fn<(session: string) => Promise<WindowInfo[]>>();
const capturePaneById = vi.fn<(id: string) => Promise<string>>();
const createPtyBridge =
  vi.fn<
    (name: string, size?: TerminalSize, opts?: PtyBridgeOptions) => PtyBridge
  >();

vi.mock("./tmux-manager.js", () => ({
  capturePane: (name: string) => capturePane(name),
  sessionExists: (name: string) => sessionExists(name),
  listSessions: () => listSessions(),
  listPanes: (session: string) => listPanes(session),
  listWindows: (session: string) => listWindows(session),
  capturePaneById: (id: string) => capturePaneById(id),
}));

vi.mock("./pty-bridge.js", () => ({
  createPtyBridge: (
    name: string,
    size?: TerminalSize,
    opts?: PtyBridgeOptions,
  ) => createPtyBridge(name, size, opts),
}));

const listDirectory = vi.fn<(path: string) => Promise<unknown[]>>();
vi.mock("./file-service.js", () => ({
  isPathAllowed: () => true,
  listDirectory: (path: string) => listDirectory(path),
  defaultBrowsePath: () => "/home/someone",
}));

const createReadOnlyClone =
  vi.fn<(target: string, grantId: string, connId: string) => Promise<string>>();
vi.mock("./tmux-clone.js", () => ({
  createReadOnlyClone: (target: string, grantId: string, connId: string) =>
    createReadOnlyClone(target, grantId, connId),
  destroyClone: () => Promise.resolve(),
  isCloneSession: (name: string) => name.startsWith("__mtmux_"),
  CLONE_PREFIX: "__mtmux_",
}));

const { routeMessage } = await import("./message-router.js");

/** A PtyBridge stub whose lifecycle callbacks are fired by the test. */
function makeBridge(name: string) {
  const readyCallbacks: (() => void)[] = [];
  const bridge = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    markDetaching: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    onReady: vi.fn((cb: () => void) => {
      readyCallbacks.push(cb);
    }),
    onSpawnError: vi.fn(),
    pid: 1234,
    sessionName: name,
    detaching: false,
    spawnError: null,
  } as unknown as PtyBridge & { resize: ReturnType<typeof vi.fn> };
  return {
    bridge,
    fireReady: () => readyCallbacks.forEach((cb) => cb()),
  };
}

let sent: ServerMessage[];
let conn: ConnectionState;

function makeConn(): ConnectionState {
  const ws = {
    readyState: 1, // WebSocket.OPEN
    bufferedAmount: 0,
    send: (raw: string) => {
      sent.push(JSON.parse(raw) as ServerMessage);
    },
  } as unknown as WebSocket;

  return {
    id: "conn-test",
    ws,
    authenticated: true,
    grant: FULL_GRANT,
    pty: null,
    watchers: new Map(),
    uploads: new Map(),
    rateLimiter: {} as ConnectionState["rateLimiter"],
    label: null,
    connectedAt: Date.now(),
    attachedSession: null,
    lastSize: null,
    cloneSession: null,
    activeWindowId: null,
    remoteAddress: null,
    lastActivityAt: Date.now(),
    closing: false,
    enqueue: () => {},
    drain: async () => {},
  };
}

const route = (msg: ClientMessage) => routeMessage(conn, msg);

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  conn = makeConn();
  sessionExists.mockResolvedValue(true);
  capturePane.mockResolvedValue("REPLAYED SCROLLBACK");
  listSessions.mockResolvedValue([
    session("work", "$1"),
    session("other", "$2"),
  ]);
  listPanes.mockResolvedValue([pane("%1", "@1")]);
  listWindows.mockResolvedValue([window("@1")]);
  capturePaneById.mockResolvedValue("PANE CONTENT");
  listDirectory.mockResolvedValue([]);
  createReadOnlyClone.mockResolvedValue("__mtmux_clone");
});

function session(name: string, id: string): SessionInfo {
  return {
    name,
    id,
    windows: 1,
    attached: false,
    created: new Date(0).toISOString(),
    activity: new Date(0).toISOString(),
  };
}

function pane(id: string, windowId: string): PaneInfo {
  return {
    id,
    index: 0,
    windowId,
    active: true,
    zoomed: false,
    dimensions: { cols: 80, rows: 24 },
    position: { x: 0, y: 0 },
  };
}

function window(id: string): WindowInfo {
  return {
    id,
    index: 0,
    name: "bash",
    active: true,
    paneCount: 1,
    layout: "",
  };
}

describe("session:attach", () => {
  it("acks before replaying the capture", async () => {
    const { bridge, fireReady } = makeBridge("work");
    createPtyBridge.mockReturnValue(bridge);

    await route({ type: "session:attach", name: "work", capture: true });
    fireReady();

    const types = sent.map((m) => m.type);
    expect(types).toEqual(["session:attached", "terminal:output"]);
    // The client drops output until it has seen the ack, so the ordering here
    // is the difference between a painted screen and a blank one.
    expect(types.indexOf("session:attached")).toBeLessThan(
      types.indexOf("terminal:output"),
    );
  });

  it("echoes the attachId so the client can reject stale acks", async () => {
    const { bridge, fireReady } = makeBridge("work");
    createPtyBridge.mockReturnValue(bridge);

    await route({
      type: "session:attach",
      name: "work",
      capture: true,
      attachId: "a7",
    });
    fireReady();

    const ack = sent.find((m) => m.type === "session:attached");
    expect(ack).toMatchObject({ name: "work", attachId: "a7" });
  });

  it("still attaches when the capture fails", async () => {
    const { bridge, fireReady } = makeBridge("huge");
    createPtyBridge.mockReturnValue(bridge);
    capturePane.mockRejectedValue(
      Object.assign(new Error("stdout maxBuffer length exceeded"), {
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      }),
    );

    await route({ type: "session:attach", name: "huge", capture: true });
    fireReady();

    // The old PTY is already dead by the time the capture runs — aborting here
    // is what left large sessions with a permanently blank terminal.
    expect(conn.pty).toBe(bridge);
    expect(conn.attachedSession).toBe("huge");
    expect(sent.map((m) => m.type)).toEqual(["session:attached"]);
  });

  it("leaves no stale attachedSession when the session is gone", async () => {
    const { bridge, fireReady } = makeBridge("old");
    createPtyBridge.mockReturnValue(bridge);
    await route({ type: "session:attach", name: "old", capture: false });
    fireReady();
    expect(conn.attachedSession).toBe("old");

    sent = [];
    sessionExists.mockResolvedValue(false);
    await route({ type: "session:attach", name: "gone", capture: false });

    expect(conn.pty).toBeNull();
    expect(conn.attachedSession).toBeNull();
    expect(sent.map((m) => m.type)).toEqual(["error"]);
  });

  it("leaves no stale attachedSession when the PTY fails to spawn", async () => {
    const { bridge, fireReady } = makeBridge("old");
    createPtyBridge.mockReturnValue(bridge);
    await route({ type: "session:attach", name: "old", capture: false });
    fireReady();

    const dead = makeBridge("broken").bridge as PtyBridge & {
      spawnError: Error | null;
    };
    dead.spawnError = new Error("no pty");
    createPtyBridge.mockReturnValue(dead);
    await route({ type: "session:attach", name: "broken", capture: false });

    expect(conn.pty).toBeNull();
    expect(conn.attachedSession).toBeNull();
  });
});

describe("session:detach", () => {
  it("clears attachedSession even with no live PTY", async () => {
    conn.attachedSession = "orphan";
    conn.pty = null;

    await route({ type: "session:detach" });

    expect(conn.attachedSession).toBeNull();
    expect(conn.lastSize).toBeNull();
  });
});

describe("terminal:resize", () => {
  it("applies a changed size once and drops the repeats", async () => {
    const { bridge, fireReady } = makeBridge("work");
    createPtyBridge.mockReturnValue(bridge);
    await route({
      type: "session:attach",
      name: "work",
      size: { cols: 80, rows: 24 },
      capture: false,
    });
    fireReady();

    const resize = (bridge as unknown as { resize: ReturnType<typeof vi.fn> })
      .resize;

    await route({ type: "terminal:resize", size: { cols: 100, rows: 40 } });
    await route({ type: "terminal:resize", size: { cols: 100, rows: 40 } });
    await route({ type: "terminal:resize", size: { cols: 100, rows: 40 } });

    // Each resize is a SIGWINCH that makes tmux redraw for every attached
    // client, so identical sizes must not reach the PTY.
    expect(resize).toHaveBeenCalledTimes(1);
    expect(resize).toHaveBeenCalledWith({ cols: 100, rows: 40 });

    await route({ type: "terminal:resize", size: { cols: 120, rows: 40 } });
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it("drops a resize that matches the size sent with the attach", async () => {
    const { bridge, fireReady } = makeBridge("work");
    createPtyBridge.mockReturnValue(bridge);
    await route({
      type: "session:attach",
      name: "work",
      size: { cols: 80, rows: 24 },
      capture: false,
    });
    fireReady();

    await route({ type: "terminal:resize", size: { cols: 80, rows: 24 } });

    expect(
      (bridge as unknown as { resize: ReturnType<typeof vi.fn> }).resize,
    ).not.toHaveBeenCalled();
  });
});

/**
 * The scoping regressions.
 *
 * Each of these was a live hole before grants existed, and two of them —
 * `pane:capture` and the file gate — applied to *every* connection, not just
 * shared ones.
 */
describe("scoped grants", () => {
  function scoped(over: Partial<ConnectionState["grant"]> = {}) {
    conn.grant = {
      ...FULL_GRANT,
      id: "grn_share",
      scope: { kind: "sessions", sessions: [{ id: "$1", name: "work" }] },
      files: "none",
      ...over,
    };
  }

  it("refuses to capture a pane outside the attached session", async () => {
    // Finding #2. `capturePaneById("%9")` passed the id straight to tmux,
    // which resolves pane ids server-wide — so any pane's scrollback on the
    // machine came back, and `attachedSession` was never a boundary at all.
    const { bridge, fireReady } = makeBridge("work");
    createPtyBridge.mockReturnValue(bridge);
    await route({ type: "session:attach", name: "work", capture: false });
    fireReady();
    sent.length = 0;

    // listPanes only ever reports %1 for this session.
    await route({ type: "pane:capture", id: "%9" });

    expect(capturePaneById).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ type: "error", code: "PANE_NOT_FOUND" });
  });

  it("still captures a pane that does belong to the session", async () => {
    const { bridge, fireReady } = makeBridge("work");
    createPtyBridge.mockReturnValue(bridge);
    await route({ type: "session:attach", name: "work", capture: false });
    fireReady();
    sent.length = 0;

    await route({ type: "pane:capture", id: "%1" });

    expect(capturePaneById).toHaveBeenCalledWith("%1");
    expect(sent[0]).toMatchObject({ type: "pane:captured", id: "%1" });
  });

  it("hides out-of-scope sessions from the list rather than erroring", async () => {
    scoped();
    await route({ type: "session:list" });

    const list = sent.find((m) => m.type === "session:list") as {
      sessions: SessionInfo[];
    };
    expect(list.sessions.map((s) => s.name)).toEqual(["work"]);
  });

  it("answers SESSION_NOT_FOUND for an out-of-scope attach", async () => {
    // Not "denied". A scoped holder who could tell those two apart could
    // enumerate every session name on the machine by probing.
    scoped();
    await route({ type: "session:attach", name: "other", capture: false });

    expect(createPtyBridge).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({
      type: "error",
      code: "SESSION_NOT_FOUND",
    });
  });

  it("never calls the file service when files are off", async () => {
    scoped();
    await route({ type: "file:list", path: "/home/someone" });

    expect(listDirectory).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ type: "error", code: "ACCESS_DENIED" });
  });

  it("never writes to the PTY on a read-only grant", async () => {
    scoped({ readOnly: true });
    const { bridge, fireReady } = makeBridge("work");
    createPtyBridge.mockReturnValue(bridge);
    await route({ type: "session:attach", name: "work", capture: false });
    fireReady();

    await route({ type: "terminal:input", data: "rm -rf ~\r" });

    expect(
      (bridge as unknown as { write: ReturnType<typeof vi.fn> }).write,
    ).not.toHaveBeenCalled();
  });

  it("attaches a read-only grant through a locked-down clone", async () => {
    // Never `attach-session -r` against the target itself: under -r tmux
    // still honours switch-client, and ( / ) are bound to it by default.
    scoped({ readOnly: true });
    const { bridge, fireReady } = makeBridge("work");
    createPtyBridge.mockReturnValue(bridge);

    await route({ type: "session:attach", name: "work", capture: false });
    fireReady();

    expect(createReadOnlyClone).toHaveBeenCalledWith(
      "work",
      "grn_share",
      "conn-test",
    );
    const [target, , opts] = createPtyBridge.mock.calls[0]!;
    expect(target).toBe("__mtmux_clone");
    expect(opts).toMatchObject({ readOnly: true });
    // The *real* name is what scope checks and broadcasts compare against.
    expect(conn.attachedSession).toBe("work");
  });

  it("refuses a second auth frame instead of rubber-stamping it", async () => {
    // Finding #1's other half. This used to answer auth:success without
    // checking anything, because the tunnel agent had already authenticated
    // the socket with the machine's full token.
    await route({ type: "auth", token: "anything at all" });
    expect(sent[0]).toMatchObject({ type: "error" });
    expect(sent[0]).not.toMatchObject({ type: "auth:success" });
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WebSocket } from "ws";
import type {
  ClientMessage,
  ServerMessage,
  TerminalSize,
} from "@repo/protocol";
import type { ConnectionState } from "./connection-manager.js";
import type { PtyBridge } from "./pty-bridge.js";

const capturePane = vi.fn<(name: string) => Promise<string>>();
const sessionExists = vi.fn<(name: string) => Promise<boolean>>();
const createPtyBridge =
  vi.fn<(name: string, size?: TerminalSize) => PtyBridge>();

vi.mock("./tmux-manager.js", () => ({
  capturePane: (name: string) => capturePane(name),
  sessionExists: (name: string) => sessionExists(name),
}));

vi.mock("./pty-bridge.js", () => ({
  createPtyBridge: (name: string, size?: TerminalSize) =>
    createPtyBridge(name, size),
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
    pty: null,
    watchers: new Map(),
    uploads: new Map(),
    rateLimiter: {} as ConnectionState["rateLimiter"],
    attachedSession: null,
    lastSize: null,
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
});

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

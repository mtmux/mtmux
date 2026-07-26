import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createLogger } from "@repo/logger";
import type { SessionInfo, PaneInfo, WindowInfo } from "@repo/protocol";
import { config } from "./config.js";

const execFileAsyncRaw = promisify(execFile);
const logger = createLogger("relay:tmux");

const TMUX_TIMEOUT = 10_000;

// Node's default stdout cap for execFile is 1 MiB, and exceeding it rejects with
// ERR_CHILD_PROCESS_STDIO_MAXBUFFER instead of truncating. A pane capture on a
// host with a large `history-limit` blows straight past that (32 MB observed),
// which used to abort session attach entirely. Captures are bounded below, so
// this is only a backstop — but it applies to every tmux call, and list-sessions
// on a very busy server can get large too.
const TMUX_MAX_BUFFER = 16 * 1024 * 1024;

// Default number of scrollback lines replayed to a client on attach. Enough to
// fill any realistic viewport plus scroll history, small enough to send and
// render in one paint.
const DEFAULT_CAPTURE_LINES = 2000;

export interface CaptureOptions {
  /** Scrollback lines to include, counting back from the bottom. */
  lines?: number;
  /** Include SGR escape sequences so colours survive the replay. */
  escapes?: boolean;
}

function execFileAsync(cmd: string, args: string[]) {
  return execFileAsyncRaw(cmd, args, {
    timeout: TMUX_TIMEOUT,
    maxBuffer: TMUX_MAX_BUFFER,
  });
}

/** Shared argv builder for the two capture-pane entry points. */
function captureArgs(
  target: string,
  lines: number,
  escapes: boolean,
): string[] {
  return [
    ...tmuxArgs(),
    "capture-pane",
    "-t",
    target,
    "-p",
    ...(escapes ? ["-e"] : []),
    "-S",
    `-${lines}`,
  ];
}

function tmuxArgs(): string[] {
  return config.tmuxSocket ? ["-S", config.tmuxSocket] : [];
}

export async function listSessions(): Promise<SessionInfo[]> {
  try {
    const { stdout } = await execFileAsync("tmux", [
      ...tmuxArgs(),
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_id}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}\t#{window_width}\t#{window_height}",
    ]);

    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, id, windows, attached, created, activity, width, height] =
          line.split("\t");
        return {
          name: name!,
          id: id!,
          windows: parseInt(windows!, 10),
          attached: attached === "1",
          created: new Date(parseInt(created!, 10) * 1000).toISOString(),
          activity: new Date(parseInt(activity!, 10) * 1000).toISOString(),
          dimensions:
            width && height
              ? { cols: parseInt(width, 10), rows: parseInt(height, 10) }
              : undefined,
        };
      });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("no server running") || msg.includes("no sessions")) {
      return [];
    }
    logger.error({ err: e }, "Failed to list sessions");
    throw e;
  }
}

export async function createSession(
  name?: string,
  cwd?: string,
  command?: string,
): Promise<SessionInfo> {
  const args = [
    ...tmuxArgs(),
    "new-session",
    "-d",
    "-P",
    "-F",
    "#{session_name}\t#{session_id}",
  ];

  if (name) args.push("-s", name);
  if (cwd) args.push("-c", cwd);
  if (command) {
    args.push(command);
  } else {
    args.push(config.tmuxDefaultShell);
  }

  const { stdout } = await execFileAsync("tmux", args);
  const [sessionName, sessionId] = stdout.trim().split("\t");

  logger.info({ sessionName }, "Created session");

  return {
    name: sessionName!,
    id: sessionId!,
    windows: 1,
    attached: false,
    created: new Date().toISOString(),
    activity: new Date().toISOString(),
  };
}

export async function killSession(name: string): Promise<void> {
  await execFileAsync("tmux", [...tmuxArgs(), "kill-session", "-t", name]);
  logger.info({ name }, "Killed session");
}

export async function renameSession(
  oldName: string,
  newName: string,
): Promise<void> {
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "rename-session",
    "-t",
    oldName,
    newName,
  ]);
  logger.info({ oldName, newName }, "Renamed session");
}

export async function sessionExists(name: string): Promise<boolean> {
  try {
    await execFileAsync("tmux", [...tmuxArgs(), "has-session", "-t", name]);
    return true;
  } catch {
    return false;
  }
}

export async function sendKeys(session: string, keys: string): Promise<void> {
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "send-keys",
    "-t",
    session,
    keys,
    "Enter",
  ]);
}

export async function sendInterrupt(session: string): Promise<void> {
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "send-keys",
    "-t",
    session,
    "C-c",
  ]);
}

/**
 * Capture a session's visible pane plus bounded scrollback, for replay into a
 * freshly attached client. Colours are kept — this is written straight into
 * xterm.js.
 */
export async function capturePane(
  session: string,
  opts: CaptureOptions = {},
): Promise<string> {
  const { stdout } = await execFileAsync(
    "tmux",
    captureArgs(
      session,
      opts.lines ?? DEFAULT_CAPTURE_LINES,
      opts.escapes ?? true,
    ),
  );
  return stdout;
}

export async function listWindows(session: string): Promise<WindowInfo[]> {
  try {
    const { stdout } = await execFileAsync("tmux", [
      ...tmuxArgs(),
      "list-windows",
      "-t",
      session,
      "-F",
      "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{window_layout}\t#{window_width}\t#{window_height}",
    ]);

    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, index, name, active, paneCount, layout, width, height] =
          line.split("\t");
        return {
          id: id!,
          index: parseInt(index!, 10),
          name: name!,
          active: active === "1",
          paneCount: parseInt(paneCount!, 10),
          layout: layout!,
          dimensions:
            width && height
              ? { cols: parseInt(width, 10), rows: parseInt(height, 10) }
              : undefined,
        };
      });
  } catch (e) {
    logger.error({ err: e }, "Failed to list windows");
    throw e;
  }
}

export async function listPanes(
  session: string,
  windowId?: string,
): Promise<PaneInfo[]> {
  try {
    const args = [...tmuxArgs(), "list-panes"];
    if (windowId) {
      args.push("-t", `${session}:${windowId}`);
    } else {
      // -s = list all panes across all windows in the session
      args.push("-s", "-t", session);
    }
    args.push(
      "-F",
      "#{pane_id}\t#{pane_index}\t#{window_id}\t#{pane_active}\t#{window_zoomed_flag}\t#{pane_width}\t#{pane_height}\t#{pane_left}\t#{pane_top}\t#{pane_current_command}\t#{pane_current_path}",
    );
    const { stdout } = await execFileAsync("tmux", args);

    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [
          id,
          index,
          winId,
          active,
          zoomed,
          width,
          height,
          left,
          top,
          command,
          path,
        ] = line.split("\t");
        return {
          id: id!,
          index: parseInt(index!, 10),
          windowId: winId!,
          active: active === "1",
          zoomed: zoomed === "1",
          dimensions: {
            cols: parseInt(width!, 10),
            rows: parseInt(height!, 10),
          },
          position: {
            x: parseInt(left!, 10),
            y: parseInt(top!, 10),
          },
          command: command || undefined,
          path: path || undefined,
        };
      });
  } catch (e) {
    logger.error({ err: e }, "Failed to list panes");
    throw e;
  }
}

/**
 * Capture a single pane by id, for the copy-mode overlay. Escapes are OFF by
 * default here: this content is shown as selectable plain text and copied to
 * the clipboard, so SGR sequences would be pasted verbatim.
 */
export async function capturePaneById(
  paneId: string,
  opts: CaptureOptions = {},
): Promise<string> {
  const { stdout } = await execFileAsync(
    "tmux",
    captureArgs(
      paneId,
      opts.lines ?? DEFAULT_CAPTURE_LINES,
      opts.escapes ?? false,
    ),
  );
  return stdout;
}

export async function splitPane(
  session: string,
  direction: "h" | "v",
): Promise<void> {
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "split-window",
    "-t",
    session,
    `-${direction}`,
  ]);
  logger.info({ session, direction }, "Split pane");
}

export async function selectPane(paneId: string): Promise<void> {
  await execFileAsync("tmux", [...tmuxArgs(), "select-pane", "-t", paneId]);
  logger.info({ paneId }, "Selected pane");
}

export async function zoomPane(session: string): Promise<void> {
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "resize-pane",
    "-t",
    session,
    "-Z",
  ]);
  logger.info({ session }, "Toggled pane zoom");
}

export async function resizePane(
  paneId: string,
  direction: "U" | "D" | "L" | "R",
  amount: number,
): Promise<void> {
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "resize-pane",
    "-t",
    paneId,
    `-${direction}`,
    String(amount),
  ]);
  logger.info({ paneId, direction, amount }, "Resized pane");
}

export async function killPane(paneId: string): Promise<void> {
  await execFileAsync("tmux", [...tmuxArgs(), "kill-pane", "-t", paneId]);
  logger.info({ paneId }, "Killed pane");
}

export async function createWindow(
  session: string,
  name?: string,
): Promise<void> {
  const args = [...tmuxArgs(), "new-window", "-t", session];
  if (name) args.push("-n", name);
  args.push(config.tmuxDefaultShell);
  await execFileAsync("tmux", args);
  logger.info({ session, name }, "Created window");
}

export async function selectWindow(windowId: string): Promise<void> {
  await execFileAsync("tmux", [...tmuxArgs(), "select-window", "-t", windowId]);
  logger.info({ windowId }, "Selected window");
}

export async function killWindow(windowId: string): Promise<void> {
  await execFileAsync("tmux", [...tmuxArgs(), "kill-window", "-t", windowId]);
  logger.info({ windowId }, "Killed window");
}

export async function swapPane(
  paneId: string,
  direction: "U" | "D" | "L" | "R",
): Promise<void> {
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "swap-pane",
    "-t",
    paneId,
    `-${direction}`,
  ]);
  logger.info({ paneId, direction }, "Swapped pane");
}

export async function renameWindow(
  windowId: string,
  name: string,
): Promise<void> {
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "rename-window",
    "-t",
    windowId,
    name,
  ]);
  logger.info({ windowId, name }, "Renamed window");
}

export async function selectLayout(
  session: string,
  preset: string,
): Promise<void> {
  await execFileAsync("tmux", [
    ...tmuxArgs(),
    "select-layout",
    "-t",
    session,
    preset,
  ]);
  logger.info({ session, preset }, "Selected layout");
}

export async function rotateLayout(session: string): Promise<void> {
  await execFileAsync("tmux", [...tmuxArgs(), "rotate-window", "-t", session]);
  logger.info({ session }, "Rotated layout");
}

export async function sendPrefix(session: string): Promise<void> {
  await execFileAsync("tmux", [...tmuxArgs(), "send-prefix", "-t", session]);
  logger.info({ session }, "Sent prefix");
}

export async function enterCopyMode(session: string): Promise<void> {
  await execFileAsync("tmux", [...tmuxArgs(), "copy-mode", "-t", session]);
  logger.info({ session }, "Entered copy mode");
}

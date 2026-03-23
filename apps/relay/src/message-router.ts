import type { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "@repo/protocol";
import { createLogger } from "@repo/logger";
import { sendJson } from "./ws-server.js";
import type { ConnectionState } from "./connection-manager.js";
import { broadcastToAll } from "./connection-manager.js";
import { createPtyBridge } from "./pty-bridge.js";
import * as tmux from "./tmux-manager.js";
import * as files from "./file-service.js";
import { config } from "./config.js";

const logger = createLogger("relay:router");

function send(ws: WebSocket, msg: ServerMessage): void {
  sendJson(ws, msg);
}

function sendError(ws: WebSocket, code: string, message: string): void {
  send(ws, { type: "error", code, message });
}

export async function routeMessage(
  conn: ConnectionState,
  msg: ClientMessage,
): Promise<void> {
  const { ws } = conn;

  try {
    switch (msg.type) {
      case "ping":
        send(ws, { type: "pong", timestamp: msg.timestamp });
        break;

      case "session:list": {
        const sessions = await tmux.listSessions();
        send(ws, { type: "session:list", sessions });
        break;
      }

      case "session:create": {
        const session = await tmux.createSession(msg.name, msg.cwd, msg.command);
        send(ws, { type: "session:created", session });
        broadcastToAll({ type: "session:created", session }, ws);
        break;
      }

      case "session:attach": {
        // Detach existing PTY first
        if (conn.pty) {
          conn.pty.markDetaching();
          try { conn.pty.kill(); } catch { /* ignore */ }
          conn.pty = null;
        }

        const exists = await tmux.sessionExists(msg.name);
        if (!exists) {
          sendError(ws, "SESSION_NOT_FOUND", `Session "${msg.name}" not found`);
          break;
        }

        // Capture pane content BEFORE creating PTY bridge
        let captured: string | null = null;
        if (msg.capture) {
          captured = await tmux.capturePane(msg.name);
        }

        const bridge = createPtyBridge(msg.name, msg.size);
        conn.pty = bridge;
        conn.attachedSession = msg.name;

        bridge.onData((data) => {
          send(ws, { type: "terminal:output", data });
        });

        bridge.onExit((exitCode) => {
          send(ws, { type: "session:exited", name: msg.name, exitCode });
          conn.pty = null;
          conn.attachedSession = null;
        });

        // When PTY is ready: send captured data first, then attached ack
        bridge.onReady(() => {
          if (captured) {
            send(ws, { type: "terminal:output", data: captured });
          }
          send(ws, { type: "session:attached", name: msg.name });
        });

        break;
      }

      case "session:detach": {
        if (conn.pty) {
          conn.pty.markDetaching();
          try { conn.pty.kill(); } catch { /* ignore */ }
          conn.pty = null;
          conn.attachedSession = null;
        }
        break;
      }

      case "session:kill": {
        await tmux.killSession(msg.name);
        send(ws, { type: "session:killed", name: msg.name });
        broadcastToAll({ type: "session:killed", name: msg.name }, ws);
        break;
      }

      case "session:rename": {
        const renameExists = await tmux.sessionExists(msg.oldName);
        if (!renameExists) {
          sendError(ws, "SESSION_NOT_FOUND", `Session "${msg.oldName}" not found`);
          break;
        }
        await tmux.renameSession(msg.oldName, msg.newName);
        const sessions = await tmux.listSessions();
        send(ws, { type: "session:list", sessions });
        broadcastToAll({ type: "session:list", sessions }, ws);
        break;
      }

      case "terminal:input": {
        if (!conn.pty) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        conn.pty.write(msg.data);
        break;
      }

      case "terminal:resize": {
        if (!conn.pty) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        conn.pty.resize(msg.size);
        break;
      }

      case "command:send": {
        if (!conn.pty) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        conn.pty.write(msg.command + "\r");
        break;
      }

      case "command:interrupt": {
        if (conn.attachedSession) {
          await tmux.sendInterrupt(conn.attachedSession);
        }
        break;
      }

      case "command:eof": {
        if (conn.pty) {
          conn.pty.write("\x04"); // Ctrl+D
        }
        break;
      }

      case "command:clear": {
        if (conn.pty) {
          conn.pty.write("\x1b[2J\x1b[H"); // Clear screen
        }
        break;
      }

      case "command:suspend": {
        if (conn.pty) {
          conn.pty.write("\x1a"); // Ctrl+Z
        }
        break;
      }

      case "file:list": {
        if (!files.isPathAllowed(msg.path)) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        const entries = await files.listDirectory(msg.path);
        send(ws, { type: "file:list", path: msg.path, entries });
        break;
      }

      case "file:read": {
        if (!files.isPathAllowed(msg.path)) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        const { content, truncated } = await files.readFile(msg.path);
        send(ws, { type: "file:content", path: msg.path, content, truncated });
        break;
      }

      case "file:stat": {
        if (!files.isPathAllowed(msg.path)) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        const stat = await files.getStats(msg.path);
        send(ws, { type: "file:stat", stat });
        break;
      }

      case "file:watch": {
        if (!files.isPathAllowed(msg.path)) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        if (conn.watchers.has(msg.path)) break;

        try {
          const watcher = files.watchDirectory(msg.path, (event, filePath) => {
            send(ws, { type: "file:changed", path: filePath, event });
          });
          conn.watchers.set(msg.path, watcher);
        } catch (e) {
          sendError(ws, "WATCH_FAILED", e instanceof Error ? e.message : "Failed to watch path");
        }
        break;
      }

      case "file:unwatch": {
        const watcher = conn.watchers.get(msg.path);
        if (watcher) {
          watcher.close();
          conn.watchers.delete(msg.path);
        }
        break;
      }

      case "file:write": {
        if (!files.isPathAllowed(msg.path)) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        try {
          const { size } = await files.writeFile(msg.path, msg.content);
          send(ws, { type: "file:write:result", path: msg.path, success: true, size });
        } catch (e) {
          send(ws, { type: "file:write:result", path: msg.path, success: false, error: e instanceof Error ? e.message : "Write failed" });
        }
        break;
      }

      case "file:create": {
        if (!files.isPathAllowed(msg.path)) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        try {
          await files.createFile(msg.path, msg.content);
          send(ws, { type: "file:op:result", op: "create", path: msg.path, success: true });
        } catch (e) {
          send(ws, { type: "file:op:result", op: "create", path: msg.path, success: false, error: e instanceof Error ? e.message : "Create failed" });
        }
        break;
      }

      case "file:mkdir": {
        if (!files.isPathAllowed(msg.path)) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        try {
          await files.mkdir(msg.path);
          send(ws, { type: "file:op:result", op: "mkdir", path: msg.path, success: true });
        } catch (e) {
          send(ws, { type: "file:op:result", op: "mkdir", path: msg.path, success: false, error: e instanceof Error ? e.message : "Mkdir failed" });
        }
        break;
      }

      case "file:delete": {
        if (!files.isPathAllowed(msg.path)) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        try {
          await files.deleteFile(msg.path);
          send(ws, { type: "file:op:result", op: "delete", path: msg.path, success: true });
        } catch (e) {
          send(ws, { type: "file:op:result", op: "delete", path: msg.path, success: false, error: e instanceof Error ? e.message : "Delete failed" });
        }
        break;
      }

      case "file:rename": {
        if (!files.isPathAllowed(msg.oldPath) || !files.isPathAllowed(msg.newPath)) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        try {
          await files.renameFile(msg.oldPath, msg.newPath);
          send(ws, { type: "file:op:result", op: "rename", path: msg.newPath, success: true });
        } catch (e) {
          send(ws, { type: "file:op:result", op: "rename", path: msg.newPath, success: false, error: e instanceof Error ? e.message : "Rename failed" });
        }
        break;
      }

      case "file:upload": {
        if (!files.isPathAllowed(msg.path)) {
          sendError(ws, "ACCESS_DENIED", "Path outside allowed directories");
          break;
        }
        try {
          await files.handleUpload(msg.path, msg.content, msg.final);
          if (msg.final) {
            send(ws, { type: "file:op:result", op: "upload", path: msg.path, success: true });
          }
        } catch (e) {
          send(ws, { type: "file:op:result", op: "upload", path: msg.path, success: false, error: e instanceof Error ? e.message : "Upload failed" });
        }
        break;
      }

      case "pane:list": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        const panes = await tmux.listPanes(conn.attachedSession);
        const activeWin = panes.find((p) => p.active)?.windowId ?? "";
        send(ws, { type: "pane:list", panes, windowId: activeWin });
        break;
      }

      case "pane:split": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.splitPane(conn.attachedSession, msg.direction);
        const splitPanes = await tmux.listPanes(conn.attachedSession);
        const splitWinId = splitPanes.find((p) => p.active)?.windowId ?? "";
        send(ws, { type: "pane:changed", panes: splitPanes, windowId: splitWinId });
        break;
      }

      case "pane:select": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.selectPane(msg.id);
        const selectPanes = await tmux.listPanes(conn.attachedSession);
        const selectWinId = selectPanes.find((p) => p.active)?.windowId ?? "";
        send(ws, { type: "pane:changed", panes: selectPanes, windowId: selectWinId });
        break;
      }

      case "pane:zoom": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.zoomPane(conn.attachedSession);
        const zoomPanes = await tmux.listPanes(conn.attachedSession);
        const zoomWinId = zoomPanes.find((p) => p.active)?.windowId ?? "";
        send(ws, { type: "pane:changed", panes: zoomPanes, windowId: zoomWinId });
        break;
      }

      case "pane:resize": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.resizePane(msg.id, msg.direction, msg.amount);
        const resizePanes = await tmux.listPanes(conn.attachedSession);
        const resizeWinId = resizePanes.find((p) => p.active)?.windowId ?? "";
        send(ws, { type: "pane:changed", panes: resizePanes, windowId: resizeWinId });
        break;
      }

      case "pane:kill": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.killPane(msg.id);
        const killPanePanes = await tmux.listPanes(conn.attachedSession);
        const killPaneWinId = killPanePanes.find((p) => p.active)?.windowId ?? "";
        send(ws, { type: "pane:changed", panes: killPanePanes, windowId: killPaneWinId });
        const killPaneWindows = await tmux.listWindows(conn.attachedSession);
        send(ws, { type: "window:changed", windows: killPaneWindows, sessionName: conn.attachedSession });
        break;
      }

      case "window:list": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        const windows = await tmux.listWindows(conn.attachedSession);
        send(ws, { type: "window:list", windows, sessionName: conn.attachedSession });
        break;
      }

      case "window:create": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.createWindow(conn.attachedSession, msg.name);
        const createWinWindows = await tmux.listWindows(conn.attachedSession);
        send(ws, { type: "window:changed", windows: createWinWindows, sessionName: conn.attachedSession });
        break;
      }

      case "window:select": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.selectWindow(msg.id);
        conn.activeWindowId = msg.id;
        const selectWinWindows = await tmux.listWindows(conn.attachedSession);
        send(ws, { type: "window:changed", windows: selectWinWindows, sessionName: conn.attachedSession });
        const selectWinPanes = await tmux.listPanes(conn.attachedSession);
        const selWinId = selectWinPanes.find((p) => p.active)?.windowId ?? "";
        send(ws, { type: "pane:changed", panes: selectWinPanes, windowId: selWinId });
        break;
      }

      case "window:kill": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        const killedId = msg.id;
        await tmux.killWindow(killedId);
        const killWinWindows = await tmux.listWindows(conn.attachedSession);
        send(ws, { type: "window:changed", windows: killWinWindows, sessionName: conn.attachedSession });
        // Reset stale activeWindowId
        if (conn.activeWindowId === killedId) {
          const activeWin = killWinWindows.find((w) => w.active);
          conn.activeWindowId = activeWin?.id ?? null;
        }
        const killWinPanes = await tmux.listPanes(conn.attachedSession);
        const killWinWinId = killWinPanes.find((p) => p.active)?.windowId ?? "";
        send(ws, { type: "pane:changed", panes: killWinPanes, windowId: killWinWinId });
        break;
      }

      case "pane:swap": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.swapPane(msg.id, msg.direction);
        const swapPanes = await tmux.listPanes(conn.attachedSession);
        const swapWinId = swapPanes.find((p) => p.active)?.windowId ?? "";
        send(ws, { type: "pane:changed", panes: swapPanes, windowId: swapWinId });
        break;
      }

      case "window:rename": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.renameWindow(msg.id, msg.name);
        const renameWinWindows = await tmux.listWindows(conn.attachedSession);
        send(ws, { type: "window:changed", windows: renameWinWindows, sessionName: conn.attachedSession });
        break;
      }

      case "window:layout": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.selectLayout(conn.attachedSession, msg.preset);
        const layoutPanes = await tmux.listPanes(conn.attachedSession);
        const layoutWinId = layoutPanes.find((p) => p.active)?.windowId ?? "";
        send(ws, { type: "pane:changed", panes: layoutPanes, windowId: layoutWinId });
        break;
      }

      case "layout:rotate": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.rotateLayout(conn.attachedSession);
        const rotatePanes = await tmux.listPanes(conn.attachedSession);
        const rotateWinId = rotatePanes.find((p) => p.active)?.windowId ?? "";
        send(ws, { type: "pane:changed", panes: rotatePanes, windowId: rotateWinId });
        break;
      }

      case "tmux:prefix": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.sendPrefix(conn.attachedSession);
        break;
      }

      case "tmux:copy-mode": {
        if (!conn.attachedSession) {
          sendError(ws, "NOT_ATTACHED", "No session attached");
          break;
        }
        await tmux.enterCopyMode(conn.attachedSession);
        break;
      }

      case "auth":
        // Auth is handled before routing
        break;

      default: {
        const _exhaustive: never = msg;
        sendError(ws, "UNKNOWN_MESSAGE", `Unknown message type`);
      }
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Internal error";
    logger.error({ err: e, type: msg.type }, "Message handler error");
    sendError(ws, "HANDLER_ERROR", errMsg);
  }
}

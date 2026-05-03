"use client";

import { useEffect, useRef, useCallback } from "react";
import type { ClientMessage, ServerMessage } from "@repo/protocol";
import { RelayClient } from "@/lib/ws-client";
import { useConnectionStore } from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";
import { usePaneStore } from "@/stores/pane-store";
import { useFileStore } from "@/stores/file-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useAlertStore } from "@/stores/alert-store";
import { useUiStore } from "@/stores/ui-store";

let globalClient: RelayClient | null = null;

// #1: Dedup session exit toasts — track handled exits at module scope
const handledExits = new Set<string>();

export function getRelayClient(): RelayClient | null {
  return globalClient;
}

export function useWebSocket(url: string, token: string) {
  const clientRef = useRef<RelayClient | null>(null);

  useEffect(() => {
    if (!url || !token) return;

    const handleMessage = (msg: ServerMessage) => {
      const sessionStore = useSessionStore.getState();
      const connectionStore = useConnectionStore.getState();

      switch (msg.type) {
        case "auth:success":
          connectionStore.setServerInfo(msg.serverVersion, "");
          connectionStore.resetReconnect();
          // Auto-request session list on connect
          globalClient?.send({ type: "session:list" });
          // Don't send session:attach here — terminal-view handles re-attachment
          // via its own auth:success listener to avoid duplicate PTY bridges
          break;
        case "auth:failure":
          useAlertStore.getState().push("error", msg.reason || "Authentication failed");
          localStorage.removeItem("ccremote-token");
          window.location.href = "/login";
          break;
        case "server:info":
          connectionStore.setServerInfo("", msg.hostname);
          break;
        case "pong":
          connectionStore.setLatency(Date.now() - msg.timestamp);
          break;
        case "session:list":
          sessionStore.setSessions(msg.sessions);
          break;
        case "session:created":
          sessionStore.addSession(msg.session);
          break;
        case "session:killed":
          sessionStore.removeSession(msg.name);
          break;
        case "session:activity":
          sessionStore.updateSessionActivity(msg.name, msg.activity);
          break;
        case "session:exited":
          // #1: Deduplicate exit toasts — skip if already handled
          if (!handledExits.has(msg.name)) {
            handledExits.add(msg.name);
            sessionStore.removeSession(msg.name);
            // Clear pane/zoom state if this was the active session
            if (sessionStore.activeSessionId === null) {
              usePaneStore.getState().clearAll();
            }
            useAlertStore.getState().push("info", `Session "${msg.name}" exited`);
            setTimeout(() => handledExits.delete(msg.name), 10000);
          }
          break;
        case "pane:list":
        case "pane:changed": {
          const paneStore = usePaneStore.getState();
          paneStore.setPanes(msg.panes, msg.windowId);
          // Auto-zoom: if pending and no pane is currently zoomed, zoom the active pane
          if (paneStore.pendingAutoZoom) {
            const zoomedPane = msg.panes.find((p) => p.zoomed);
            if (!zoomedPane && window.matchMedia("(max-width: 768px)").matches) {
              globalClient?.send({ type: "pane:zoom" });
            }
            paneStore.setPendingAutoZoom(false);
          }
          break;
        }
        case "window:list":
        case "window:changed": {
          const paneStore = usePaneStore.getState();
          paneStore.setWindows(msg.windows);
          break;
        }
        case "file:write:result":
          // Handled in file-editor component via onMessage subscription
          break;
        case "file:op:result": {
          useFileStore.getState().setIsOperating(false);
          if (msg.success) {
            useAlertStore.getState().push("success", `${msg.op} succeeded: ${msg.path.split("/").pop()}`);
            // Refresh current directory listing
            const { currentPath: dirPath } = useFileStore.getState();
            globalClient?.send({ type: "file:list", path: dirPath });
          } else {
            useAlertStore.getState().push("error", msg.error ?? `${msg.op} failed`);
          }
          break;
        }
        case "session:attached":
          // Handled in terminal-view
          break;
        case "pane:captured":
          useUiStore.getState().setCapturedPane(msg.id, msg.content);
          break;
        case "session:windows":
          // Handled by SessionCard via direct onMessage subscription
          break;
        case "error":
          useAlertStore.getState().push("error", msg.message);
          break;
      }
    };

    const client = new RelayClient({
      url,
      token,
      onMessage: handleMessage,
      onMessageDropped: (count) => {
        useAlertStore.getState().push("warning", `${count} messages queued while disconnected — some may have been dropped`);
      },
      onStatusChange: (status) => {
        useConnectionStore.getState().setStatus(status);
        if (status === "reconnecting") {
          useConnectionStore.getState().incrementReconnect();
        }
      },
    });

    clientRef.current = client;
    globalClient = client;
    client.connect();

    const handleOnline = () => {
      if (client.status === "disconnected" || client.status === "reconnecting") {
        client.connect();
      }
    };

    const handleOffline = () => {
      useConnectionStore.getState().setStatus("disconnected");
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      client.disconnect();
      globalClient = null;
    };
  }, [url, token]);

  const send = useCallback((msg: ClientMessage) => {
    clientRef.current?.send(msg);
  }, []);

  return { send, client: clientRef.current };
}

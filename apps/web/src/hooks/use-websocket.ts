"use client";

import { useEffect, useRef, useCallback } from "react";
import type { DependencyList } from "react";
import type { ClientMessage, ServerMessage } from "@repo/protocol";
import { RelayClient } from "@/lib/ws-client";
import type { TransportFactory } from "@/lib/transport";
import { useConnectionStore } from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";
import { usePaneStore } from "@/stores/pane-store";
import { useFileStore } from "@/stores/file-store";
import { useAlertStore } from "@/stores/alert-store";
import { useUiStore } from "@/stores/ui-store";

let globalClient: RelayClient | null = null;

// #1: Dedup session exit toasts — track handled exits at module scope
const handledExits = new Set<string>();

export function getRelayClient(): RelayClient | null {
  return globalClient;
}

/**
 * Subscribe to relay messages, re-attaching whenever the connection status
 * changes. This binds once the client exists (it's created asynchronously by
 * the layout's `useWebSocket` effect, so it's null on first child mount) and
 * re-binds on a new socket after a reconnect. The latest `handler` is kept in a
 * ref so the subscription stays stable and doesn't churn on every render.
 */
export function useRelaySubscription(
  handler: (msg: ServerMessage) => void,
  deps: DependencyList = [],
): void {
  const status = useConnectionStore((s) => s.status);
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const client = getRelayClient();
    if (!client) return;
    return client.onMessage((msg) => ref.current(msg));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, ...deps]);
}

/**
 * Return the current relay client and subscribe the caller to the connection
 * status so the component re-renders (and its client-dependent effects re-run)
 * once the client attaches or reconnects. Use this for "send an initial request
 * when connected" needs, e.g. the file tree's directory load.
 */
export function useRelayClient(): RelayClient | null {
  useConnectionStore((s) => s.status); // re-render when the client attaches / reconnects
  return getRelayClient();
}

/**
 * @param transport Optional socket seam. Omitted for the direct and
 * self-hosted paths, which use a plain WebSocket at `url`; supplied by the
 * terminal layout when a paired session fell back to the sealed tunnel.
 */
export function useWebSocket(
  url: string,
  token: string,
  transport?: TransportFactory,
) {
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
          // Don't send session:attach here. TerminalView re-attaches from its
          // status-dependent effect, which guarantees exactly one attach per
          // connection — a second one would kill and respawn the PTY.
          break;
        case "auth:failure":
          useAlertStore
            .getState()
            .push("error", msg.reason || "Authentication failed");
          localStorage.removeItem("ccremote-token");
          window.location.href = "/login";
          break;
        case "server:info":
          connectionStore.setServerInfo("", msg.hostname);
          // Open the file browser to the relay's primary allowed directory so
          // it lists successfully out of the box (the hardcoded "/home" default
          // is outside the allow-list when the CLI scopes it to $HOME).
          if (msg.defaultPath) {
            useFileStore.getState().applyServerDefaultPath(msg.defaultPath);
          }
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
            useAlertStore
              .getState()
              .push("info", `Session "${msg.name}" exited`);
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
            if (
              !zoomedPane &&
              window.matchMedia("(max-width: 768px)").matches
            ) {
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
            useAlertStore
              .getState()
              .push(
                "success",
                `${msg.op} succeeded: ${msg.path.split("/").pop()}`,
              );
            // Refresh current directory listing
            const { currentPath: dirPath } = useFileStore.getState();
            globalClient?.send({ type: "file:list", path: dirPath });
          } else {
            useAlertStore
              .getState()
              .push("error", msg.error ?? `${msg.op} failed`);
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
      transport,
      onMessage: handleMessage,
      onMessageDropped: (count) => {
        useAlertStore
          .getState()
          .push(
            "warning",
            `${count} queued request${count === 1 ? "" : "s"} dropped while disconnected`,
          );
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
      if (
        client.status === "disconnected" ||
        client.status === "reconnecting"
      ) {
        client.connect();
      }
    };

    const handleOffline = () => {
      // Tear the socket down rather than only painting the banner. Writing the
      // store status directly used to desync it from RelayClient — the UI said
      // "Disconnected" while the client still believed it was connected, so
      // nothing ever put it back and anything keyed on the store status stayed
      // stuck. Going through disconnect() keeps the two in step; `online` above
      // reconnects.
      client.disconnect();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      client.disconnect();
      globalClient = null;
    };
  }, [url, token, transport]);

  const send = useCallback((msg: ClientMessage) => {
    clientRef.current?.send(msg);
  }, []);

  return { send, client: clientRef.current };
}

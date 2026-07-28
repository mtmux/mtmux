"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@repo/ui/components/app-shell";
import { cn } from "@repo/ui/lib/utils";
import { ThemeToggle } from "@repo/ui/components/theme-toggle";
import { ConnectionStatus } from "@repo/ui/components/connection-status";
import { useWebSocket, getRelayClient } from "@/hooks/use-websocket";
import { useConnectionStore } from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";
import { useStableMediaQuery } from "@repo/ui/hooks/use-media-query";
import { MobileNav } from "@/components/mobile/mobile-nav";
import { KeyboardToolbar } from "@/components/mobile/keyboard-toolbar";
import { MobileCommandBar } from "@/components/mobile/mobile-command-bar";
import { useUiStore } from "@/stores/ui-store";
import { useAlertStore } from "@/stores/alert-store";
import { getTerminalHandle } from "@/components/terminal/terminal-handle";
import {
  useTerminalStore,
  getDefaultFontSize,
  clampFontSize,
} from "@/stores/terminal-store";
import { CommandPalette } from "@/components/command/command-palette";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { ErrorBoundary } from "@/components/error-boundary";
import { AlertBanner } from "@/components/alert-banner";
import { ConnectionBanner } from "@/components/connection-banner";
import { VisualViewportSync } from "@/components/visual-viewport-sync";
import { SessionTabs } from "@/components/session/session-tabs";
import { SessionCreateDialog } from "@/components/session/session-create-dialog";
import { useMobileHistory } from "@/hooks/use-mobile-history";
import { resolveRelayWsUrl } from "@/lib/relay-url";
import {
  loadDescriptor,
  hydrateDescriptor,
  loadSessionKeys,
  serverIdFor,
} from "@/lib/session-store";
import { sealedTransport, type TransportFactory } from "@/lib/transport";
import { env } from "@/env";
import { Terminal } from "lucide-react";
import { LAST_SESSION_KEY, TOKEN_KEY, readStored } from "@/lib/storage-keys";

export default function TerminalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  // Set only for a session paired through the broker that fell back to the
  // tunnel; the direct path uses a plain socket like everything else.
  const [transport, setTransport] = useState<TransportFactory | undefined>();
  const { mobileTab, setMobileTab } = useUiStore();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const isMobile = useStableMediaQuery("(max-width: 768px)");
  const { status, latency, reconnectCount } = useConnectionStore();
  const { activeSessionId } = useSessionStore();

  useMobileHistory();

  // Auth guard. Two accepted credentials:
  //
  //   1. localStorage["mtmux-token"] — the self-hosted path, unchanged.
  //   2. A session paired through the broker, whose keys live in IndexedDB
  //      rather than localStorage so an XSS cannot read them. The relay is
  //      authenticated with the direct-path token both sides derived, so no
  //      long-lived secret was ever sent to this device.
  useEffect(() => {
    const storedToken = readStored(TOKEN_KEY);
    if (storedToken) {
      setToken(storedToken);
      return;
    }

    let cancelled = false;

    void (async () => {
      // `loadDescriptor` reads a tab-scoped mirror, which a fresh tab has not
      // filled yet — so an empty one means "not loaded", not "never paired".
      // Falling back to the durable record before giving up is what stops every
      // reload bouncing through /login and straight back again.
      const session = loadDescriptor() ?? (await hydrateDescriptor());
      if (cancelled) return;
      if (!session) {
        router.push("/login");
        return;
      }

      const keys = await loadSessionKeys(serverIdFor(session.descriptor));
      if (cancelled) return;
      if (!keys) {
        router.push("/login");
        return;
      }

      setToken(keys.directToken);
      if (!session.preferredCandidate && env.NEXT_PUBLIC_API_URL) {
        // No direct candidate won, so everything rides the sealed tunnel.
        const url = `${env.NEXT_PUBLIC_API_URL.replace(/^http/, "ws")}/v1/tunnel/${session.descriptor.tunnelId}`;
        setTransport(() => sealedTransport({ url, keys }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router]);

  // Auto-restore last session
  useEffect(() => {
    const lastSession = readStored(LAST_SESSION_KEY);
    if (lastSession && !activeSessionId) {
      useSessionStore.getState().setActiveSession(lastSession);
    }
  }, [activeSessionId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) {
        const { fontSize, setFontSize } = useTerminalStore.getState();
        if (e.key === "=" || e.key === "+") {
          e.preventDefault();
          setFontSize(clampFontSize(fontSize + 1));
        } else if (e.key === "-") {
          e.preventDefault();
          setFontSize(clampFontSize(fontSize - 1));
        } else if (e.key === "0") {
          e.preventDefault();
          setFontSize(getDefaultFontSize());
        } else if (e.key === "b") {
          e.preventDefault();
          useUiStore.getState().toggleSidebar();
        } else if (e.key === "e") {
          e.preventDefault();
          useUiStore.getState().setMobileTab("files");
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Copy the terminal's current selection. The toolbar lives in the shell
  // footer, outside the tree holding the terminal ref, hence the module-level
  // handle.
  const handleCopySelection = useCallback(async () => {
    const selection = getTerminalHandle()?.getSelection() ?? "";
    if (!selection) {
      useAlertStore
        .getState()
        .push(
          "info",
          "Nothing selected — long-press the terminal, or use copy mode",
        );
      return;
    }
    try {
      await navigator.clipboard.writeText(selection);
      useAlertStore.getState().push("success", "Copied selection");
    } catch {
      useAlertStore.getState().push("error", "Clipboard access denied");
    }
  }, []);

  // Register service worker
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // SW registration failed
      });
    }
  }, []);

  const { send } = useWebSocket(
    token ? resolveRelayWsUrl() : "",
    token ?? "",
    transport,
  );

  if (!token) {
    return null; // Redirecting to login
  }

  const connectionStatusType =
    status === "connected"
      ? "connected"
      : status === "connecting" || status === "authenticating"
        ? "connecting"
        : status === "reconnecting"
          ? "reconnecting"
          : "disconnected";

  const header = (
    <>
      <div
        className={cn(
          "flex min-w-0 items-center gap-3 px-3",
          isMobile ? "py-1" : "py-1.5",
        )}
      >
        <Terminal className="h-4 w-4 text-primary" />
        {/* #5: Hide the wordmark on mobile — icon only */}
        {!isMobile && <span className="text-sm font-semibold">mtmux</span>}
        <ConnectionStatus
          status={connectionStatusType}
          latency={latency ?? undefined}
          reconnectCount={reconnectCount}
          onReconnect={() => {
            const client = getRelayClient();
            if (client) {
              client.disconnect();
              client.connect();
            }
          }}
          className="ml-1 shrink-0"
        />
        <AlertBanner />
        {!isMobile && (
          <SessionTabs
            onCreateClick={() => setShowCreateDialog(true)}
            className="flex-1 ml-2"
          />
        )}
        {/* #5: ThemeToggle hidden on mobile — moved to settings panel (#12) */}
        {!isMobile && (
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
          </div>
        )}
      </div>
      {/* Part of the header, not an overlay, so a degraded connection pushes the
          terminal down instead of covering its first row. */}
      <ConnectionBanner />
    </>
  );

  const toolbar = isMobile ? (
    <div>
      {mobileTab === "terminal" && activeSessionId && <MobileCommandBar />}
      {mobileTab === "terminal" && (
        <KeyboardToolbar
          onSearchOpen={() => useUiStore.getState().setTerminalSearchOpen(true)}
          onCopy={handleCopySelection}
        />
      )}
      <MobileNav activeTab={mobileTab} onTabChange={setMobileTab} />
    </div>
  ) : undefined;

  return (
    <AppShell header={header} toolbar={toolbar}>
      <VisualViewportSync />
      <ErrorBoundary fallbackMessage="Terminal crashed">
        {children}
      </ErrorBoundary>
      <CommandPalette />
      <KeyboardShortcutsDialog />
      <SessionCreateDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
      />
    </AppShell>
  );
}

"use client";

import { useEffect, useState } from "react";
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
import { useTerminalStore, getDefaultFontSize, clampFontSize } from "@/stores/terminal-store";
import { CommandPalette } from "@/components/command/command-palette";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { ErrorBoundary } from "@/components/error-boundary";
import { AlertBanner } from "@/components/alert-banner";
import { VisualViewportSync } from "@/components/visual-viewport-sync";
import { SessionTabs } from "@/components/session/session-tabs";
import { SessionCreateDialog } from "@/components/session/session-create-dialog";
import { useMobileHistory } from "@/hooks/use-mobile-history";
import { resolveRelayWsUrl } from "@/lib/relay-url";
import { Terminal } from "lucide-react";

export default function TerminalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const { mobileTab, setMobileTab } = useUiStore();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const isMobile = useStableMediaQuery("(max-width: 768px)");
  const { status, latency, reconnectCount } = useConnectionStore();
  const { activeSessionId } = useSessionStore();

  useMobileHistory();

  // Auth guard - check token on mount
  useEffect(() => {
    const storedToken = localStorage.getItem("ccremote-token");
    if (!storedToken) {
      router.push("/login");
      return;
    }
    setToken(storedToken);
  }, [router]);

  // Auto-restore last session
  useEffect(() => {
    const lastSession = localStorage.getItem("ccremote-last-session");
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
    <div className={cn("flex min-w-0 items-center gap-3 px-3", isMobile ? "py-1" : "py-1.5")}>
      <Terminal className="h-4 w-4 text-primary" />
      {/* #5: Hide "ccremote" text on mobile — icon only */}
      {!isMobile && <span className="text-sm font-semibold">ccremote</span>}
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
  );

  const toolbar = isMobile ? (
    <div>
      {mobileTab === "terminal" && activeSessionId && <MobileCommandBar />}
      {mobileTab === "terminal" && <KeyboardToolbar />}
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

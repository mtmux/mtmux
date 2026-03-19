"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell } from "@repo/ui/components/app-shell";
import { cn } from "@repo/ui/lib/utils";
import { ThemeToggle } from "@repo/ui/components/theme-toggle";
import { ConnectionStatus } from "@repo/ui/components/connection-status";
import { useWebSocket } from "@/hooks/use-websocket";
import { useConnectionStore } from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";
import { useMediaQuery } from "@repo/ui/hooks/use-media-query";
import { MobileNav } from "@/components/mobile/mobile-nav";
import { KeyboardToolbar } from "@/components/mobile/keyboard-toolbar";
import { MobileCommandBar } from "@/components/mobile/mobile-command-bar";
import { useUiStore } from "@/stores/ui-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { CommandPalette } from "@/components/command/command-palette";
import { ConnectionOverlay } from "@/components/connection-overlay";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { ErrorBoundary } from "@/components/error-boundary";
import { SessionTabs } from "@/components/session/session-tabs";
import { SessionCreateDialog } from "@/components/session/session-create-dialog";
import { useMobileHistory } from "@/hooks/use-mobile-history";
import { env } from "@/env";
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
  const isMobile = useMediaQuery("(max-width: 768px)");
  const { status, latency } = useConnectionStore();
  const { activeSessionId } = useSessionStore();

  useMobileHistory();

  // Auth guard - check token on mount
  useEffect(() => {
    const storedToken = localStorage.getItem("termbridge-token");
    if (!storedToken) {
      router.push("/login");
      return;
    }
    setToken(storedToken);
  }, [router]);

  // Auto-restore last session
  useEffect(() => {
    const lastSession = localStorage.getItem("termbridge-last-session");
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
          setFontSize(Math.min(24, fontSize + 1));
        } else if (e.key === "-") {
          e.preventDefault();
          setFontSize(Math.max(8, fontSize - 1));
        } else if (e.key === "0") {
          e.preventDefault();
          setFontSize(14);
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
    token ? env.NEXT_PUBLIC_RELAY_URL : "",
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
    <div className={cn("flex items-center gap-3 px-3", isMobile ? "py-1" : "py-1.5")}>
      <Terminal className="h-4 w-4 text-primary" />
      {/* #5: Hide "TermBridge" text on mobile — icon only */}
      {!isMobile && <span className="text-sm font-semibold">TermBridge</span>}
      <ConnectionStatus
        status={connectionStatusType}
        latency={latency ?? undefined}
        className="ml-1"
      />
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
      <ErrorBoundary fallbackMessage="Terminal crashed">
        {children}
      </ErrorBoundary>
      <CommandPalette />
      <ConnectionOverlay />
      <KeyboardShortcutsDialog />
      <SessionCreateDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
      />
    </AppShell>
  );
}

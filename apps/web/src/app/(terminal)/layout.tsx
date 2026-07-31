"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AppShell } from "@repo/ui/components/app-shell";
import { Button } from "@repo/ui/components/ui/button";
import { cn } from "@repo/ui/lib/utils";
import { ThemeToggle } from "@repo/ui/components/theme-toggle";
import { ConnectionStatus } from "@repo/ui/components/connection-status";
import { useWebSocket, getRelayClient } from "@/hooks/use-websocket";
import {
  filesDisabled,
  isReadOnly,
  useConnectionStore,
} from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";
import { useStableMediaQuery } from "@repo/ui/hooks/use-media-query";
import { MobileNav } from "@/components/mobile/mobile-nav";
import { CommandComposer } from "@/components/mobile/command-composer";
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
import { CapabilityBanner } from "@/components/capability-banner";
import { LockGate } from "@/components/lock/lock-gate";
import { registerDisconnect } from "@/lib/lock-controller";
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
import { LayoutGrid, Loader2, Terminal } from "lucide-react";
import { markBounced } from "@/lib/bounce-guard";
import { isHostedBuild } from "@/lib/auth-client";
import {
  LAST_SESSION_KEY,
  readSelfHostedToken,
  readStored,
} from "@/lib/storage-keys";

/**
 * The gate is outside the layout body on purpose.
 *
 * While locked, `loadSessionKeys()` cannot decrypt and returns null — which the
 * auth guard below reads, correctly, as "no session" and bounces to /start. Put
 * the gate inside and a locked device would round-trip through the entry pages
 * instead of showing the lock screen. Outside, the inner component's effects
 * never run at all until the device is open.
 */
export default function TerminalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <LockGate>
      <TerminalLayoutInner>{children}</TerminalLayoutInner>
    </LockGate>
  );
}

/**
 * Three states, not two.
 *
 * `token: string | null` conflated "still looking" with "there is nothing" —
 * and since looking means an async IndexedDB read, every cold load rendered the
 * `null` branch first. That branch returned `null`, so the first thing anyone
 * saw on app.mtmux.com was a blank white screen for as long as the read took.
 * A spinner is not a nicety here; it is the difference between a page that is
 * working and a page that is broken, and they looked identical.
 */
type Auth =
  | { phase: "checking" }
  | { phase: "none" }
  | { phase: "ready"; token: string };

function TerminalLayoutInner({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [auth, setAuth] = useState<Auth>({ phase: "checking" });
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
  //   1. The self-hosted token — from localStorage, or from memory once a
  //      device lock has taken it out of localStorage.
  //   2. A session paired through the broker, whose keys live in IndexedDB
  //      rather than localStorage so an XSS cannot read them. The relay is
  //      authenticated with the direct-path token both sides derived, so no
  //      long-lived secret was ever sent to this device.
  useEffect(() => {
    const storedToken = readSelfHostedToken();
    if (storedToken) {
      setAuth({ phase: "ready", token: storedToken });
      return;
    }

    let cancelled = false;

    /**
     * Give up, and send them somewhere they can actually do something.
     *
     * `/start` rather than `/login`: `/login` asks for the self-hosted 64-hex
     * relay token, which a hosted visitor has no way to obtain. `replace`
     * rather than `push`, so the back button does not walk straight back into
     * the page that just bounced them.
     */
    const giveUp = () => {
      setAuth({ phase: "none" });
      markBounced();
      router.replace("/start");
    };

    void (async () => {
      // `loadDescriptor` reads a tab-scoped mirror, which a fresh tab has not
      // filled yet — so an empty one means "not loaded", not "never paired".
      // Falling back to the durable record before giving up is what stops every
      // reload bouncing through an entry page and straight back again.
      const session = loadDescriptor() ?? (await hydrateDescriptor());
      if (cancelled) return;
      if (!session) {
        giveUp();
        return;
      }

      const keys = await loadSessionKeys(serverIdFor(session.descriptor));
      if (cancelled) return;
      if (!keys) {
        giveUp();
        return;
      }

      setAuth({ phase: "ready", token: keys.directToken });
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

  // What this credential may do, per `auth:success`. Null on the self-hosted
  // and full-grant paths, which is what unrestricted looks like.
  const capabilities = useConnectionStore((s) => s.capabilities);

  // A share with files off must not leave the browser sitting on a Files tab
  // that no longer has a nav entry — including the case where the tab was
  // restored from a previous, unscoped connection to the same machine.
  const noFiles = filesDisabled(capabilities);
  useEffect(() => {
    if (noFiles && mobileTab === "files") setMobileTab("terminal");
  }, [noFiles, mobileTab, setMobileTab]);

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
          if (!filesDisabled(useConnectionStore.getState().capabilities)) {
            useUiStore.getState().setMobileTab("files");
          }
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

  // Hand the lock the one thing it cannot reach on its own. Locking has to
  // drop the socket as well as the keys: an authenticated connection left open
  // behind a lock screen is a live capability a lock-screen XSS could drive.
  useEffect(() => {
    registerDisconnect(() => getRelayClient()?.disconnect());
    return () => registerDisconnect(null);
  }, []);

  // Register service worker
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // SW registration failed
      });
    }
  }, []);

  // Called for its effect: this is where the socket is opened and registered.
  // Children reach it through `getRelayClient()`, not through a return value.
  const token = auth.phase === "ready" ? auth.token : null;
  useWebSocket(token ? resolveRelayWsUrl() : "", token ?? "", transport);

  if (auth.phase !== "ready") {
    // Same markup as `RequireSession`'s pending branch, and for the same
    // reason: a screen-reader user gets told what is happening, and a sighted
    // one can tell "checking" apart from "crashed".
    return (
      <div
        className="flex min-h-[100dvh] items-center justify-center bg-background"
        role="status"
        aria-live="polite"
      >
        <Loader2
          className="h-5 w-5 animate-spin text-muted-foreground"
          aria-hidden
        />
        <span className="sr-only">
          {auth.phase === "checking"
            ? "Checking this device for a session"
            : "Taking you to the connect page"}
        </span>
      </div>
    );
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
            {/* The terminal and the dashboard were two islands with no bridge
                in either direction. This is the desktop half; the mobile half
                is the Account section in the settings panel, and there is a
                "Go to" group in the command palette for both. */}
            {isHostedBuild && (
              <Button
                asChild
                variant="ghost"
                size="sm"
                className="h-8 text-muted-foreground hover:text-foreground"
              >
                <Link href="/dashboard">
                  <LayoutGrid className="mr-1.5 h-4 w-4" aria-hidden />
                  Machines
                </Link>
              </Button>
            )}
            <ThemeToggle />
          </div>
        )}
      </div>
      {/* Part of the header, not an overlay, so a degraded connection pushes the
          terminal down instead of covering its first row. */}
      <ConnectionBanner />
      <CapabilityBanner />
    </>
  );

  // Both of these exist only to send input, so a read-only share should not
  // carry them — a send button that does nothing is worse than no button.
  const canType = !isReadOnly(capabilities);

  const toolbar = isMobile ? (
    <div>
      {mobileTab === "terminal" && activeSessionId && canType && (
        <MobileCommandBar />
      )}
      {mobileTab === "terminal" && canType && (
        <KeyboardToolbar
          onSearchOpen={() => useUiStore.getState().setTerminalSearchOpen(true)}
          onCopy={handleCopySelection}
        />
      )}
      {/* Hidden by CSS while the keyboard is up — see globals.css. The
          wrapper exists so the nav itself stays a plain component. */}
      <div className="mtmux-hide-when-keyboard">
        <MobileNav activeTab={mobileTab} onTabChange={setMobileTab} />
      </div>
    </div>
  ) : undefined;

  return (
    <AppShell header={header} toolbar={toolbar}>
      <VisualViewportSync />
      <ErrorBoundary fallbackMessage="Terminal crashed">
        {children}
      </ErrorBoundary>
      <CommandPalette />
      <CommandComposer />
      <KeyboardShortcutsDialog />
      <SessionCreateDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
      />
    </AppShell>
  );
}

"use client";

import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getTerminalTheme, terminalThemeToXterm } from "@repo/ui/terminal-themes";
import { useTerminalStore } from "@/stores/terminal-store";
import { usePaneStore } from "@/stores/pane-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useAlertStore } from "@/stores/alert-store";
import { getRelayClient, useRelaySubscription } from "@/hooks/use-websocket";
import { Terminal, Plus } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { cn } from "@repo/ui/lib/utils";
import type { ServerMessage } from "@repo/protocol";

interface TerminalViewProps {
  sessionName: string | null;
  className?: string;
  onCreateSession?: () => void;
}

export interface TerminalViewHandle {
  search: (term: string) => void;
  findNext: () => void;
  findPrevious: () => void;
}

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalView({ sessionName, className, onCreateSession }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<XTerm | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const searchAddonRef = useRef<SearchAddon | null>(null);
    const webglAddonRef = useRef<WebglAddon | null>(null);
    const attachedSessionRef = useRef<string | null>(null);
    const sessionReadyRef = useRef(false);
    const pendingSessionRef = useRef<string | null>(null);
    const recoveryRef = useRef<{
      debounceTimer: ReturnType<typeof setTimeout> | null;
      atlasDisposable: { dispose: () => void } | null;
      rafIds: number[];
      timerIds: ReturnType<typeof setTimeout>[];
    }>({ debounceTimer: null, atlasDisposable: null, rafIds: [], timerIds: [] });
    const { fontSize, fontFamily, themeName, cursorStyle, cursorBlink, scrollback } =
      useTerminalStore();
    useImperativeHandle(ref, () => ({
      search: (term: string) => {
        searchAddonRef.current?.findNext(term);
      },
      findNext: () => {
        searchAddonRef.current?.findNext("");
      },
      findPrevious: () => {
        searchAddonRef.current?.findPrevious("");
      },
    }));

    // Initialize terminal ONCE on mount — no sessionName dependency
    useEffect(() => {
      if (!containerRef.current) return;

      const theme = getTerminalTheme(themeName);
      const terminal = new XTerm({
        fontSize,
        fontFamily,
        cursorStyle,
        cursorBlink,
        scrollback,
        theme: terminalThemeToXterm(theme),
        allowProposedApi: true,
        macOptionIsMeta: true,
        convertEol: true,
      });

      const fitAddon = new FitAddon();
      const searchAddon = new SearchAddon();
      const unicode11Addon = new Unicode11Addon();
      const webLinksAddon = new WebLinksAddon();

      terminal.loadAddon(fitAddon);
      terminal.loadAddon(searchAddon);
      terminal.loadAddon(unicode11Addon);
      terminal.loadAddon(webLinksAddon);

      terminal.unicode.activeVersion = "11";
      terminal.open(containerRef.current);

      // Patch xterm's RenderService.dimensions getter to be null-safe.
      // xterm.js 5.5.0 has a bug where `_renderer.value!.dimensions` uses a
      // non-null assertion, but `_renderer.value` CAN be undefined when the
      // WebGL addon is being loaded (replacing the canvas renderer) and the
      // Viewport's deferred `setTimeout(() => syncScrollArea())` fires during
      // the swap. This causes "Cannot read properties of undefined (reading
      // 'dimensions')" from RenderService.ts:50 / Viewport.ts:84.
      const core = (terminal as any)._core;
      if (core?._renderService) {
        const rs = core._renderService;
        const proto = Object.getPrototypeOf(rs);
        const desc = Object.getOwnPropertyDescriptor(proto, "dimensions");
        if (desc?.get) {
          let lastValidDimensions: any = null;
          Object.defineProperty(rs, "dimensions", {
            get() {
              if (this._renderer?.value) {
                lastValidDimensions = this._renderer.value.dimensions;
                return lastValidDimensions;
              }
              // Return last-known-good dims (allows FitAddon to still compute layout)
              // Fall back to safe zeros only if no dimensions have ever been captured
              if (lastValidDimensions) {
                return lastValidDimensions;
              }
              return {
                css: { canvas: { width: 0, height: 0 }, cell: { width: 0, height: 0 } },
                device: {
                  canvas: { width: 0, height: 0 },
                  cell: { width: 0, height: 0 },
                  char: { width: 0, height: 0, top: 0, left: 0 },
                },
              };
            },
            configurable: true,
          });
        }
      }

      // Safe fit wrapper — renderer may not be initialized during deferred calls
      const safeFit = () => {
        try {
          fitAddon.fit();
        } catch {
          // Renderer not ready — ignore
        }
      };

      let webglAddon: WebglAddon | null = null;
      try {
        webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          try {
            webglAddon?.dispose();
          } catch {
            // Already disposed
          }
          webglAddon = null;
          webglAddonRef.current = null;
        });
        terminal.loadAddon(webglAddon);
        webglAddonRef.current = webglAddon;
      } catch {
        // WebGL not supported, using default canvas renderer
        webglAddon = null;
        webglAddonRef.current = null;
      }

      // Initial fit — if container has dimensions, fit immediately; otherwise
      // retry over several rAF frames (container may be 0-height at mount due
      // to CSS layout settling, mobile tab visibility, etc.)
      if (containerRef.current.offsetWidth > 0 && containerRef.current.offsetHeight > 0) {
        safeFit();
      } else {
        const delays = [0, 50, 100, 200, 400, 800, 1500];
        let attempt = 0;
        const retryFit = () => {
          if (attempt >= delays.length) return;
          const delay = delays[attempt++];
          const timerId = setTimeout(() => {
            if (containerRef.current && containerRef.current.offsetWidth > 0 && containerRef.current.offsetHeight > 0) {
              safeFit();
            } else {
              retryFit();
            }
          }, delay);
          recoveryRef.current.timerIds.push(timerId);
        };
        retryFit();
      }

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;

      // Wire terminal input to WebSocket
      const dataDisposable = terminal.onData((data) => {
        const client = getRelayClient();
        if (client) {
          client.send({ type: "terminal:input", data });
        }
      });

      // Wire terminal resize to WebSocket
      const resizeDisposable = terminal.onResize(({ cols, rows }) => {
        const client = getRelayClient();
        if (client) {
          client.send({ type: "terminal:resize", size: { cols, rows } });
        }
      });

      // Debounced ResizeObserver with double-timeout for CSS transitions
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      let transitionTimer: ReturnType<typeof setTimeout> | null = null;
      const resizeObserver = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => safeFit(), 100);
        // Second fit after CSS transitions settle (sidebar toggle is 200ms)
        if (transitionTimer) clearTimeout(transitionTimer);
        transitionTimer = setTimeout(() => safeFit(), 250);
      });
      resizeObserver.observe(containerRef.current);

      // Window resize handler — catches devtools responsive toggle, window resize
      let windowResizeTimer: ReturnType<typeof setTimeout> | null = null;
      const handleWindowResize = () => {
        if (windowResizeTimer) clearTimeout(windowResizeTimer);
        windowResizeTimer = setTimeout(() => safeFit(), 100);
      };
      window.addEventListener("resize", handleWindowResize);

      // Orientation change handler for mobile
      const handleOrientationChange = () => {
        setTimeout(() => safeFit(), 300);
      };
      window.addEventListener("orientationchange", handleOrientationChange);

      // visualViewport resize handler — fires on browser-level zoom (pinch past
      // the viewport meta lock, accessibility zoom, etc.)
      const handleViewportResize = () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          safeFit();
          // After zoom-triggered refit, sync cols/rows with relay so tmux adjusts
          const t = terminalRef.current;
          if (t && t.cols > 0 && t.rows > 0 && attachedSessionRef.current) {
            getRelayClient()?.send({ type: "terminal:resize", size: { cols: t.cols, rows: t.rows } });
          }
        }, 150);
      };
      window.visualViewport?.addEventListener("resize", handleViewportResize);
      // Also re-fit on visualViewport scroll — fires when user pans the zoomed
      // visual viewport. Without this, layout-anchored chrome repositions
      // correctly but the terminal can be drawn at a stale offset.
      window.visualViewport?.addEventListener("scroll", handleViewportResize);

      // IntersectionObserver for mobile tab visibility (display:none → display:flex)
      const intersectionObserver = new IntersectionObserver((entries) => {
        if (entries[0]?.isIntersecting) {
          setTimeout(() => {
            safeFit();
            const t = terminalRef.current;
            if (t && t.cols > 0 && t.rows > 0 && attachedSessionRef.current) {
              getRelayClient()?.send({ type: "terminal:resize", size: { cols: t.cols, rows: t.rows } });
            }
          }, 150);
          setTimeout(() => {
            safeFit();
            const t = terminalRef.current;
            if (t && t.cols > 0 && t.rows > 0 && attachedSessionRef.current) {
              getRelayClient()?.send({ type: "terminal:resize", size: { cols: t.cols, rows: t.rows } });
            }
          }, 300);
          setTimeout(() => safeFit(), 500);
        }
      });
      intersectionObserver.observe(containerRef.current);

      return () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        if (transitionTimer) clearTimeout(transitionTimer);
        if (windowResizeTimer) clearTimeout(windowResizeTimer);
        resizeObserver.disconnect();
        intersectionObserver.disconnect();
        window.removeEventListener("resize", handleWindowResize);
        window.removeEventListener("orientationchange", handleOrientationChange);
        window.visualViewport?.removeEventListener("resize", handleViewportResize);
        window.visualViewport?.removeEventListener("scroll", handleViewportResize);
        dataDisposable.dispose();
        resizeDisposable.dispose();
        // Cancel any pending recovery
        const rec = recoveryRef.current;
        if (rec.debounceTimer) clearTimeout(rec.debounceTimer);
        rec.atlasDisposable?.dispose();
        rec.rafIds.forEach(id => cancelAnimationFrame(id));
        rec.timerIds.forEach(id => clearTimeout(id));
        terminal.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
        searchAddonRef.current = null;
        webglAddonRef.current = null;
      };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps -- terminal created once on mount

    // Update terminal options when settings change
    useEffect(() => {
      const terminal = terminalRef.current;
      if (!terminal) return;

      // Apply options immediately (cheap, no rendering)
      const theme = getTerminalTheme(themeName);
      terminal.options.fontSize = fontSize;
      terminal.options.fontFamily = fontFamily;
      terminal.options.cursorStyle = cursorStyle;
      terminal.options.cursorBlink = cursorBlink;
      terminal.options.scrollback = scrollback;
      terminal.options.theme = terminalThemeToXterm(theme);

      // Cancel any pending recovery from a previous rapid change
      const recovery = recoveryRef.current;
      if (recovery.debounceTimer) clearTimeout(recovery.debounceTimer);
      recovery.atlasDisposable?.dispose();
      recovery.atlasDisposable = null;
      recovery.rafIds.forEach(id => cancelAnimationFrame(id));
      recovery.rafIds = [];
      recovery.timerIds.forEach(id => clearTimeout(id));
      recovery.timerIds = [];

      // Debounce the actual fit/refresh recovery.
      // During pinch-to-zoom, fontSize changes many times per second.
      // We only need to recover once after changes settle.
      recovery.debounceTimer = setTimeout(() => {
        const fitAndRefresh = () => {
          try {
            fitAddonRef.current?.fit();
          } catch {
            // Renderer not ready
          }
          try {
            const t = terminalRef.current;
            if (t && t.rows > 0) {
              t.refresh(0, t.rows - 1);
            }
          } catch {
            // refresh can throw if renderer is mid-swap
          }
          const t = terminalRef.current;
          if (t && t.cols > 0 && t.rows > 0 && attachedSessionRef.current) {
            getRelayClient()?.send({ type: "terminal:resize", size: { cols: t.cols, rows: t.rows } });
          }
        };

        // Immediate attempt
        fitAndRefresh();

        // Listen for WebGL atlas rebuild completion
        const webgl = webglAddonRef.current;
        if (webgl) {
          recovery.atlasDisposable = webgl.onChangeTextureAtlas(() => {
            const rafId = requestAnimationFrame(() => {
              fitAndRefresh();
            });
            recovery.rafIds.push(rafId);
          });
        }

        // rAF fallback chain (5 frames)
        let count = 0;
        const scheduleRetry = () => {
          if (count >= 5) return;
          count++;
          const rafId = requestAnimationFrame(() => {
            fitAndRefresh();
            scheduleRetry();
          });
          recovery.rafIds.push(rafId);
        };
        const initialId = requestAnimationFrame(() => scheduleRetry());
        recovery.rafIds.push(initialId);
      }, 80); // 80ms debounce — batches rapid pinch changes while staying responsive

      // NO cleanup function — recovery is managed via recoveryRef, cleaned up
      // at start of next effect run or on component unmount (init effect cleanup)
    }, [fontSize, fontFamily, themeName, cursorStyle, cursorBlink, scrollback]);

    // Wire WebSocket output to terminal — use ref to prevent stale session
    // output. useRelaySubscription re-attaches once globalClient is set by the
    // parent layout's useWebSocket effect and re-binds after a reconnect.
    useRelaySubscription((msg: ServerMessage) => {
      // On reconnect, re-attach the current session
      if (msg.type === "auth:success") {
        const session = attachedSessionRef.current;
        if (session) {
          // Reset ready state — wait for new session:attached before writing output
          sessionReadyRef.current = false;
          pendingSessionRef.current = session;
          const size = terminalRef.current && terminalRef.current.cols > 0 && terminalRef.current.rows > 0
            ? { cols: terminalRef.current.cols, rows: terminalRef.current.rows }
            : { cols: 80, rows: 24 };
          const c = getRelayClient();
          c?.send({ type: "session:attach", name: session, size, capture: true });
          c?.send({ type: "pane:list" });
          c?.send({ type: "window:list" });
        }
        return;
      }
      if (msg.type === "session:attached" && msg.name === pendingSessionRef.current) {
        // Only clear if not already attached (prevent double-clear)
        if (attachedSessionRef.current !== msg.name) {
          const terminal = terminalRef.current;
          if (terminal) terminal.clear();
        }
        attachedSessionRef.current = msg.name;
        sessionReadyRef.current = true;
        pendingSessionRef.current = null;
      }
      if (msg.type === "terminal:output" && terminalRef.current && sessionReadyRef.current && attachedSessionRef.current) {
        terminalRef.current.write(msg.data);
      }
    });

    // Attach/detach to session when sessionName changes
    useEffect(() => {
      if (!sessionName) {
        attachedSessionRef.current = null;
        sessionReadyRef.current = false;
        pendingSessionRef.current = null;
        return;
      }

      // Skip re-attach if already attached to this session
      if (sessionName === attachedSessionRef.current) return;

      pendingSessionRef.current = sessionName;
      sessionReadyRef.current = false;

      const client = getRelayClient();
      if (!client) return;

      // Don't clear terminal here — defer to session:attached handler

      const size = terminalRef.current && terminalRef.current.cols > 0 && terminalRef.current.rows > 0
        ? { cols: terminalRef.current.cols, rows: terminalRef.current.rows }
        : { cols: 80, rows: 24 };

      client.send({ type: "session:attach", name: sessionName, size, capture: true });
      client.send({ type: "pane:list" });
      client.send({ type: "window:list" });

      if (useSettingsStore.getState().autoZoom && window.matchMedia("(max-width: 768px)").matches) {
        usePaneStore.getState().setPendingAutoZoom(true);
      }

      // If session:attached doesn't arrive in 5s, surface a visible error
      // and leave the click un-handled (don't flip ready=true to mask it).
      const errorTimer = setTimeout(() => {
        if (!sessionReadyRef.current && pendingSessionRef.current === sessionName) {
          useAlertStore
            .getState()
            .push("error", `Couldn't open session "${sessionName}" — try again or check the relay.`);
        }
      }, 5000);

      return () => {
        clearTimeout(errorTimer);
        pendingSessionRef.current = null;
        sessionReadyRef.current = false;
        client.send({ type: "session:detach" });
      };
    }, [sessionName]);

    return (
      <div className={cn("relative", className)} style={{ width: "100%", height: "100%" }}>
        {/* Terminal container — always mounted */}
        <div
          ref={containerRef}
          className={cn(
            "h-full w-full",
            !sessionName && "invisible",
          )}
          style={{ touchAction: "manipulation" }}
        />

        {/* No session overlay */}
        {!sessionName && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-muted-foreground bg-background">
            <Terminal className="h-16 w-16 text-muted-foreground/20" />
            <div className="text-center">
              <p className="text-base font-semibold text-foreground">No session selected</p>
              <p className="text-sm mt-1">Create or select a session to get started</p>
            </div>
            {onCreateSession && (
              <Button onClick={onCreateSession} className="animate-pulse hover:animate-none">
                <Plus className="mr-1.5 h-4 w-4" />
                Create Session
              </Button>
            )}
          </div>
        )}

      </div>
    );
  },
);

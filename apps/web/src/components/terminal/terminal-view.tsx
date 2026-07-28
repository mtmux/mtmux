"use client";

import {
  useEffect,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
} from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import {
  getTerminalTheme,
  terminalThemeToXterm,
} from "@repo/ui/terminal-themes";
import { useTerminalStore } from "@/stores/terminal-store";
import { usePaneStore } from "@/stores/pane-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useAlertStore } from "@/stores/alert-store";
import { useConnectionStore } from "@/stores/connection-store";
import { getRelayClient, useRelaySubscription } from "@/hooks/use-websocket";
import {
  IDLE,
  attachedName,
  needsAttach,
  nextAttachId,
  reduceAttach,
  shouldWriteOutput,
  type AttachState,
} from "@/lib/attach-state";
import {
  setTerminalHandle,
  type TerminalHandle,
} from "@/components/terminal/terminal-handle";
import { Terminal, Plus, Loader2 } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { cn } from "@repo/ui/lib/utils";
import type { ServerMessage } from "@repo/protocol";

interface TerminalViewProps {
  sessionName: string | null;
  className?: string;
  onCreateSession?: () => void;
}

export type TerminalViewHandle = TerminalHandle;

/**
 * All layout signals (ResizeObserver, window resize, orientation, visualViewport,
 * tab visibility, font changes) funnel into a single debounced fit. Previously
 * each had its own timer ladder, producing up to a dozen fits — and a dozen
 * `terminal:resize` round-trips — in the first 1.5s after mount. Every distinct
 * size is a SIGWINCH that makes tmux redraw for *all* attached clients, which is
 * what the flicker actually was.
 */
const FIT_DEBOUNCE_MS = 80;
/** One trailing fit after CSS transitions settle (the sidebar toggle is 200ms). */
const FIT_SETTLE_MS = 260;
/** Mount-time ladder for a container that is still 0-height (mobile tabs, CSS). */
const MOUNT_FIT_RETRY_DELAYS = [0, 50, 100, 200, 400, 800, 1500];
const ATTACH_TIMEOUT_MS = 5000;
const FALLBACK_SIZE = { cols: 80, rows: 24 };

export const TerminalView = forwardRef<TerminalViewHandle, TerminalViewProps>(
  function TerminalView({ sessionName, className, onCreateSession }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<XTerm | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const searchAddonRef = useRef<SearchAddon | null>(null);
    const webglAddonRef = useRef<WebglAddon | null>(null);

    // Single source of truth for the attach lifecycle — see lib/attach-state.ts.
    const attachStateRef = useRef<AttachState>(IDLE);
    // Last size actually sent to the relay, so repeated fits at the same
    // dimensions never hit the wire.
    const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);

    // Imperative handles owned by the init effect, used by the effects below.
    const scheduleFitRef = useRef<(() => void) | null>(null);
    const syncSizeRef = useRef<(() => void) | null>(null);

    const fitTimersRef = useRef<{
      debounce: ReturnType<typeof setTimeout> | null;
      settle: ReturnType<typeof setTimeout> | null;
      mountRetries: ReturnType<typeof setTimeout>[];
    }>({ debounce: null, settle: null, mountRetries: [] });
    const optionsRafRef = useRef<number | null>(null);
    const atlasDisposableRef = useRef<{ dispose: () => void } | null>(null);

    // Per-field selectors: a change to one setting shouldn't re-render this
    // component for the others (pinch-zoom writes fontSize many times a second).
    const fontSize = useTerminalStore((s) => s.fontSize);
    const fontFamily = useTerminalStore((s) => s.fontFamily);
    const themeName = useTerminalStore((s) => s.themeName);
    const cursorStyle = useTerminalStore((s) => s.cursorStyle);
    const cursorBlink = useTerminalStore((s) => s.cursorBlink);
    const scrollback = useTerminalStore((s) => s.scrollback);
    // Read once per mount: swapping renderers on a live terminal is not
    // something xterm supports cleanly, so the init effect below owns this and
    // the toggle takes effect on the next mount/reload.
    const gpuRendering = useTerminalStore((s) => s.gpuRendering);
    const status = useConnectionStore((s) => s.status);
    // Mirrors the attach machine for rendering only: until the ack lands the
    // terminal is a blank black rectangle, for up to ATTACH_TIMEOUT_MS.
    const [attaching, setAttaching] = useState(false);

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
      getSelection: () => terminalRef.current?.getSelection() ?? "",
    }));

    // Same handle, reachable from outside this subtree — see terminal-handle.ts.
    useEffect(() => {
      setTerminalHandle({
        search: (term: string) => {
          searchAddonRef.current?.findNext(term);
        },
        findNext: () => {
          searchAddonRef.current?.findNext("");
        },
        findPrevious: () => {
          searchAddonRef.current?.findPrevious("");
        },
        getSelection: () => terminalRef.current?.getSelection() ?? "",
      });
      return () => setTerminalHandle(null);
    }, []);

    // Initialize terminal ONCE on mount — no sessionName dependency
    useEffect(() => {
      if (!containerRef.current) return;

      // Stable object for the lifetime of this effect — captured once so the
      // cleanup below doesn't read a ref that could have been reassigned.
      const timers = fitTimersRef.current;
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
        // A tmux PTY already emits CRLF. Rewriting bare \n corrupts the output
        // of applications that emit a lone linefeed deliberately.
        convertEol: false,
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const core = (terminal as any)._core;
      if (core?._renderService) {
        const rs = core._renderService;
        const proto = Object.getPrototypeOf(rs);
        const desc = Object.getOwnPropertyDescriptor(proto, "dimensions");
        if (desc?.get) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
                css: {
                  canvas: { width: 0, height: 0 },
                  cell: { width: 0, height: 0 },
                },
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

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
      searchAddonRef.current = searchAddon;

      // Safe fit wrapper — renderer may not be initialized during deferred calls
      const safeFit = () => {
        try {
          fitAddon.fit();
        } catch {
          // Renderer not ready — ignore
        }
      };

      const runFit = () => {
        safeFit();
        try {
          if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);
        } catch {
          // refresh can throw if the renderer is mid-swap
        }
      };

      // THE fit entry point. Every layout signal calls this and nothing else.
      const scheduleFit = () => {
        if (timers.debounce) clearTimeout(timers.debounce);
        timers.debounce = setTimeout(() => {
          timers.debounce = null;
          runFit();
        }, FIT_DEBOUNCE_MS);
        if (timers.settle) clearTimeout(timers.settle);
        timers.settle = setTimeout(() => {
          timers.settle = null;
          runFit();
        }, FIT_SETTLE_MS);
      };
      scheduleFitRef.current = scheduleFit;

      // THE resize send point. Guarded on an attached session (an unguarded send
      // during startup earns a NOT_ATTACHED error toast) and deduped against the
      // last size we actually sent.
      const sendResize = (cols: number, rows: number) => {
        if (cols < 1 || rows < 1) return;
        if (!shouldWriteOutput(attachStateRef.current)) return;
        const last = lastSentSizeRef.current;
        if (last && last.cols === cols && last.rows === rows) return;
        lastSentSizeRef.current = { cols, rows };
        getRelayClient()?.send({
          type: "terminal:resize",
          size: { cols, rows },
        });
      };

      // Reconcile after an attach: the size advertised in `session:attach` may
      // predate the container being laid out.
      syncSizeRef.current = () => {
        sendResize(terminal.cols, terminal.rows);
      };

      const hasBox = () =>
        !!containerRef.current &&
        containerRef.current.offsetWidth > 0 &&
        containerRef.current.offsetHeight > 0;

      let webglAddon: WebglAddon | null = null;
      // The WebGL renderer places cells using device-pixel metrics in CSS space
      // — it applies devicePixelRatio exactly one time too many. At DPR 2 only
      // half the columns paint, at DPR 3 only a third; the rest of every line is
      // drawn off-canvas and is simply invisible. At DPR 1 the error cancels,
      // which is why this only shows up on mobile / HiDPI. Disabling the addon
      // renders correctly at every DPR, so `gpuRendering` exists as an escape
      // hatch (Settings → Terminal) for anyone hitting it.
      if (gpuRendering) {
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
      }

      // Initial fit — if the container has dimensions, fit immediately;
      // otherwise walk a retry ladder until it does (0-height at mount happens
      // with mobile tab visibility and CSS layout settling), stopping at the
      // first success.
      if (hasBox()) {
        safeFit();
      } else {
        let attempt = 0;
        const retryFit = () => {
          if (attempt >= MOUNT_FIT_RETRY_DELAYS.length) return;
          const delay = MOUNT_FIT_RETRY_DELAYS[attempt++]!;
          const timerId = setTimeout(() => {
            if (hasBox()) {
              safeFit();
              return;
            }
            retryFit();
          }, delay);
          timers.mountRetries.push(timerId);
        };
        retryFit();
      }

      // Wire terminal input to WebSocket
      const dataDisposable = terminal.onData((data) => {
        getRelayClient()?.send({ type: "terminal:input", data });
      });

      // xterm fires onResize only when fit() actually changes the dimensions,
      // which makes it the natural single place to notify the relay.
      const resizeDisposable = terminal.onResize(({ cols, rows }) => {
        sendResize(cols, rows);
      });

      const resizeObserver = new ResizeObserver(() => scheduleFit());
      resizeObserver.observe(containerRef.current);

      // Window resize — catches devtools responsive toggle, desktop resize
      const handleWindowResize = () => scheduleFit();
      window.addEventListener("resize", handleWindowResize);

      // Orientation change on mobile
      const handleOrientationChange = () => scheduleFit();
      window.addEventListener("orientationchange", handleOrientationChange);

      // visualViewport resize/scroll — browser-level zoom, on-screen keyboard,
      // panning a zoomed viewport
      const handleViewportChange = () => scheduleFit();
      window.visualViewport?.addEventListener("resize", handleViewportChange);
      window.visualViewport?.addEventListener("scroll", handleViewportChange);

      // Mobile tab visibility (display:none → display:flex)
      const intersectionObserver = new IntersectionObserver((entries) => {
        if (entries[0]?.isIntersecting) scheduleFit();
      });
      intersectionObserver.observe(containerRef.current);

      return () => {
        if (timers.debounce) clearTimeout(timers.debounce);
        if (timers.settle) clearTimeout(timers.settle);
        timers.mountRetries.forEach((id) => clearTimeout(id));
        timers.debounce = null;
        timers.settle = null;
        timers.mountRetries = [];
        if (optionsRafRef.current !== null) {
          cancelAnimationFrame(optionsRafRef.current);
          optionsRafRef.current = null;
        }
        atlasDisposableRef.current?.dispose();
        atlasDisposableRef.current = null;
        resizeObserver.disconnect();
        intersectionObserver.disconnect();
        window.removeEventListener("resize", handleWindowResize);
        window.removeEventListener(
          "orientationchange",
          handleOrientationChange,
        );
        window.visualViewport?.removeEventListener(
          "resize",
          handleViewportChange,
        );
        window.visualViewport?.removeEventListener(
          "scroll",
          handleViewportChange,
        );
        dataDisposable.dispose();
        resizeDisposable.dispose();
        // Real unmount — release the relay-side PTY. (Session *switches* don't
        // detach: the relay's attach handler replaces the bridge, and an
        // unpaired detach is exactly what used to wedge the client.)
        if (attachedName(attachStateRef.current)) {
          getRelayClient()?.send({ type: "session:detach" });
        }
        attachStateRef.current = IDLE;
        lastSentSizeRef.current = null;
        scheduleFitRef.current = null;
        syncSizeRef.current = null;
        terminal.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
        searchAddonRef.current = null;
        webglAddonRef.current = null;
      };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps -- terminal created once on mount

    // Apply terminal option changes. Writes are coalesced into a single frame:
    // each write can trigger a WebGL character-atlas rebuild, and pinch-to-zoom
    // drives fontSize many times per second.
    useEffect(() => {
      if (!terminalRef.current) return;

      if (optionsRafRef.current !== null) {
        cancelAnimationFrame(optionsRafRef.current);
      }
      optionsRafRef.current = requestAnimationFrame(() => {
        optionsRafRef.current = null;
        const terminal = terminalRef.current;
        if (!terminal) return;

        terminal.options.fontSize = fontSize;
        terminal.options.fontFamily = fontFamily;
        terminal.options.cursorStyle = cursorStyle;
        terminal.options.cursorBlink = cursorBlink;
        terminal.options.scrollback = scrollback;
        terminal.options.theme = terminalThemeToXterm(
          getTerminalTheme(themeName),
        );

        scheduleFitRef.current?.();

        // A font/theme change rebuilds the WebGL atlas asynchronously; refit
        // once it lands, otherwise cell metrics can be stale. Debounced through
        // scheduleFit, so this is bounded no matter how often the atlas churns.
        atlasDisposableRef.current?.dispose();
        const webgl = webglAddonRef.current;
        if (webgl) {
          atlasDisposableRef.current = webgl.onChangeTextureAtlas(() => {
            scheduleFitRef.current?.();
          });
        }
      });
    }, [fontSize, fontFamily, themeName, cursorStyle, cursorBlink, scrollback]);

    useRelaySubscription((msg: ServerMessage) => {
      // NOTE: there is deliberately no auth:success re-attach here. Reconnects
      // flow through the status-dependent attach effect below, so exactly one
      // session:attach is sent per connection — two would kill and respawn the
      // PTY, replaying the capture twice.
      if (msg.type === "session:attached") {
        const prev = attachStateRef.current;
        const next = reduceAttach(prev, {
          type: "serverAttached",
          name: msg.name,
          attachId: msg.attachId,
        });
        // Stale ack for a superseded attach — ignore it rather than let it
        // corrupt the state machine.
        if (next === prev) return;
        attachStateRef.current = next;
        setAttaching(false);
        // reset(), not clear(): clear() leaves modes and the alternate buffer
        // intact, so old content bleeds through the replayed scrollback.
        terminalRef.current?.reset();
        syncSizeRef.current?.();
        return;
      }
      if (
        msg.type === "terminal:output" &&
        terminalRef.current &&
        shouldWriteOutput(attachStateRef.current)
      ) {
        terminalRef.current.write(msg.data);
      }
    });

    // Attach when the session changes *or* the connection comes up. The status
    // dependency is what fixes the mount-order race: TerminalView's effects run
    // before the parent layout has created the relay client, so the first pass
    // has nothing to send to and must re-run once the client exists.
    //
    // `status` is used purely as a re-run trigger — the decision below reads the
    // client's own status. The store can be written directly (the browser
    // `offline` event does), and trusting a value that doesn't match the live
    // socket would freeze the terminal while its connection is perfectly fine.
    useEffect(() => {
      if (!sessionName) {
        if (attachedName(attachStateRef.current)) {
          getRelayClient()?.send({ type: "session:detach" });
        }
        attachStateRef.current = reduceAttach(attachStateRef.current, {
          type: "detach",
        });
        lastSentSizeRef.current = null;
        setAttaching(false);
        return;
      }

      // Armed before any early return so a stuck attach is always surfaced,
      // whatever the reason it stalled.
      const errorTimer = setTimeout(() => {
        setAttaching(false);
        if (
          !shouldWriteOutput(attachStateRef.current) &&
          attachedName(attachStateRef.current) === sessionName &&
          // While the relay is unreachable the ConnectionBanner already says so;
          // a second "couldn't open session" toast per switch is just noise.
          getRelayClient()?.status === "connected"
        ) {
          useAlertStore
            .getState()
            .push(
              "error",
              `Couldn't open session "${sessionName}" — try again or check the relay.`,
            );
        }
      }, ATTACH_TIMEOUT_MS);

      const client = getRelayClient();
      if (!client || client.status !== "connected") {
        // Nothing to send to yet. Remember the desired session so the next run
        // (triggered by the status change) issues exactly one attach.
        attachStateRef.current = reduceAttach(attachStateRef.current, {
          type: "connectionLost",
        });
        return () => clearTimeout(errorTimer);
      }

      if (needsAttach(attachStateRef.current, sessionName)) {
        const terminal = terminalRef.current;
        const size =
          terminal && terminal.cols > 0 && terminal.rows > 0
            ? { cols: terminal.cols, rows: terminal.rows }
            : FALLBACK_SIZE;
        const attachId = nextAttachId();

        attachStateRef.current = reduceAttach(attachStateRef.current, {
          type: "requestAttach",
          name: sessionName,
          attachId,
        });
        lastSentSizeRef.current = size;
        setAttaching(true);

        client.send({
          type: "session:attach",
          name: sessionName,
          size,
          capture: true,
          attachId,
        });
        client.send({ type: "pane:list" });
        client.send({ type: "window:list" });

        if (
          useSettingsStore.getState().autoZoom &&
          window.matchMedia("(max-width: 768px)").matches
        ) {
          usePaneStore.getState().setPendingAutoZoom(true);
        }
      }

      return () => clearTimeout(errorTimer);
    }, [sessionName, status]);

    return (
      <div
        className={cn("relative", className)}
        style={{ width: "100%", height: "100%" }}
      >
        {/* Terminal container — always mounted */}
        <div
          ref={containerRef}
          className={cn("h-full w-full", !sessionName && "invisible")}
          style={{ touchAction: "manipulation" }}
        />

        {/* Attaching — pointer-events-none so keyboard/touch input still lands
            on the terminal underneath the moment output starts flowing. */}
        {sessionName && attaching && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/80 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="text-sm">
              Attaching to <span className="font-mono">{sessionName}</span>…
            </p>
          </div>
        )}

        {/* No session overlay */}
        {!sessionName && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-muted-foreground bg-background">
            <Terminal className="h-16 w-16 text-muted-foreground/20" />
            <div className="text-center">
              <p className="text-base font-semibold text-foreground">
                No session selected
              </p>
              <p className="text-sm mt-1">
                Create or select a session to get started
              </p>
            </div>
            {onCreateSession && (
              <Button
                onClick={onCreateSession}
                className="animate-pulse hover:animate-none"
              >
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

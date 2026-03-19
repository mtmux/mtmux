"use client";

import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { getTerminalTheme, terminalThemeToXterm } from "@repo/ui/terminal-themes";
import { useTerminalStore } from "@/stores/terminal-store";
import { useConnectionStore } from "@/stores/connection-store";
import { usePaneStore } from "@/stores/pane-store";
import { useSettingsStore } from "@/stores/settings-store";
import { getRelayClient } from "@/hooks/use-websocket";
import { Terminal, Loader2, Plus, WifiOff } from "lucide-react";
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
    const attachedSessionRef = useRef<string | null>(null);
    const { fontSize, fontFamily, themeName, cursorStyle, cursorBlink, scrollback } =
      useTerminalStore();
    const status = useConnectionStore((s) => s.status);

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

      try {
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
        });
        terminal.loadAddon(webglAddon);
      } catch {
        // WebGL not supported, using default canvas renderer
      }

      fitAddon.fit();

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

      // Debounced ResizeObserver
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const resizeObserver = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          fitAddon.fit();
        }, 100);
      });
      resizeObserver.observe(containerRef.current);

      return () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeObserver.disconnect();
        dataDisposable.dispose();
        resizeDisposable.dispose();
        terminal.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
        searchAddonRef.current = null;
      };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps -- terminal created once on mount

    // Update terminal options when settings change
    useEffect(() => {
      const terminal = terminalRef.current;
      if (!terminal) return;

      const theme = getTerminalTheme(themeName);
      terminal.options.fontSize = fontSize;
      terminal.options.fontFamily = fontFamily;
      terminal.options.cursorStyle = cursorStyle;
      terminal.options.cursorBlink = cursorBlink;
      terminal.options.scrollback = scrollback;
      terminal.options.theme = terminalThemeToXterm(theme);

      fitAddonRef.current?.fit();
    }, [fontSize, fontFamily, themeName, cursorStyle, cursorBlink, scrollback]);

    // Wire WebSocket output to terminal — use ref to prevent stale session output
    useEffect(() => {
      const client = getRelayClient();
      if (!client) return;

      const unsub = client.onMessage((msg: ServerMessage) => {
        if (msg.type === "terminal:output" && terminalRef.current && attachedSessionRef.current) {
          terminalRef.current.write(msg.data);
        }
      });

      return unsub;
    }, []);

    // Attach/detach to session when sessionName changes
    useEffect(() => {
      attachedSessionRef.current = sessionName;

      if (!sessionName) return;

      const client = getRelayClient();
      if (!client) return;

      const terminal = terminalRef.current;
      terminal?.clear();

      const size = terminal
        ? { cols: terminal.cols, rows: terminal.rows }
        : { cols: 80, rows: 24 };

      client.send({ type: "session:attach", name: sessionName, size, capture: true });
      client.send({ type: "pane:list" });
      client.send({ type: "window:list" });

      if (useSettingsStore.getState().autoZoom) {
        usePaneStore.getState().setPendingAutoZoom(true);
      }

      return () => {
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

        {/* Disconnected overlay — translucent banner over still-visible terminal */}
        {sessionName && status !== "connected" && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-sm">
            <div className="flex items-center gap-2 rounded-lg border bg-background/90 px-4 py-3 shadow-lg">
              {status === "reconnecting" ? (
                <Loader2 className="h-4 w-4 animate-spin text-yellow-500" />
              ) : (
                <WifiOff className="h-4 w-4 text-destructive" />
              )}
              <span className="text-sm font-medium">
                {status === "reconnecting" ? "Reconnecting..." : "Disconnected"}
              </span>
            </div>
          </div>
        )}
      </div>
    );
  },
);

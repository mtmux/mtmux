"use client";

import { useState, useCallback, useRef } from "react";
import {
  Search,
  Zap,
  Columns2,
  Rows2,
  ScrollText,
  Clipboard,
  ClipboardPaste,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { triggerHaptic } from "@repo/ui/components/haptic-button";
import { useSettingsStore } from "@/stores/settings-store";
import { useCommandStore } from "@/stores/command-store";
import { usePaneStore } from "@/stores/pane-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useUiStore } from "@/stores/ui-store";
import { useAlertStore } from "@/stores/alert-store";
import { useConnectionStore } from "@/stores/connection-store";
import { getRelayClient } from "@/hooks/use-websocket";

interface KeyboardToolbarProps {
  className?: string;
  /** #6: Callback to trigger terminal search */
  onSearchOpen?: () => void;
  onCopy?: () => void;
}

export function KeyboardToolbar({
  className,
  onSearchOpen,
  onCopy,
}: KeyboardToolbarProps) {
  const { toolbarKeys, hapticEnabled } = useSettingsStore();
  const [stickyCtrl, setStickyCtrl] = useState(false);
  const [stickyAlt, setStickyAlt] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keys that travel to the relay are dead while the socket is down; the purely
  // local ones (search, palette, font size) stay live.
  const connected = useConnectionStore((s) => s.status === "connected");

  const sendKey = useCallback(
    (key: string) => {
      const client = getRelayClient();
      if (!client || client.status !== "connected") return;

      if (hapticEnabled) triggerHaptic();

      let data = key;

      // Apply sticky modifiers
      if (stickyCtrl && key.length === 1) {
        // Convert to ctrl code
        const code = key.toUpperCase().charCodeAt(0) - 64;
        if (code > 0 && code < 27) {
          data = String.fromCharCode(code);
        }
        setStickyCtrl(false);
      } else if (stickyAlt) {
        data = "\x1b" + key;
        setStickyAlt(false);
      }

      client.send({ type: "terminal:input", data });
    },
    [stickyCtrl, stickyAlt, hapticEnabled],
  );

  const handleKeyPress = useCallback(
    (id: string, key: string) => {
      if (id === "ctrl") {
        setStickyCtrl((prev) => !prev);
        if (hapticEnabled) triggerHaptic(20);
        return;
      }
      if (id === "alt") {
        setStickyAlt((prev) => !prev);
        if (hapticEnabled) triggerHaptic(20);
        return;
      }
      sendKey(key);
    },
    [sendKey, hapticEnabled],
  );

  const handleTouchStart = useCallback(
    (_id: string) => {
      longPressTimer.current = setTimeout(() => {
        // Long press variants could show a popup
        if (hapticEnabled) triggerHaptic(30);
      }, 500);
    },
    [hapticEnabled],
  );

  const handleTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  /** Signals bypass the sticky-modifier path — they are already control codes. */
  const sendSignal = useCallback(
    (data: string) => {
      const client = getRelayClient();
      if (!client || client.status !== "connected") return;
      if (hapticEnabled) triggerHaptic();
      client.send({ type: "terminal:input", data });
    },
    [hapticEnabled],
  );

  const iconBtnClass =
    "flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground transition-colors active:bg-accent/80 active:scale-95 disabled:opacity-40 disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  const visibleKeys = toolbarKeys.filter((k) => k.visible);

  return (
    <div
      className={cn(
        "flex items-center gap-0.5 overflow-x-auto px-1 py-1 scrollbar-none",
        className,
      )}
    >
      {/* Signal buttons */}
      <button
        className={iconBtnClass}
        aria-label="Send Ctrl+C"
        disabled={!connected}
        onClick={() => sendSignal("\x03")}
      >
        <span className="text-xs font-medium">^C</span>
      </button>
      <button
        className={iconBtnClass}
        aria-label="Send Ctrl+D"
        disabled={!connected}
        onClick={() => sendSignal("\x04")}
      >
        <span className="text-xs font-medium">^D</span>
      </button>
      <button
        className={iconBtnClass}
        aria-label="Send Ctrl+Z"
        disabled={!connected}
        onClick={() => sendSignal("\x1a")}
      >
        <span className="text-xs font-medium">^Z</span>
      </button>
      <button
        className={iconBtnClass}
        aria-label="Paste"
        disabled={!connected}
        onClick={async () => {
          if (hapticEnabled) triggerHaptic();
          try {
            const text = await navigator.clipboard.readText();
            if (text) {
              const client = getRelayClient();
              client?.send({ type: "terminal:input", data: text });
            }
          } catch {
            useAlertStore.getState().push("error", "Clipboard access denied");
          }
        }}
      >
        <ClipboardPaste className="h-4 w-4" />
      </button>
      {onCopy && (
        <button
          className={iconBtnClass}
          aria-label="Copy"
          onClick={() => {
            if (hapticEnabled) triggerHaptic();
            onCopy();
          }}
        >
          <Clipboard className="h-4 w-4" />
        </button>
      )}
      {/* Search button */}
      {onSearchOpen && (
        <button
          className={iconBtnClass}
          onClick={onSearchOpen}
          aria-label="Search"
        >
          <Search className="h-4 w-4" />
        </button>
      )}
      {/* Command palette */}
      <button
        className={iconBtnClass}
        aria-label="Command palette"
        onClick={() => useCommandStore.getState().setPaletteOpen(true)}
      >
        <Zap className="h-4 w-4" />
      </button>
      {/* Split horizontal */}
      <button
        className={iconBtnClass}
        aria-label="Split horizontally"
        disabled={!connected}
        onClick={() => {
          getRelayClient()?.send({ type: "pane:split", direction: "h" });
          if (useSettingsStore.getState().autoZoom) {
            usePaneStore.getState().setPendingAutoZoom(true);
          }
          if (hapticEnabled) triggerHaptic();
        }}
      >
        <Columns2 className="h-4 w-4" />
      </button>
      {/* Split vertical */}
      <button
        className={iconBtnClass}
        aria-label="Split vertically"
        disabled={!connected}
        onClick={() => {
          getRelayClient()?.send({ type: "pane:split", direction: "v" });
          if (useSettingsStore.getState().autoZoom) {
            usePaneStore.getState().setPendingAutoZoom(true);
          }
          if (hapticEnabled) triggerHaptic();
        }}
      >
        <Rows2 className="h-4 w-4" />
      </button>
      {/* Copy mode overlay */}
      <button
        className={iconBtnClass}
        aria-label="Open copy mode"
        disabled={!connected}
        onClick={() => {
          useUiStore.getState().setCopyModeOpen(true);
          if (hapticEnabled) triggerHaptic();
        }}
      >
        <ScrollText className="h-4 w-4" />
      </button>
      {/* Zoom controls */}
      <button
        className={iconBtnClass}
        aria-label="Decrease font size"
        onClick={() => {
          const { fontSize, setFontSize } = useTerminalStore.getState();
          setFontSize(Math.max(8, fontSize - 1));
          if (hapticEnabled) triggerHaptic();
        }}
      >
        <ZoomOut className="h-4 w-4" />
      </button>
      <button
        className={iconBtnClass}
        aria-label="Increase font size"
        onClick={() => {
          const { fontSize, setFontSize } = useTerminalStore.getState();
          setFontSize(Math.min(24, fontSize + 1));
          if (hapticEnabled) triggerHaptic();
        }}
      >
        <ZoomIn className="h-4 w-4" />
      </button>
      {visibleKeys.map((key) => {
        const isSticky =
          (key.id === "ctrl" && stickyCtrl) || (key.id === "alt" && stickyAlt);

        return (
          <button
            key={key.id}
            className={cn(
              "flex h-11 min-w-11 shrink-0 items-center justify-center rounded-md border px-2 text-xs font-medium transition-colors select-none",
              "active:bg-accent/80 active:scale-95 disabled:opacity-40 disabled:active:scale-100",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              isSticky
                ? "border-primary bg-primary/20 text-primary"
                : "border-border bg-background text-foreground",
            )}
            disabled={!connected}
            onClick={() => handleKeyPress(key.id, key.key)}
            onTouchStart={() => handleTouchStart(key.id)}
            onTouchEnd={handleTouchEnd}
          >
            {key.label}
          </button>
        );
      })}
    </div>
  );
}

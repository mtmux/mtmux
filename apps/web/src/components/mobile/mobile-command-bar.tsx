"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { SendHorizonal, ArrowUp, Square, CornerDownLeft } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { triggerHaptic } from "@repo/ui/components/haptic-button";
import { useSettingsStore } from "@/stores/settings-store";
import { useConnectionStore } from "@/stores/connection-store";
import { getRelayClient } from "@/hooks/use-websocket";

interface MobileCommandBarProps {
  className?: string;
}

const keyBtnClass =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground transition-transform active:scale-95 disabled:opacity-40 disabled:active:scale-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function MobileCommandBar({ className }: MobileCommandBarProps) {
  const [command, setCommand] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { hapticEnabled } = useSettingsStore();
  // Sending into a dead socket used to clear the input anyway, so the command
  // vanished with no feedback. Nothing here is usable while disconnected.
  const connected = useConnectionStore((s) => s.status === "connected");

  // Auto-resize textarea
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "36px"; // reset to single row
    const maxHeight = 80; // ~4 rows
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [command]);

  const handleSend = useCallback(() => {
    if (!command.trim()) return;
    const client = getRelayClient();
    if (!client || client.status !== "connected") return;

    client.send({ type: "terminal:input", data: command + "\r" });
    if (hapticEnabled) triggerHaptic();
    setCommand("");
    inputRef.current?.focus();
  }, [command, hapticEnabled]);

  const sendKey = useCallback(
    (data: string) => {
      const client = getRelayClient();
      if (!client || client.status !== "connected") return;
      client.send({ type: "terminal:input", data });
      if (hapticEnabled) triggerHaptic();
    },
    [hapticEnabled],
  );

  return (
    <div
      className={cn(
        "flex items-end gap-1.5 px-2 py-1.5 border-t bg-background",
        className,
      )}
    >
      <button
        onClick={() => sendKey("\x03")}
        className={keyBtnClass}
        disabled={!connected}
        aria-label="Send Ctrl+C"
      >
        <Square className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => sendKey("\x1b[A")}
        className={keyBtnClass}
        disabled={!connected}
        aria-label="Previous command"
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => sendKey("\t")}
        className={keyBtnClass}
        disabled={!connected}
        aria-label="Send Tab"
      >
        <CornerDownLeft className="h-3.5 w-3.5" />
      </button>
      <textarea
        ref={inputRef}
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        }}
        rows={1}
        disabled={!connected}
        placeholder={connected ? "Type command..." : "Disconnected"}
        className="flex-1 min-h-[36px] max-h-[80px] resize-none rounded-md border border-border bg-muted/50 px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors disabled:opacity-60"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="send"
      />
      <button
        onClick={handleSend}
        disabled={!connected || !command.trim()}
        aria-label="Send command"
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-md transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          connected && command.trim()
            ? "bg-primary text-primary-foreground active:scale-95"
            : "bg-muted text-muted-foreground",
        )}
      >
        <SendHorizonal className="h-4 w-4" />
      </button>
    </div>
  );
}

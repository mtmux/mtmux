"use client";

import { useState, useRef, useCallback } from "react";
import { SendHorizonal, ArrowUp, Square, CornerDownLeft } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { triggerHaptic } from "@repo/ui/components/haptic-button";
import { useSettingsStore } from "@/stores/settings-store";
import { getRelayClient } from "@/hooks/use-websocket";

interface MobileCommandBarProps {
  className?: string;
}

export function MobileCommandBar({ className }: MobileCommandBarProps) {
  const [command, setCommand] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { hapticEnabled } = useSettingsStore();

  const handleSend = useCallback(() => {
    if (!command.trim()) return;
    const client = getRelayClient();
    if (!client) return;

    client.send({ type: "terminal:input", data: command + "\r" });
    if (hapticEnabled) triggerHaptic();
    setCommand("");
    inputRef.current?.focus();
  }, [command, hapticEnabled]);

  const sendKey = useCallback(
    (data: string) => {
      const client = getRelayClient();
      if (!client) return;
      client.send({ type: "terminal:input", data });
      if (hapticEnabled) triggerHaptic();
    },
    [hapticEnabled],
  );

  return (
    <div className={cn("flex items-center gap-1.5 px-2 py-1.5 border-t bg-background", className)}>
      <button
        onClick={() => sendKey("\x03")}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground active:scale-95 transition-transform"
        title="Ctrl+C"
      >
        <Square className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => sendKey("\x1b[A")}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground active:scale-95 transition-transform"
        title="Up arrow"
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => sendKey("\t")}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground active:scale-95 transition-transform"
        title="Tab"
      >
        <CornerDownLeft className="h-3.5 w-3.5" />
      </button>
      <input
        ref={inputRef}
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            handleSend();
          }
        }}
        placeholder="Type command..."
        className="flex-1 h-9 rounded-md border border-border bg-muted/50 px-3 text-sm font-mono outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="send"
      />
      <button
        onClick={handleSend}
        disabled={!command.trim()}
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors",
          command.trim()
            ? "bg-primary text-primary-foreground active:scale-95"
            : "bg-muted text-muted-foreground",
        )}
      >
        <SendHorizonal className="h-4 w-4" />
      </button>
    </div>
  );
}

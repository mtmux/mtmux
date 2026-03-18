"use client";

import { Plus, X } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { ScrollArea, ScrollBar } from "@repo/ui/components/ui/scroll-area";
import { cn } from "@repo/ui/lib/utils";
import { useSessionStore } from "@/stores/session-store";
import { getRelayClient } from "@/hooks/use-websocket";

interface SessionTabsProps {
  onCreateClick: () => void;
  className?: string;
}

export function SessionTabs({ onCreateClick, className }: SessionTabsProps) {
  const { sessions, activeSessionId, setActiveSession } = useSessionStore();

  return (
    <div className={cn("flex items-center", className)}>
      <ScrollArea className="flex-1">
        <div className="flex items-center gap-1 px-1">
          {sessions.map((session) => (
            <button
              key={session.name}
              className={cn(
                "group flex items-center gap-1.5 rounded-t-md border-b-2 px-3.5 py-1.5 text-sm transition-colors",
                session.name === activeSessionId
                  ? "border-primary bg-background text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/50",
              )}
              onClick={() => {
                setActiveSession(session.name);
                localStorage.setItem("termbridge-last-session", session.name);
              }}
            >
              <span className="truncate max-w-[120px]">{session.name}</span>
              <button
                className="hidden group-hover:inline-flex h-5 w-5 items-center justify-center rounded-sm hover:bg-destructive/20"
                onClick={(e) => {
                  e.stopPropagation();
                  getRelayClient()?.send({ type: "session:kill", name: session.name });
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </button>
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0"
        onClick={onCreateClick}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

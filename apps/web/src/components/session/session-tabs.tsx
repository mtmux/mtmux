"use client";

import { Plus, X } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { ScrollArea, ScrollBar } from "@repo/ui/components/ui/scroll-area";
import { cn } from "@repo/ui/lib/utils";
import { useSessionStore } from "@/stores/session-store";

interface SessionTabsProps {
  onCreateClick: () => void;
  className?: string;
}

export function SessionTabs({ onCreateClick, className }: SessionTabsProps) {
  const openedSessions = useSessionStore((s) => s.openedSessions);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const closeSession = useSessionStore((s) => s.closeSession);

  return (
    <div className={cn("flex items-center", className)}>
      <ScrollArea className="flex-1">
        <div className="flex items-center gap-1 px-1">
          {openedSessions.map((name) => {
            return (
              <button
                key={name}
                title={name}
                className={cn(
                  "group flex items-center gap-1.5 rounded-t-md border-b-2 px-3.5 py-1.5 text-sm transition-colors animate-in fade-in slide-in-from-bottom-1 duration-200",
                  name === activeSessionId
                    ? "border-primary bg-primary/10 text-foreground font-semibold"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/50",
                )}
                onClick={() => {
                  setActiveSession(name);
                  localStorage.setItem("termbridge-last-session", name);
                }}
              >
                <span className="truncate max-w-[120px]">{name}</span>
                <button
                  className="hidden group-hover:inline-flex h-5 w-5 items-center justify-center rounded-sm hover:bg-destructive/20"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSession(name);
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              </button>
            );
          })}
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

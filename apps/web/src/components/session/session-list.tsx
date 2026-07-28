"use client";

import { useCallback, useState, useRef } from "react";
import { Plus, RefreshCw, Terminal, Loader2 } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { ScrollArea } from "@repo/ui/components/ui/scroll-area";
import { cn } from "@repo/ui/lib/utils";
import { useSessionStore } from "@/stores/session-store";
import { useUiStore } from "@/stores/ui-store";
import { getRelayClient } from "@/hooks/use-websocket";
import { SessionCard } from "./session-card";
import { LAST_SESSION_KEY, writeStored } from "@/lib/storage-keys";

interface SessionListProps {
  onCreateClick: () => void;
  className?: string;
}

export function SessionList({ onCreateClick, className }: SessionListProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const isLoading = !sessionsLoaded;

  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const touchStartY = useRef(0);
  // The pull must only arm at the top of the list. Radix scrolls its *viewport*,
  // not the ScrollArea root — reading scrollTop off the root always gave 0, so
  // the pull fired from anywhere in the list.
  const listRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    getRelayClient()?.send({ type: "session:list" });
  }, []);

  const handleAttach = useCallback(
    (name: string) => {
      setActiveSession(name);
      if (typeof window !== "undefined") {
        writeStored(LAST_SESSION_KEY, name);
      }
      useUiStore.getState().setMobileTab("terminal");
    },
    [setActiveSession],
  );

  const handleKill = useCallback((name: string) => {
    getRelayClient()?.send({ type: "session:kill", name });
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartY.current = e.touches[0]!.clientY;
  }, []);

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      const viewport = listRef.current?.closest<HTMLElement>(
        "[data-radix-scroll-area-viewport]",
      );
      if (!viewport || viewport.scrollTop > 0 || isRefreshing) return;
      const dy = e.touches[0]!.clientY - touchStartY.current;
      if (dy > 0) {
        setPullDistance(Math.min(dy * 0.5, 80));
      }
    },
    [isRefreshing],
  );

  const handleTouchEnd = useCallback(() => {
    if (pullDistance >= 60) {
      setIsRefreshing(true);
      refresh();
      setTimeout(() => {
        setIsRefreshing(false);
        setPullDistance(0);
      }, 800);
    } else {
      setPullDistance(0);
    }
  }, [pullDistance, refresh]);

  return (
    <div className={cn("flex flex-col overflow-hidden", className)}>
      <div className="flex items-center justify-between px-3 py-1 border-b shrink-0">
        <h2 className="text-sm font-semibold">Sessions</h2>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label="Refresh sessions"
            onClick={refresh}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-11 w-11"
            aria-label="Create session"
            onClick={onCreateClick}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <ScrollArea className="h-0 flex-1">
        {(pullDistance > 0 || isRefreshing) && (
          <div
            className="flex items-center justify-center transition-all"
            style={{ height: isRefreshing ? 40 : pullDistance }}
          >
            <Loader2
              className={cn(
                "h-5 w-5 text-muted-foreground",
                isRefreshing && "animate-spin",
              )}
            />
          </div>
        )}
        <div
          ref={listRef}
          className="space-y-1.5 px-3 pb-2"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {isLoading ? (
            <>
              <div className="animate-pulse rounded-md bg-muted h-16" />
              <div className="animate-pulse rounded-md bg-muted h-16" />
              <div className="animate-pulse rounded-md bg-muted h-16" />
            </>
          ) : sessions.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <Terminal className="h-10 w-10 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">No sessions yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Create your first terminal session to get started
                </p>
              </div>
              <Button size="sm" onClick={onCreateClick}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                Create Session
              </Button>
            </div>
          ) : (
            sessions.map((session) => (
              <SessionCard
                key={session.name}
                session={session}
                isActive={session.name === activeSessionId}
                onAttach={handleAttach}
                onKill={handleKill}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

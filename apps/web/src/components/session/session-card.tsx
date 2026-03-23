"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { X, Clock, PenLine, Trash2 } from "lucide-react";
import { Card, CardContent } from "@repo/ui/components/ui/card";
import { Badge } from "@repo/ui/components/ui/badge";
import { Button } from "@repo/ui/components/ui/button";
import { Input } from "@repo/ui/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/ui/components/ui/alert-dialog";
import { cn } from "@repo/ui/lib/utils";
import { useMediaQuery } from "@repo/ui/hooks/use-media-query";
import type { SessionInfo } from "@repo/protocol";
import { getRelayClient } from "@/hooks/use-websocket";

interface SessionCardProps {
  session: SessionInfo;
  isActive: boolean;
  onAttach: (name: string) => void;
  onKill: (name: string) => void;
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function isRecentlyActive(dateStr: string): boolean {
  return (Date.now() - new Date(dateStr).getTime()) < 30_000;
}

export function SessionCard({ session, isActive, onAttach, onKill }: SessionCardProps) {
  const isMobile = useMediaQuery("(max-width: 768px)");
  const recentlyActive = isRecentlyActive(session.activity);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.name);
  const [showKillConfirm, setShowKillConfirm] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const swipeStartX = useRef(0);
  const swipeStartY = useRef(0);
  const isSwiping = useRef(false);

  // Cleanup longPressTimer on unmount
  useEffect(() => {
    return () => {
      if (longPressTimer.current) {
        clearTimeout(longPressTimer.current);
      }
    };
  }, []);

  const handleRenameSubmit = useCallback(() => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== session.name) {
      getRelayClient()?.send({ type: "session:rename", oldName: session.name, newName: trimmed });
    }
    setIsRenaming(false);
  }, [renameValue, session.name]);

  const handleNameDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameValue(session.name);
    setIsRenaming(true);
  }, [session.name]);

  const handleNameTouchStart = useCallback(() => {
    longPressTimer.current = setTimeout(() => {
      setRenameValue(session.name);
      setIsRenaming(true);
    }, 600);
  }, [session.name]);

  const handleNameTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const triggerKill = useCallback(() => {
    setShowKillConfirm(true);
  }, []);

  const handleCardTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    swipeStartX.current = touch.clientX;
    swipeStartY.current = touch.clientY;
    isSwiping.current = false;
  }, []);

  const handleCardTouchMove = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - swipeStartX.current;
    const dy = touch.clientY - swipeStartY.current;

    if (!isSwiping.current && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
      isSwiping.current = true;
    }

    if (isSwiping.current && dx < 0) {
      setSwipeOffset(Math.max(dx, -112));
    }
  }, []);

  const handleCardTouchEnd = useCallback(() => {
    if (Math.abs(swipeOffset) > 56) {
      setSwipeOffset(-112);
    } else {
      setSwipeOffset(0);
    }
    isSwiping.current = false;
  }, [swipeOffset]);

  return (
    <div className="relative overflow-hidden rounded-lg">
      {isMobile && (
        <div className="absolute inset-y-0 right-0 flex">
          <button
            className="flex w-14 flex-col items-center justify-center gap-0.5 bg-accent"
            aria-label="Rename session"
            onClick={() => {
              setRenameValue(session.name);
              setIsRenaming(true);
              setSwipeOffset(0);
            }}
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/15">
              <PenLine className="h-4 w-4 text-primary" />
            </div>
            <span className="text-[9px] text-primary font-medium">Rename</span>
          </button>
          <button
            className="flex w-14 flex-col items-center justify-center gap-0.5 bg-destructive/10"
            aria-label="Kill session"
            onClick={() => {
              triggerKill();
              setSwipeOffset(0);
            }}
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-destructive/20">
              <Trash2 className="h-4 w-4 text-destructive" />
            </div>
            <span className="text-[9px] text-destructive font-medium">Kill</span>
          </button>
        </div>
      )}
      <Card
        className={cn(
          "group cursor-pointer transition-colors hover:bg-accent/50 relative",
          isActive
            ? "bg-accent/40 ring-1 ring-primary/30"
            : recentlyActive
              ? "border-l-2 border-l-primary"
              : "",
        )}
        style={{
          transform: `translateX(${swipeOffset}px)`,
          transition: isSwiping.current ? "none" : "transform 0.2s ease-out",
        }}
        onClick={() => swipeOffset === 0 && onAttach(session.name)}
        onTouchStart={isMobile ? handleCardTouchStart : undefined}
        onTouchMove={isMobile ? handleCardTouchMove : undefined}
        onTouchEnd={isMobile ? handleCardTouchEnd : undefined}
      >
        <CardContent className="flex items-center gap-2.5 p-3.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {isRenaming ? (
                <Input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRenameSubmit();
                    if (e.key === "Escape") setIsRenaming(false);
                  }}
                  onBlur={handleRenameSubmit}
                  className="h-6 text-sm px-1"
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span
                  className="truncate font-medium text-sm"
                  onDoubleClick={handleNameDoubleClick}
                  onTouchStart={handleNameTouchStart}
                  onTouchEnd={handleNameTouchEnd}
                >
                  {session.name}
                </span>
              )}
              <Badge variant={session.attached ? "default" : "secondary"} className="text-[10px] px-1.5 py-0">
                {session.attached ? "attached" : "detached"}
              </Badge>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{session.windows} window{session.windows !== 1 ? "s" : ""}</span>
              {session.dimensions && (
                <span>{session.dimensions.cols}&times;{session.dimensions.rows}</span>
              )}
              <span className="flex items-center gap-0.5">
                <Clock className="h-3 w-3" />
                {timeAgo(session.activity)}
              </span>
            </div>
          </div>
          {!isMobile && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
              aria-label="Kill session"
              onClick={(e) => {
                e.stopPropagation();
                triggerKill();
              }}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </CardContent>
      </Card>
      <AlertDialog open={showKillConfirm} onOpenChange={setShowKillConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Kill session "{session.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently terminate the session and all its processes. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => onKill(session.name)}
            >
              Kill Session
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

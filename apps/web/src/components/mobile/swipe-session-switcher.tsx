"use client";

import { useRef, useState, useCallback } from "react";
import { cn } from "@repo/ui/lib/utils";
import { useSessionStore } from "@/stores/session-store";
import { usePaneStore } from "@/stores/pane-store";
import { useSettingsStore } from "@/stores/settings-store";
import { triggerHaptic } from "@repo/ui/components/haptic-button";
import { getRelayClient } from "@/hooks/use-websocket";

interface SwipeSessionSwitcherProps {
  children: React.ReactNode;
  className?: string;
}

export function SwipeSessionSwitcher({ children, className }: SwipeSessionSwitcherProps) {
  const { sessions, activeSessionId, setActiveSession } = useSessionStore();
  const { panes, activePaneId } = usePaneStore();
  const { gestures, hapticEnabled } = useSettingsStore();
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const [swipeX, setSwipeX] = useState(0);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]!.clientX;
    touchStartY.current = e.touches[0]!.clientY;
    setSwipeX(0);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const dx = e.touches[0]!.clientX - touchStartX.current;
    setSwipeX(dx);
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      setSwipeX(0);
      const dx = e.changedTouches[0]!.clientX - touchStartX.current;
      const dy = e.changedTouches[0]!.clientY - touchStartY.current;

      // Must be horizontal swipe (not vertical)
      if (Math.abs(dx) < 100 || Math.abs(dy) > Math.abs(dx) * 0.5) return;

      // If session has >1 pane and pane swiping is enabled, swipe between panes
      if (gestures.swipeToSwitchPanes && panes.length > 1) {
        const currentPaneIndex = panes.findIndex((p) => p.id === activePaneId);
        if (currentPaneIndex === -1) return;

        let nextPaneIndex: number;
        if (dx > 0) {
          nextPaneIndex = (currentPaneIndex - 1 + panes.length) % panes.length;
        } else {
          nextPaneIndex = (currentPaneIndex + 1) % panes.length;
        }

        const client = getRelayClient();
        if (!client) return;

        const nextPaneId = panes[nextPaneIndex]!.id;
        const { zoomedPaneId } = usePaneStore.getState();

        const { autoZoom } = useSettingsStore.getState();
        if (zoomedPaneId || autoZoom) {
          // Zoom-aware: unzoom current → select next → zoom next
          if (zoomedPaneId) {
            client.send({ type: "pane:zoom" });
          }
          client.send({ type: "pane:select", id: nextPaneId });
          client.send({ type: "pane:zoom" });
        } else {
          client.send({ type: "pane:select", id: nextPaneId });
        }

        if (hapticEnabled) triggerHaptic(15);
        return;
      }

      // Otherwise swipe between sessions
      if (!gestures.swipeToSwitchSessions) return;
      if (sessions.length < 2) return;

      const currentIndex = sessions.findIndex((s) => s.name === activeSessionId);
      if (currentIndex === -1) return;

      let nextIndex: number;
      if (dx > 0) {
        nextIndex = (currentIndex - 1 + sessions.length) % sessions.length;
      } else {
        nextIndex = (currentIndex + 1) % sessions.length;
      }

      setActiveSession(sessions[nextIndex]!.name);
      localStorage.setItem("termbridge-last-session", sessions[nextIndex]!.name);
      if (hapticEnabled) triggerHaptic(15);
    },
    [sessions, activeSessionId, setActiveSession, panes, activePaneId, gestures.swipeToSwitchSessions, gestures.swipeToSwitchPanes, hapticEnabled],
  );

  return (
    <div
      className={cn("relative touch-pan-y transition-opacity duration-75", className)}
      style={{ opacity: 1 - Math.abs(swipeX) / 400 }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {children}
    </div>
  );
}

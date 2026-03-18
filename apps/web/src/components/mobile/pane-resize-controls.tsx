"use client";

import { useRef, useCallback } from "react";
import { ArrowUp, ArrowDown, ArrowLeft, ArrowRight, X } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { usePaneStore } from "@/stores/pane-store";
import { useUiStore } from "@/stores/ui-store";
import { getRelayClient } from "@/hooks/use-websocket";

export function PaneResizeControls() {
  const { activePaneId } = usePaneStore();
  const { resizeModeActive, setResizeModeActive } = useUiStore();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const sendResize = useCallback(
    (direction: "U" | "D" | "L" | "R") => {
      if (!activePaneId) return;
      getRelayClient()?.send({
        type: "pane:resize",
        id: activePaneId,
        direction,
        amount: 5,
      });
    },
    [activePaneId],
  );

  const startRepeat = useCallback(
    (direction: "U" | "D" | "L" | "R") => {
      sendResize(direction);
      intervalRef.current = setInterval(() => sendResize(direction), 200);
    },
    [sendResize],
  );

  const stopRepeat = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  if (!resizeModeActive) return null;

  const directionButton = (
    direction: "U" | "D" | "L" | "R",
    Icon: typeof ArrowUp,
  ) => (
    <Button
      variant="outline"
      size="icon"
      className="h-12 w-12"
      onPointerDown={() => startRepeat(direction)}
      onPointerUp={stopRepeat}
      onPointerLeave={stopRepeat}
    >
      <Icon className="h-5 w-5" />
    </Button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-2">
        <p className="text-sm font-medium text-muted-foreground mb-2">Resize Pane</p>
        <div className="grid grid-cols-3 gap-2">
          <div />
          {directionButton("U", ArrowUp)}
          <div />
          {directionButton("L", ArrowLeft)}
          <Button
            variant="destructive"
            size="icon"
            className="h-12 w-12"
            onClick={() => setResizeModeActive(false)}
          >
            <X className="h-5 w-5" />
          </Button>
          {directionButton("R", ArrowRight)}
          <div />
          {directionButton("D", ArrowDown)}
          <div />
        </div>
      </div>
    </div>
  );
}

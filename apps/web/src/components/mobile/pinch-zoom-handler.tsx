"use client";

import { useRef, useCallback, useEffect } from "react";
import { cn } from "@repo/ui/lib/utils";
import { useTerminalStore } from "@/stores/terminal-store";
import { useSettingsStore } from "@/stores/settings-store";

interface PinchZoomHandlerProps {
  children: React.ReactNode;
  className?: string;
}

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 24;

export function PinchZoomHandler({
  children,
  className,
}: PinchZoomHandlerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialDistance = useRef<number | null>(null);
  const initialFontSize = useRef<number>(14);
  // touchmove fires far faster than a frame. Writing the persisted store on
  // every event re-rendered the terminal and rebuilt the WebGL character atlas
  // per event, which is what made pinch-zoom strobe. Coalesce to one write per
  // frame, and skip it entirely when the rounded size hasn't moved.
  const pendingSize = useRef<number | null>(null);
  const rafId = useRef<number | null>(null);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (e.touches.length !== 2) return;
    if (!useSettingsStore.getState().gestures.pinchToZoom) return;

    const dx = e.touches[0]!.clientX - e.touches[1]!.clientX;
    const dy = e.touches[0]!.clientY - e.touches[1]!.clientY;
    initialDistance.current = Math.sqrt(dx * dx + dy * dy);
    initialFontSize.current = useTerminalStore.getState().fontSize;
  }, []);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (e.touches.length !== 2 || initialDistance.current === null) return;

    const dx = e.touches[0]!.clientX - e.touches[1]!.clientX;
    const dy = e.touches[0]!.clientY - e.touches[1]!.clientY;
    const currentDistance = Math.sqrt(dx * dx + dy * dy);

    const scale = currentDistance / initialDistance.current;
    const newSize = Math.round(
      Math.min(
        MAX_FONT_SIZE,
        Math.max(MIN_FONT_SIZE, initialFontSize.current * scale),
      ),
    );

    pendingSize.current = newSize;
    if (rafId.current !== null) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null;
      const size = pendingSize.current;
      pendingSize.current = null;
      if (size === null) return;
      if (useTerminalStore.getState().fontSize === size) return;
      useTerminalStore.getState().setFontSize(size);
    });
  }, []);

  const handleTouchEnd = useCallback(() => {
    initialDistance.current = null;
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    el.addEventListener("touchstart", handleTouchStart, { passive: true });
    el.addEventListener("touchmove", handleTouchMove, { passive: true });
    el.addEventListener("touchend", handleTouchEnd);

    return () => {
      el.removeEventListener("touchstart", handleTouchStart);
      el.removeEventListener("touchmove", handleTouchMove);
      el.removeEventListener("touchend", handleTouchEnd);
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  return (
    <div ref={containerRef} className={cn(className)}>
      {children}
    </div>
  );
}

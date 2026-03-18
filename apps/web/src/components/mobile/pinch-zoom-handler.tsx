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

export function PinchZoomHandler({ children, className }: PinchZoomHandlerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const initialDistance = useRef<number | null>(null);
  const initialFontSize = useRef<number>(14);

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
      Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, initialFontSize.current * scale)),
    );

    useTerminalStore.getState().setFontSize(newSize);
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
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  return (
    <div ref={containerRef} className={cn(className)}>
      {children}
    </div>
  );
}

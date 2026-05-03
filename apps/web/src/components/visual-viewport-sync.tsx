"use client";

import { useEffect } from "react";

// Mirrors window.visualViewport into CSS custom properties so fixed-position
// chrome (FAB, bottom Sheet, etc.) can pin to the *visual* viewport instead of
// the layout viewport. Without this, pinch-zoom causes overlays to overflow
// the visible area horizontally / be drawn under the URL bar.
export function VisualViewportSync() {
  useEffect(() => {
    const root = document.documentElement;
    let rafId: number | null = null;

    const update = () => {
      rafId = null;
      const vv = window.visualViewport;
      const width = vv?.width ?? window.innerWidth;
      const height = vv?.height ?? window.innerHeight;
      const offsetTop = vv?.offsetTop ?? 0;
      const offsetLeft = vv?.offsetLeft ?? 0;
      const scale = vv?.scale ?? 1;

      root.style.setProperty("--vv-width", `${width}px`);
      root.style.setProperty("--vv-height", `${height}px`);
      root.style.setProperty("--vv-offset-top", `${offsetTop}px`);
      root.style.setProperty("--vv-offset-left", `${offsetLeft}px`);
      root.style.setProperty("--vv-scale", `${scale}`);
    };

    const schedule = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(update);
    };

    update();

    const vv = window.visualViewport;
    vv?.addEventListener("resize", schedule);
    vv?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      vv?.removeEventListener("resize", schedule);
      vv?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
    };
  }, []);

  return null;
}

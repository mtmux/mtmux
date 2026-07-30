"use client";

import { useEffect, useState } from "react";
import { hydrateLockState } from "@/lib/lock-store";
import { isEnrolled, isUnlocked, subscribeLock } from "@/lib/unlocked";
import { useLockLifecycle } from "@/hooks/use-lock-lifecycle";
import { LockScreen } from "./lock-screen";

/**
 * Renders the lock screen *instead of* its children while locked.
 *
 * Unmounting rather than overlaying is the whole point: xterm keeps its
 * scrollback in JS objects hanging off the component, so a hidden terminal is a
 * readable terminal. Swapping the subtree makes it garbage.
 *
 * The gate is transparent — literally a no-op — on a device with no lock
 * enrolled, which is the default and the entire self-hosted path.
 */
export function LockGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [, force] = useState(0);

  useLockLifecycle();

  useEffect(() => subscribeLock(() => force((n) => n + 1)), []);

  useEffect(() => {
    let cancelled = false;
    void hydrateLockState().finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Until the lock record has been read, render nothing rather than the
  // terminal: a flash of the shell before the lock screen appears would defeat
  // the feature on every cold load.
  if (!ready) return null;

  if (isEnrolled() && !isUnlocked()) {
    return <LockScreen onUnlocked={() => force((n) => n + 1)} />;
  }

  return <>{children}</>;
}

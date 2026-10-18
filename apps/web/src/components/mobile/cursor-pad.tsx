"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X, MoveHorizontal } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { triggerHaptic } from "@repo/ui/components/haptic-button";
import { useStableMediaQuery } from "@repo/ui/hooks/use-media-query";
import { useSettingsStore } from "@/stores/settings-store";
import { useConnectionStore } from "@/stores/connection-store";
import { sendKeySequence } from "@/lib/send-key";
import { encodeKey, NO_MODS } from "@/lib/key-codes";
import {
  aim,
  isCentreTap,
  knobOffset,
  REPEAT_DELAY_MS,
  type PadDirection,
  type PadVector,
} from "@/lib/cursor-pad";

/** The pad's drawn diameter, and the compact one for a landscape phone. */
const SIZE = 132;
const COMPACT_SIZE = 88;

const ARROW: Record<PadDirection, string> = {
  up: "up",
  down: "down",
  left: "left",
  right: "right",
};

/**
 * A thumb stick for the cursor, floating over the terminal.
 *
 * ## What it is for
 *
 * Answering the questions an agent CLI asks. Claude Code and Codex put their
 * choices in a list and the way through one is arrows and Enter — which on a
 * phone meant finding ↑ and ↓ in a toolbar strip that scrolls sideways, then
 * tapping each of them once per row, then finding Enter. Four accurate taps on
 * small targets to pick the third of three options, with nothing on screen
 * saying that is how it works.
 *
 * Here it is one gesture: push down, hold until the highlight is where you
 * want it, let go, press the middle. The middle is Enter because Enter is what
 * you were navigating towards; `esc` and `tab` sit above it because they are
 * the other two keys those lists use.
 *
 * ## Why it floats instead of sitting in the footer
 *
 * Because every pixel of footer is a pixel of terminal, and this is a control
 * somebody has open all session. At 132px it would cost a fifth of a phone
 * screen as a row; floating, it costs nothing and sits in the corner the thumb
 * is already in. The trade is that it covers a corner of the output, which is
 * why it is translucent until touched, why it can be moved to the other side,
 * and why it has its own close button.
 */
export function CursorPad() {
  const side = useSettingsStore((s) => s.cursorPadSide);
  const setSide = useSettingsStore((s) => s.setCursorPadSide);
  const close = useSettingsStore((s) => s.setCursorPadOpen);
  const haptic = useSettingsStore((s) => s.hapticEnabled);
  const connected = useConnectionStore((s) => s.status === "connected");
  const compact = useStableMediaQuery("(max-height: 520px)");

  const size = compact ? COMPACT_SIZE : SIZE;
  const radius = size / 2;

  const padRef = useRef<HTMLDivElement>(null);
  const [vector, setVector] = useState<PadVector | null>(null);
  const [direction, setDirection] = useState<PadDirection | null>(null);

  /*
   * The repeat schedule, and why it is a self-rescheduling timeout.
   *
   * The interval is not fixed: pushing further makes it shorter, and the thumb
   * moves while it is held. A `setInterval` would be locked to whatever rate
   * the thumb happened to be at when the direction was first picked, so
   * pushing to the rim mid-hold would not speed anything up. A timeout that
   * reads the current interval out of a ref on every tick does.
   */
  const timer = useRef<number | undefined>(undefined);
  const intervalRef = useRef(REPEAT_DELAY_MS);
  const directionRef = useRef<PadDirection | null>(null);
  const pressedAt = useRef(0);

  const stop = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = undefined;
    directionRef.current = null;
    setDirection(null);
  }, []);

  useEffect(() => stop, [stop]);

  const fire = useCallback((d: PadDirection) => {
    sendKeySequence(encodeKey({ kind: "named", name: d }, NO_MODS));
  }, []);

  /** Start, or re-aim, the repeat. Called only when the direction changes. */
  const steer = useCallback(
    (next: PadDirection | null) => {
      if (next === directionRef.current) return;
      if (timer.current) window.clearTimeout(timer.current);
      directionRef.current = next;
      setDirection(next);
      if (!next) return;

      if (haptic) triggerHaptic(15);
      fire(next);

      const tick = () => {
        const held = directionRef.current;
        if (!held) return;
        fire(held);
        timer.current = window.setTimeout(tick, intervalRef.current);
      };
      // The pause before the first repeat, exactly as a hardware keyboard
      // does it — so a quick push is one step, not four.
      timer.current = window.setTimeout(tick, REPEAT_DELAY_MS);
    },
    [fire, haptic],
  );

  /** The pointer's offset from the pad's centre — a true stick, not a drag. */
  const vectorFor = useCallback((e: PointerEvent | React.PointerEvent) => {
    const rect = padRef.current?.getBoundingClientRect();
    if (!rect) return { dx: 0, dy: 0 };
    return {
      dx: e.clientX - (rect.left + rect.width / 2),
      dy: e.clientY - (rect.top + rect.height / 2),
    };
  }, []);

  /**
   * The pointer being tracked, and the listeners tracking it.
   *
   * ## Why the window, and not pointer capture
   *
   * `setPointerCapture` is the textbook answer and it is not enough. The thumb
   * leaves the pad on every hard push — the fastest repeat rate is *at the
   * rim* — so the moves that matter most happen off the element, and relying on
   * React's `onPointerMove` plus a `hasPointerCapture` guard meant the pad did
   * nothing at all on WebKit. The lab suite caught it: `lab-webkit` and
   * `lab-tablet` (both of which are WebKit, despite the names) failed the one
   * assertion that pushes the stick, while Chromium passed.
   *
   * Listening on the window is strictly more robust and not more code. Capture
   * is still requested, because where it works it keeps the events coherent if
   * something else on the page would otherwise claim them — but nothing
   * depends on it succeeding.
   */
  const activePointer = useRef<number | null>(null);

  const release = useCallback(() => {
    activePointer.current = null;
    stop();
    setVector(null);
  }, [stop]);

  const onDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      activePointer.current = e.pointerId;
      try {
        padRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // Firefox throws for a pointer it no longer considers active, and
        // WebKit is inconsistent for mouse. Neither is a reason to stop: the
        // window listeners below are what actually drive the stick.
      }
      pressedAt.current = Date.now();
      const v = vectorFor(e);
      setVector(v);
      const next = aim(v, radius);
      intervalRef.current = next.intervalMs;
      steer(next.direction);
    },
    [radius, steer, vectorFor],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (activePointer.current !== e.pointerId) return;
      const v = vectorFor(e);
      setVector(v);
      const next = aim(v, radius);
      intervalRef.current = next.intervalMs;
      steer(next.direction);
    };

    const onUp = (e: PointerEvent) => {
      if (activePointer.current !== e.pointerId) return;
      const v = vectorFor(e);
      const elapsed = Date.now() - pressedAt.current;
      release();
      /*
       * A press in the middle that went nowhere is Enter.
       *
       * Checked on release rather than on press, because until the finger
       * lifts there is no way to tell a tap from the beginning of a push —
       * and sending Enter on press would submit the moment anyone rested a
       * thumb on the pad.
       */
      if (isCentreTap(v, radius, elapsed)) {
        if (haptic) triggerHaptic();
        sendKeySequence(encodeKey({ kind: "named", name: "enter" }, NO_MODS));
      }
    };

    const onCancel = (e: PointerEvent) => {
      if (activePointer.current !== e.pointerId) return;
      release();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [haptic, radius, release, steer, vectorFor]);

  const knob = vector ? knobOffset(vector, radius - 18) : { dx: 0, dy: 0 };
  const active = vector !== null;

  return (
    /*
     * Pinned to the bottom of `<main>`, which is the line the footer starts at.
     *
     * ## Why not in the footer, where it visually belongs
     *
     * It was, as a zero-height box with the control positioned above it, and it
     * looked right in Chromium. It was not right: the footer carries
     * `backdrop-blur`, and `backdrop-filter` creates a stacking context — so
     * the pad's `z-30` was resolved *inside the footer*, and the footer as a
     * whole paints below `<main>`, which is positioned. The pad was painted
     * over the terminal and hit-tested underneath it.
     *
     * Chromium happened to deliver the press anyway; WebKit did not, and
     * `elementFromPoint` at the middle of the pad returned
     * `canvas.xterm-link-layer`. Three lab projects failed on it. Anchoring to
     * `<main>` — which is `relative`, so this `z-30` lands in the same stacking
     * context as the terminal — makes the paint order and the hit test agree,
     * on every engine, rather than on one.
     */
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 h-0">
      <div
        className={cn(
          "pointer-events-auto absolute bottom-3 flex flex-col items-center gap-1.5 transition-opacity",
          side === "right" ? "right-3" : "left-3",
          active ? "opacity-100" : "opacity-60",
        )}
        data-cursor-pad
        data-side={side}
      >
        {/* esc and tab, because the lists this exists for use all three. */}
        <div className="flex gap-1">
          {[
            { id: "pad-esc", label: "esc", seq: "\x1b" },
            { id: "pad-tab", label: "tab", seq: "\t" },
          ].map((k) => (
            <button
              key={k.id}
              type="button"
              data-key={k.id}
              disabled={!connected}
              aria-label={k.label}
              onPointerDown={(e) => {
                e.preventDefault();
                if (haptic) triggerHaptic(20);
                sendKeySequence(k.seq);
              }}
              className="flex h-8 w-12 items-center justify-center rounded-full border border-border bg-background/90 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur disabled:opacity-40"
            >
              {k.label}
            </button>
          ))}
          <button
            type="button"
            aria-label="Move the pad to the other side"
            data-pad-flip
            onPointerDown={(e) => {
              e.preventDefault();
              if (haptic) triggerHaptic(20);
              setSide(side === "right" ? "left" : "right");
            }}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background/90 text-muted-foreground shadow-sm backdrop-blur"
          >
            <MoveHorizontal className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label="Hide the cursor pad"
            data-pad-close
            onPointerDown={(e) => {
              e.preventDefault();
              if (haptic) triggerHaptic(20);
              close(false);
            }}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background/90 text-muted-foreground shadow-sm backdrop-blur"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>

        <div
          ref={padRef}
          data-pad-surface
          role="application"
          aria-label="Cursor pad — push for the arrow keys, press the middle for Enter"
          aria-disabled={!connected}
          style={{ width: size, height: size, touchAction: "none" }}
          onPointerDown={connected ? onDown : undefined}
          onContextMenu={(e) => e.preventDefault()}
          className={cn(
            "relative flex items-center justify-center rounded-full border shadow-lg backdrop-blur",
            "border-border bg-background/80",
            !connected && "opacity-40",
          )}
        >
          {/* The four hints. A round control with no labels does not say what
              it does, and every one of these is the key it sends. */}
          {(["up", "down", "left", "right"] as const).map((d) => (
            <span
              key={d}
              aria-hidden
              data-pad-hint={ARROW[d]}
              className={cn(
                "absolute text-[11px] transition-colors",
                direction === d ? "text-primary" : "text-muted-foreground/60",
                d === "up" && "top-1",
                d === "down" && "bottom-1",
                d === "left" && "left-1.5",
                d === "right" && "right-1.5",
              )}
            >
              {d === "up" ? "↑" : d === "down" ? "↓" : d === "left" ? "←" : "→"}
            </span>
          ))}

          {/* The knob. Centred when idle, under the thumb when not. */}
          <div
            data-pad-knob
            aria-hidden
            style={{
              transform: `translate(${knob.dx}px, ${knob.dy}px)`,
              transition: active ? "none" : "transform 140ms ease-out",
            }}
            className={cn(
              "flex h-12 w-12 items-center justify-center rounded-full border text-[11px] font-semibold",
              active
                ? "border-primary bg-primary/25 text-primary"
                : "border-border bg-muted text-muted-foreground",
            )}
          >
            ⏎
          </div>
        </div>
      </div>
    </div>
  );
}

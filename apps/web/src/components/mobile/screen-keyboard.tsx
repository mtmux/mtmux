"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Gamepad2 } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { triggerHaptic } from "@repo/ui/components/haptic-button";
import { useSettingsStore } from "@/stores/settings-store";
import { useConnectionStore } from "@/stores/connection-store";
import { sendKeySequence } from "@/lib/send-key";
import { encodeKey, type Mods } from "@/lib/key-codes";
import {
  afterKey,
  anyHeld,
  cycleLatch,
  modsFrom,
  NO_LATCHES,
  type Latches,
} from "@/lib/mod-latch";
import {
  dismissNativeKeyboard,
  setNativeKeyboardSuppressed,
} from "@/lib/native-keyboard";
import {
  capLabel,
  LAYER_ORDER,
  LAYERS,
  type KeyCap,
} from "./screen-keyboard-layouts";

/** How long a press has to last before the long-press alternate fires. */
const HOLD_MS = 400;

/** Key repeat, once a repeating key has been held past `HOLD_MS`. */
const REPEAT_MS = 60;

/**
 * The height of a keycap, as arithmetic on the viewport rather than a number.
 *
 * ## Why this is not simply `h-11`
 *
 * Because a phone in landscape is about 340 usable CSS pixels tall, and four
 * 44px rows plus the switcher plus the toolbar is 256 of them. The lab suite
 * found this the hard way: on `lab-landscape` the terminal element measured
 * **zero pixels high** and every assertion failed, because `AppShell` gives the
 * footer what it asks for and the flexible middle whatever is left. A keyboard
 * that squeezes the terminal out of existence is worse than no keyboard.
 *
 * A media-query breakpoint was the first attempt and it is the wrong shape: it
 * picks one of two heights for a continuum, so it is wrong just above and just
 * below wherever the breakpoint is put, and it cannot know about a browser's
 * own chrome. `clamp` describes the actual constraint — the board may have
 * roughly four-elevenths of the viewport, never less than a usable 26px per
 * row and never more than the 44px tap-target floor.
 *
 * `--vv-height` is the *visual* viewport, which `VisualViewportSync` keeps
 * current; `100dvh` is the fallback, and the two agree except on iOS Safari,
 * which is exactly the browser where the difference matters.
 */
const KEY_HEIGHT =
  "clamp(26px, calc((var(--vv-height, 100dvh) - 160px) / 11), 44px)";

/**
 * The app's own keyboard.
 *
 * ## Why not use the one the phone came with
 *
 * Because it cannot send what a terminal needs. A soft keyboard has no Ctrl,
 * no Alt, no Esc and no arrows, and — the part that is easy to miss — the keys
 * it *does* have arrive through xterm's own hidden textarea, so nothing in
 * this app can modify them on the way past. That is why `KeyboardToolbar`'s
 * sticky Ctrl has always carried a note admitting it does not apply to typed
 * characters: tapping Ctrl and then `c` on the platform keyboard sends a
 * literal `c`. Not a bug in the latch; a consequence of borrowing somebody
 * else's keyboard.
 *
 * Render our own and every keystroke passes through `encodeKey`, which means
 * Ctrl+C, Alt+f, Shift+Tab, Ctrl+Alt+Backspace and `ESC ESC` all simply work,
 * on every platform, with no per-browser special cases. The incidental wins are
 * most of the reason to keep it: no autocorrect rewriting a flag, no
 * autocapitalise on the first word of a command, no zoom-on-focus, no IME
 * eating an Enter, and a keyboard whose height we know exactly — so the
 * terminal above it can be fitted rather than guessed at.
 *
 * ## What it costs
 *
 * No dictation, no swipe typing, no personal dictionary, and whatever muscle
 * memory the user has for their own keyboard's layout. Which is why this is a
 * toggle and not a replacement: the platform keyboard is still one tap away,
 * and the command composer — where prose gets typed — still uses it.
 */
export function ScreenKeyboard({ className }: { className?: string }) {
  const layer = useSettingsStore((s) => s.screenKeyboardLayer);
  const setLayer = useSettingsStore((s) => s.setScreenKeyboardLayer);
  const close = useSettingsStore((s) => s.setScreenKeyboardOpen);
  const togglePad = useSettingsStore((s) => s.toggleCursorPad);
  const padOpen = useSettingsStore((s) => s.cursorPadOpen);
  const haptic = useSettingsStore((s) => s.hapticEnabled);
  const connected = useConnectionStore((s) => s.status === "connected");
  const [latches, setLatches] = useState<Latches>(NO_LATCHES);

  const mods = modsFrom(latches);

  /*
   * Keep the platform keyboard down for as long as ours is up.
   *
   * Both at once is not a cosmetic clash: the native keyboard covers the lower
   * half of the viewport, `AppShell` sizes itself to the visual viewport, and
   * the footer this board lives in is what gets squeezed out.
   */
  useEffect(() => {
    setNativeKeyboardSuppressed(true);
    dismissNativeKeyboard();
    return () => setNativeKeyboardSuppressed(false);
  }, []);

  const send = useCallback(
    (cap: KeyCap, extra?: Partial<Mods>) => {
      if (!cap.send) return;
      const effective: Mods = { ...mods, ...extra };
      const bytes = encodeKey(cap.send, effective);
      sendKeySequence(bytes);
      setLatches(afterKey);
    },
    [mods],
  );

  /*
   * One timer set, not one per key.
   *
   * A finger that leaves a key without a `pointerup` — dragged off, cancelled
   * by a system gesture, interrupted by a call — would otherwise leave an
   * interval running and a key repeating into the shell forever. Holding the
   * handles in a ref that every key shares means any new press, and the
   * unmount, clears whatever the last one left behind.
   */
  const timers = useRef<{ hold?: number; repeat?: number }>({});
  const consumed = useRef(false);

  const clearTimers = useCallback(() => {
    if (timers.current.hold) window.clearTimeout(timers.current.hold);
    if (timers.current.repeat) window.clearInterval(timers.current.repeat);
    timers.current = {};
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const [pressed, setPressed] = useState<string | null>(null);

  const onDown = useCallback(
    (cap: KeyCap) => {
      clearTimers();
      consumed.current = false;
      setPressed(cap.id);

      if (cap.action) {
        if (haptic) triggerHaptic(20);
        if (cap.action.kind === "mod") {
          const mod = cap.action.mod;
          setLatches((prev) => ({ ...prev, [mod]: cycleLatch(prev[mod]) }));
        } else {
          setLayer(cap.action.to);
        }
        consumed.current = true;
        return;
      }

      /*
       * A cap with a long-press alternate commits on release, not on press.
       *
       * Otherwise holding `c` would send `c` and *then* `^C`, putting a stray
       * character in front of every interrupt. Committing on release is also
       * what iOS does with its own letter keys, so it does not read as lag —
       * and the cap still lights up on press, which is the feedback people are
       * actually watching for.
       */
      if (cap.hold) {
        timers.current.hold = window.setTimeout(() => {
          consumed.current = true;
          if (haptic) triggerHaptic(30);
          const alt = cap.hold!;
          sendKeySequence(encodeKey(alt.send, { ...mods, ...alt.mods }));
          setLatches(afterKey);
        }, HOLD_MS);
        return;
      }

      send(cap);
      consumed.current = true;

      if (cap.repeat) {
        timers.current.hold = window.setTimeout(() => {
          timers.current.repeat = window.setInterval(() => {
            if (!cap.send) return;
            // Deliberately not `send`: a repeat must not re-apply a one-shot
            // latch that the first press already spent, and must not keep
            // calling `afterKey` on every tick.
            sendKeySequence(encodeKey(cap.send, mods));
          }, REPEAT_MS);
        }, HOLD_MS);
      }
    },
    [clearTimers, haptic, mods, send, setLayer],
  );

  const onUp = useCallback(
    (cap: KeyCap) => {
      clearTimers();
      setPressed(null);
      if (consumed.current) return;
      send(cap);
    },
    [clearTimers, send],
  );

  const onCancel = useCallback(() => {
    clearTimers();
    setPressed(null);
    consumed.current = true;
  }, [clearTimers]);

  const board = LAYERS[layer];

  return (
    <div
      className={cn("select-none border-t bg-muted/40", className)}
      data-screen-keyboard
      // The board is a keyboard, not a document: a swipe across it must not
      // scroll the page or pinch-zoom the terminal behind it.
      style={{ touchAction: "none" }}
      role="group"
      aria-label="On-screen keyboard"
    >
      {/* The switcher. Three boards, the pad, and the way out. */}
      <div className="flex items-center gap-1 px-1.5 pt-1.5">
        <div
          className="flex flex-1 items-center gap-0.5 rounded-md bg-background/70 p-0.5"
          role="tablist"
          aria-label="Keyboard layout"
        >
          {LAYER_ORDER.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={layer === name}
              data-layer-tab={name}
              onPointerDown={(e) => {
                e.preventDefault();
                if (haptic) triggerHaptic(20);
                setLayer(name);
              }}
              className={cn(
                "h-8 flex-1 rounded text-[11px] font-medium transition-colors",
                layer === name
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground",
              )}
            >
              {LAYERS[name].tab}
            </button>
          ))}
        </div>
        {/*
          The pad's toggle sits here rather than in the toolbar above, because
          this is where somebody is when they discover they need it: halfway
          through answering an option list with the arrow keys.
        */}
        <button
          type="button"
          aria-label={padOpen ? "Hide the cursor pad" : "Show the cursor pad"}
          aria-pressed={padOpen}
          data-pad-toggle
          onPointerDown={(e) => {
            e.preventDefault();
            if (haptic) triggerHaptic(20);
            togglePad();
          }}
          className={cn(
            "flex h-8 w-9 shrink-0 items-center justify-center rounded-md border transition-colors",
            padOpen
              ? "border-primary bg-primary/20 text-primary"
              : "border-border bg-background text-muted-foreground",
          )}
        >
          <Gamepad2 className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Hide the on-screen keyboard"
          data-keyboard-hide
          onPointerDown={(e) => {
            e.preventDefault();
            if (haptic) triggerHaptic(20);
            close(false);
          }}
          className="flex h-8 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground"
        >
          <ChevronDown className="h-4 w-4" aria-hidden />
        </button>
      </div>

      <div className="flex flex-col gap-1 p-1.5">
        {board.rows.map((row, index) => (
          <div
            key={`${board.name}-${index}`}
            className="flex gap-1"
            // The letters board's home row is inset, the way every phone
            // keyboard insets it — it is what makes the staggered shape
            // readable as QWERTY rather than as a grid of thirty buttons.
            style={
              board.name === "letters" && index === 1
                ? { paddingLeft: "5%", paddingRight: "5%" }
                : undefined
            }
          >
            {row.map((cap) => {
              const held =
                cap.action?.kind === "mod" ? latches[cap.action.mod] : "off";
              return (
                <button
                  key={cap.id}
                  type="button"
                  data-key={cap.id}
                  // Keys that travel are dead while the socket is; the ones
                  // that only change the board stay live, so somebody can get
                  // back to the letters while they wait for a reconnect.
                  disabled={!connected && !cap.action}
                  aria-label={cap.hint ?? cap.label}
                  aria-pressed={
                    cap.action?.kind === "mod" ? held !== "off" : undefined
                  }
                  data-latch={cap.action?.kind === "mod" ? held : undefined}
                  /*
                   * `preventDefault` on press, so the cap never takes focus.
                   *
                   * A focused button is a terminal that is *not* focused — the
                   * cursor stops blinking, and tmux is told the pane lost
                   * focus, which some full-screen programs redraw for. The
                   * press is handled here in `onPointerDown` anyway, so there
                   * is nothing the default behaviour was contributing.
                   */
                  onPointerDown={(e) => {
                    e.preventDefault();
                    onDown(cap);
                  }}
                  onPointerUp={() => onUp(cap)}
                  onPointerLeave={onCancel}
                  onPointerCancel={onCancel}
                  // `onContextMenu` because a long press on Android raises the
                  // context menu over the key being held.
                  onContextMenu={(e) => e.preventDefault()}
                  style={{
                    flexGrow: cap.width ?? 1,
                    flexBasis: 0,
                    height: KEY_HEIGHT,
                  }}
                  className={cn(
                    "relative flex min-w-0 items-center justify-center rounded-md border text-sm font-medium",
                    "transition-[background-color,transform] duration-75",
                    pressed === cap.id && "scale-95 bg-accent",
                    held !== "off"
                      ? "border-primary bg-primary/20 text-primary"
                      : cap.tone === "accent"
                        ? "border-primary/40 bg-primary/10 text-foreground"
                        : cap.tone === "danger"
                          ? "border-destructive/40 bg-destructive/10 text-destructive"
                          : cap.tone === "muted"
                            ? "border-border bg-background/60 text-muted-foreground"
                            : "border-border bg-background text-foreground",
                    "disabled:opacity-40",
                  )}
                >
                  {/* `data-cap-label` so a test can ask what the cap reads
                      without the corner alternate below being part of the
                      answer. */}
                  <span data-cap-label className="truncate px-0.5">
                    {capLabel(cap, mods)}
                  </span>
                  {/*
                    The alternate, printed small in the corner.

                    Holding `c` to get `^C` is the single best thing about this
                    board and it is invisible unless the cap says so. Hidden
                    once Ctrl is latched, because at that point the *main*
                    label is already showing the control code and two of them
                    on one cap reads as a mistake.
                  */}
                  {cap.hold && !mods.ctrl && (
                    <span
                      aria-hidden
                      className="absolute right-0.5 top-0 text-[8px] leading-tight text-muted-foreground/70"
                    >
                      {cap.hold.label}
                    </span>
                  )}
                  {/*
                    A locked modifier gets a bar under it. `once` is the filled
                    cap on its own; a lock is a different promise — it survives
                    the next key — and needs to look different.
                  */}
                  {held === "locked" && (
                    <span
                      aria-hidden
                      className="absolute bottom-1 h-0.5 w-4 rounded-full bg-primary"
                    />
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/*
        What is armed, in words, for a screen reader and for anyone who armed
        something and then looked away. Rendered only when something is held,
        so it costs no height in the common case.
      */}
      {anyHeld(latches) && (
        <div
          className="px-2 pb-1 text-center text-[10px] text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {(["ctrl", "alt", "shift"] as const)
            .filter((m) => latches[m] !== "off")
            .map((m) => `${m}${latches[m] === "locked" ? " (locked)" : ""}`)
            .join(" + ")}{" "}
          held
        </div>
      )}
    </div>
  );
}

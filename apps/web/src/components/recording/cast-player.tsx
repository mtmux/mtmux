"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import {
  compileCast,
  parseCast,
  sliceBetween,
  sliceUpTo,
  textOf,
  type Cast,
} from "@repo/cast";

import { useTerminalStore } from "@/stores/terminal-store";
import {
  initialPlayerState,
  playerReducer,
  type PlayerState,
} from "@/lib/player-clock";
import { createXterm, type XtermBundle } from "@/lib/xterm-factory";

import { PlayerControls } from "./player-controls";

/**
 * Play a `.cast` back in a real xterm.
 *
 * ## Why seeking is expensive, and what is done about it
 *
 * A terminal's state is a fold over every byte that came before it, and
 * xterm.js exposes no way to snapshot or restore that fold. So seeking
 * backwards means `reset()` and replaying the whole prefix — linear in bytes,
 * with no keyframe shortcut available at any price. That is why
 * `MAX_RECORDING_BYTES` on the relay is 16 MiB, and why `player-clock.ts`
 * distinguishes a backward seek (redraw) from a forward one (append) rather
 * than redrawing on every frame.
 *
 * The replay itself is chunked into 1 MiB `terminal.write(chunk, cb)` calls
 * chained on the callback, so a long prefix never blocks the main thread in one
 * go and the "seeking" state has a chance to render.
 */

/** How much is handed to xterm in one `write`, so the main thread stays free. */
const WRITE_CHUNK_BYTES = 1024 * 1024;

function splitForWrite(text: string): string[] {
  if (text.length <= WRITE_CHUNK_BYTES) return text ? [text] : [];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += WRITE_CHUNK_BYTES) {
    out.push(text.slice(i, i + WRITE_CHUNK_BYTES));
  }
  return out;
}

export type CastPlayerProps = {
  /** The raw `.cast` text. */
  source: string;
  title?: string;
  /**
   * What the relay's index says about this recording being cut off.
   *
   * OR'd with what the parser found, because the two catch different things: a
   * `kill -9` mid-write leaves a torn last line the parser sees, but a recording
   * the startup sweep closed from its own row can be byte-perfect on disk and
   * still be missing its ending. Only the index knows about the second.
   */
  truncated?: boolean;
};

export function CastPlayer({ source, title, truncated }: CastPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XtermBundle | null>(null);
  const [cast, setCast] = useState<Cast | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [seeking, setSeeking] = useState(false);

  const themeName = useTerminalStore((s) => s.themeName);
  const fontSize = useTerminalStore((s) => s.fontSize);
  const fontFamily = useTerminalStore((s) => s.fontFamily);

  const [state, dispatch] = useReducer(playerReducer, initialPlayerState()) as [
    PlayerState,
    React.Dispatch<Parameters<typeof playerReducer>[1]>,
  ];

  // Parse once, and keep the compiled view so `duration` and the byte totals
  // are not recomputed on every render.
  const compiled = cast ? compileCast(cast) : null;

  useEffect(() => {
    try {
      const parsed = parseCast(source);
      setCast(parsed);
      setParseError(null);
    } catch (err) {
      setCast(null);
      setParseError(
        err instanceof Error ? err.message : "Unreadable recording",
      );
    }
  }, [source]);

  useEffect(() => {
    if (!cast) return;
    dispatch({
      type: "load",
      duration: cast.events[cast.events.length - 1]?.time ?? 0,
    });
  }, [cast]);

  // Build the terminal once the cast is known, because its header carries the
  // size the recording was made at and resizing after the fact reflows
  // everything that has already been written.
  useEffect(() => {
    if (!containerRef.current || !cast) return;
    const bundle = createXterm({
      container: containerRef.current,
      themeName,
      fontSize,
      fontFamily,
      cursorBlink: false,
      // There is nothing to type into. Without this, xterm renders a caret and
      // takes focus, which invites a keystroke that goes nowhere.
      disableStdin: true,
      cols: cast.header.width,
      rows: cast.header.height,
    });
    xtermRef.current = bundle;

    /*
     * Fit only once the container has a real box.
     *
     * `fitAddon.fit()` divides the container's size by the cell size, so on a
     * container that is still zero-height — which it is on the first paint,
     * inside a flex column that has not resolved yet — it computes a
     * non-positive row count and xterm throws `RangeError: Invalid array
     * length` out of its buffer allocation, taking the whole player down behind
     * the error boundary.
     *
     * A `ResizeObserver` rather than a one-shot timeout: the same callback then
     * handles a rotated phone and a collapsed sidebar too.
     */
    const safeFit = () => {
      const box = containerRef.current?.getBoundingClientRect();
      if (!box || box.width < 1 || box.height < 1) return;
      try {
        bundle.fitAddon.fit();
      } catch {
        // Renderer not ready. The observer fires again.
      }
    };
    safeFit();
    const observer = new ResizeObserver(safeFit);
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      bundle.terminal.dispose();
      xtermRef.current = null;
    };
    // Rebuilding on a theme or font change is correct: xterm reflows, and the
    // redraw effect below repaints the current playhead straight after.
  }, [cast, themeName, fontSize, fontFamily]);

  /** Write a run of events, chunked so the main thread is never held. */
  const write = useCallback((text: string): Promise<void> => {
    const terminal = xtermRef.current?.terminal;
    if (!terminal || text === "") return Promise.resolve();

    const chunks = splitForWrite(text);
    return new Promise<void>((resolve) => {
      const step = (i: number) => {
        if (i >= chunks.length) {
          resolve();
          return;
        }
        terminal.write(chunks[i]!, () => step(i + 1));
      };
      step(0);
    });
  }, []);

  // The one effect that paints. A backward move resets and replays the prefix;
  // a forward one appends only what is new.
  useEffect(() => {
    if (!cast || !xtermRef.current) return;
    let cancelled = false;

    void (async () => {
      if (state.needsRedraw) {
        setSeeking(true);
        xtermRef.current?.terminal.reset();
        await write(textOf(sliceUpTo(cast, state.t)));
        if (!cancelled) setSeeking(false);
        return;
      }
      await write(textOf(sliceBetween(cast, state.previousT, state.t)));
    })();

    return () => {
      cancelled = true;
    };
  }, [cast, state.t, state.previousT, state.needsRedraw, write]);

  // The clock. `requestAnimationFrame` lives here and nowhere else; everything
  // it decides lives in `player-clock.ts`.
  useEffect(() => {
    if (!state.playing) return;
    let frame = 0;
    let last = performance.now();

    const tick = (now: number) => {
      const deltaMs = now - last;
      last = now;
      dispatch({ type: "advance", deltaMs });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame);
  }, [state.playing]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === " ") {
        event.preventDefault();
        dispatch({ type: "toggle" });
      }
      if (event.key === "ArrowLeft") {
        dispatch({ type: "seek", t: state.t - 5 });
      }
      if (event.key === "ArrowRight") {
        dispatch({ type: "seek", t: state.t + 5 });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.t]);

  if (parseError) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-sm text-foreground">
        <p className="font-medium">This recording could not be read.</p>
        <p className="mt-1 text-muted-foreground">{parseError}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-background">
        <div ref={containerRef} className="h-full w-full" />
        {seeking ? (
          <div
            role="status"
            className="pointer-events-none absolute inset-0 grid place-items-center bg-background/60 text-sm text-muted-foreground"
          >
            Seeking…
          </div>
        ) : null}
      </div>

      <PlayerControls
        state={state}
        dispatch={dispatch}
        title={title ?? cast?.header.title}
        truncated={(cast?.truncated ?? false) || truncated === true}
        totalBytes={compiled?.totalBytes ?? 0}
      />
    </div>
  );
}

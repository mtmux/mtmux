/**
 * The playhead, as a reducer over wall-clock ticks.
 *
 * Pure, and deliberately holds no `requestAnimationFrame` — the rAF loop lives
 * in the component, and everything that decides *where* the playhead lands
 * lives here. Same split as `@repo/cast`'s `timeline.ts` and, before it, the
 * marketing replay engine: this repo's vitest runs `environment: "node"`
 * everywhere, so a thing that cannot be tested without a browser is a thing
 * that will not be tested.
 *
 * Playback state stays component-local `useReducer` rather than Zustand.
 * `t` changes at 60 Hz, and `terminal-toolbar.tsx` already records what putting
 * a value like that in a global store costs: every subscriber re-renders on
 * every frame.
 */

export type PlayerState = {
  /** Seconds into the recording. */
  t: number;
  playing: boolean;
  /** 1 is real time. */
  speed: number;
  duration: number;
  /**
   * True when `t` moved backwards, or jumped.
   *
   * The component watches this: a terminal's state is a fold over every byte
   * before it and xterm cannot be snapshotted, so a backward move means
   * `reset()` and a replay of the whole prefix. Forward motion appends, which
   * is cheap; this flag is what tells the two apart.
   */
  needsRedraw: boolean;
  /** The playhead before the last action, so the component knows what to append. */
  previousT: number;
};

export type PlayerAction =
  | { type: "play" }
  | { type: "pause" }
  | { type: "toggle" }
  | { type: "seek"; t: number }
  | { type: "speed"; speed: number }
  | { type: "advance"; deltaMs: number }
  | { type: "load"; duration: number };

export const SPEEDS = [0.5, 1, 2, 4] as const;

export function initialPlayerState(duration = 0): PlayerState {
  return {
    t: 0,
    playing: false,
    speed: 1,
    duration,
    needsRedraw: true,
    previousT: 0,
  };
}

function clamp(t: number, duration: number): number {
  if (!Number.isFinite(t) || t < 0) return 0;
  return Math.min(t, duration);
}

export function playerReducer(
  state: PlayerState,
  action: PlayerAction,
): PlayerState {
  switch (action.type) {
    case "load":
      return { ...initialPlayerState(action.duration) };

    case "play":
      // Pressing play at the end restarts, which is what every player does and
      // is strictly better than a button that appears to do nothing.
      if (state.t >= state.duration) {
        return {
          ...state,
          t: 0,
          previousT: state.t,
          playing: true,
          needsRedraw: true,
        };
      }
      return {
        ...state,
        playing: true,
        needsRedraw: false,
        previousT: state.t,
      };

    case "pause":
      return {
        ...state,
        playing: false,
        needsRedraw: false,
        previousT: state.t,
      };

    case "toggle":
      return playerReducer(state, {
        type: state.playing ? "pause" : "play",
      });

    case "speed":
      return {
        ...state,
        speed: action.speed > 0 ? action.speed : state.speed,
        needsRedraw: false,
        previousT: state.t,
      };

    case "seek": {
      const t = clamp(action.t, state.duration);
      return {
        ...state,
        t,
        previousT: state.t,
        // Backwards is a redraw; forwards is an append. Seeking to exactly
        // where we already are is neither, and must not cost a full replay —
        // a scrubber emits a stream of those while a finger is held still.
        needsRedraw: t < state.t,
      };
    }

    case "advance": {
      if (!state.playing) return state;
      const t = clamp(
        state.t + (action.deltaMs / 1000) * state.speed,
        state.duration,
      );
      return {
        ...state,
        t,
        previousT: state.t,
        needsRedraw: false,
        // Stopping at the end rather than looping: a recording that silently
        // restarted would look like one that never ended.
        playing: t < state.duration,
      };
    }

    default:
      return state;
  }
}

/** The next speed in the cycle, for a single tap-through control. */
export function nextSpeed(speed: number): number {
  const index = SPEEDS.indexOf(speed as (typeof SPEEDS)[number]);
  return SPEEDS[(index + 1) % SPEEDS.length]!;
}

/** `m:ss`, or `h:mm:ss` past an hour. */
export function formatTimecode(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

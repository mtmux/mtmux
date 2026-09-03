import { create } from "zustand";

import type { RecordingInfo } from "@repo/protocol";

/**
 * The list of recordings on the connected machine.
 *
 * The *list* lives here because several places need it — the `/r` route, the
 * toolbar's record button, an alert when one stops on its own — and it changes
 * a handful of times a session.
 *
 * Playback state does **not** live here. `t`, `playing` and `speed` change at
 * 60 Hz, and every subscriber to this store would re-render on every frame.
 * They are component-local `useReducer` over `lib/player-clock.ts` instead —
 * the lesson `terminal-toolbar.tsx` already records having learned once.
 */

interface RecordingStore {
  recordings: RecordingInfo[];
  /** True between asking for the list and it arriving. */
  loading: boolean;
  setRecordings: (recordings: RecordingInfo[]) => void;
  upsert: (recording: RecordingInfo) => void;
  remove: (id: string) => void;
  setLoading: (loading: boolean) => void;
}

export const useRecordingStore = create<RecordingStore>((set) => ({
  recordings: [],
  loading: false,
  setRecordings: (recordings) => set({ recordings, loading: false }),
  upsert: (recording) =>
    set((state) => ({
      recordings: [
        ...state.recordings.filter((r) => r.id !== recording.id),
        recording,
      ].sort((a, b) => a.startedAt - b.startedAt),
    })),
  remove: (id) =>
    set((state) => ({
      recordings: state.recordings.filter((r) => r.id !== id),
    })),
  setLoading: (loading) => set({ loading }),
}));

/** The recording currently capturing this session, if any. */
export function liveRecordingFor(
  recordings: readonly RecordingInfo[],
  session: string,
): RecordingInfo | null {
  return (
    recordings.find(
      (r) => r.endedAt === null && r.target.session === session,
    ) ?? null
  );
}

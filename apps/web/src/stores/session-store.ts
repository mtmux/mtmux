import { create } from "zustand";
import type { SessionInfo } from "@repo/protocol";

interface SessionStore {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  setSessions: (sessions: SessionInfo[]) => void;
  addSession: (session: SessionInfo) => void;
  removeSession: (name: string) => void;
  updateSessionActivity: (name: string, activity: string) => void;
  setActiveSession: (name: string | null) => void;
}

export const useSessionStore = create<SessionStore>((set) => ({
  sessions: [],
  activeSessionId: null,
  setSessions: (sessions) => set({ sessions }),
  addSession: (session) =>
    set((s) => ({
      sessions: [...s.sessions.filter((x) => x.name !== session.name), session],
    })),
  removeSession: (name) =>
    set((s) => ({
      sessions: s.sessions.filter((x) => x.name !== name),
      activeSessionId: s.activeSessionId === name ? null : s.activeSessionId,
    })),
  updateSessionActivity: (name, activity) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.name === name ? { ...x, activity } : x)),
    })),
  setActiveSession: (name) => set({ activeSessionId: name }),
}));

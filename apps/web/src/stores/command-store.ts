import { create } from "zustand";
import { persist } from "zustand/middleware";

interface Snippet {
  id: string;
  name: string;
  command: string;
  pinned: boolean;
}

interface CommandStore {
  history: string[];
  snippets: Snippet[];
  paletteOpen: boolean;
  addToHistory: (command: string) => void;
  clearHistory: () => void;
  addSnippet: (snippet: Omit<Snippet, "id">) => void;
  removeSnippet: (id: string) => void;
  togglePinned: (id: string) => void;
  setPaletteOpen: (open: boolean) => void;
}

export const useCommandStore = create<CommandStore>()(
  persist(
    (set) => ({
      history: [],
      snippets: [],
      paletteOpen: false,
      addToHistory: (command) =>
        set((s) => ({
          history: [command, ...s.history.filter((c) => c !== command)].slice(0, 100),
        })),
      clearHistory: () => set({ history: [] }),
      addSnippet: (snippet) =>
        set((s) => ({
          snippets: [...s.snippets, { ...snippet, id: crypto.randomUUID() }],
        })),
      removeSnippet: (id) =>
        set((s) => ({
          snippets: s.snippets.filter((x) => x.id !== id),
        })),
      togglePinned: (id) =>
        set((s) => ({
          snippets: s.snippets.map((x) =>
            x.id === id ? { ...x, pinned: !x.pinned } : x,
          ),
        })),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    }),
    { name: "ccremote-commands" },
  ),
);

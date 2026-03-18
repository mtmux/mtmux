import { create } from "zustand";
import { persist } from "zustand/middleware";

interface TerminalStore {
  fontSize: number;
  fontFamily: string;
  themeName: string;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  scrollback: number;
  setFontSize: (size: number) => void;
  setFontFamily: (family: string) => void;
  setThemeName: (name: string) => void;
  setCursorStyle: (style: "block" | "underline" | "bar") => void;
  setCursorBlink: (blink: boolean) => void;
  setScrollback: (lines: number) => void;
}

export const useTerminalStore = create<TerminalStore>()(
  persist(
    (set) => ({
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      themeName: "dracula",
      cursorStyle: "block",
      cursorBlink: true,
      scrollback: 5000,
      setFontSize: (fontSize) => set({ fontSize }),
      setFontFamily: (fontFamily) => set({ fontFamily }),
      setThemeName: (themeName) => set({ themeName }),
      setCursorStyle: (cursorStyle) => set({ cursorStyle }),
      setCursorBlink: (cursorBlink) => set({ cursorBlink }),
      setScrollback: (scrollback) => set({ scrollback }),
    }),
    { name: "termbridge-terminal" },
  ),
);

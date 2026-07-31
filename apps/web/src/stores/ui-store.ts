import { create } from "zustand";
import type { MobileTab } from "@/components/mobile/mobile-nav";

interface UiStore {
  mobileTab: MobileTab;
  paneListOpen: boolean;
  fabOpen: boolean;
  resizeModeActive: boolean;
  sidebarCollapsed: boolean;
  copyModeOpen: boolean;
  terminalSearchOpen: boolean;
  capturedPaneId: string | null;
  capturedContent: string | null;
  /** The composer's draft, or null when it is closed. */
  composerDraft: string | null;
  setMobileTab: (tab: MobileTab) => void;
  setPaneListOpen: (open: boolean) => void;
  setFabOpen: (open: boolean) => void;
  setResizeModeActive: (active: boolean) => void;
  toggleSidebar: () => void;
  setCopyModeOpen: (open: boolean) => void;
  setTerminalSearchOpen: (open: boolean) => void;
  setCapturedPane: (id: string | null, content: string | null) => void;
  /** Open the composer, seeded with whatever was in the one-line bar. */
  openComposer: (draft?: string) => void;
  setComposerDraft: (draft: string) => void;
  closeComposer: () => void;
}

export const useUiStore = create<UiStore>((set) => ({
  mobileTab: "terminal",
  paneListOpen: false,
  fabOpen: false,
  resizeModeActive: false,
  sidebarCollapsed: false,
  copyModeOpen: false,
  terminalSearchOpen: false,
  capturedPaneId: null,
  capturedContent: null,
  composerDraft: null,
  setMobileTab: (mobileTab) => set({ mobileTab }),
  setPaneListOpen: (paneListOpen) => set({ paneListOpen }),
  setFabOpen: (fabOpen) => set({ fabOpen }),
  setResizeModeActive: (resizeModeActive) => set({ resizeModeActive }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setCopyModeOpen: (copyModeOpen) =>
    set(
      copyModeOpen
        ? { copyModeOpen }
        : { copyModeOpen, capturedPaneId: null, capturedContent: null },
    ),
  setTerminalSearchOpen: (terminalSearchOpen) => set({ terminalSearchOpen }),
  setCapturedPane: (capturedPaneId, capturedContent) =>
    set({ capturedPaneId, capturedContent }),
  // `null` means closed and `""` means open-and-empty, which is why this is a
  // nullable draft rather than a boolean beside a string.
  openComposer: (draft = "") => set({ composerDraft: draft }),
  setComposerDraft: (composerDraft) => set({ composerDraft }),
  closeComposer: () => set({ composerDraft: null }),
}));

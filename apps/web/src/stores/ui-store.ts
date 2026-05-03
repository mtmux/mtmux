import { create } from "zustand";
import type { MobileTab } from "@/components/mobile/mobile-nav";

interface UiStore {
  mobileTab: MobileTab;
  paneListOpen: boolean;
  fabOpen: boolean;
  resizeModeActive: boolean;
  sidebarCollapsed: boolean;
  copyModeOpen: boolean;
  capturedPaneId: string | null;
  capturedContent: string | null;
  setMobileTab: (tab: MobileTab) => void;
  setPaneListOpen: (open: boolean) => void;
  setFabOpen: (open: boolean) => void;
  setResizeModeActive: (active: boolean) => void;
  toggleSidebar: () => void;
  setCopyModeOpen: (open: boolean) => void;
  setCapturedPane: (id: string | null, content: string | null) => void;
}

export const useUiStore = create<UiStore>((set) => ({
  mobileTab: "terminal",
  paneListOpen: false,
  fabOpen: false,
  resizeModeActive: false,
  sidebarCollapsed: false,
  copyModeOpen: false,
  capturedPaneId: null,
  capturedContent: null,
  setMobileTab: (mobileTab) => set({ mobileTab }),
  setPaneListOpen: (paneListOpen) => set({ paneListOpen }),
  setFabOpen: (fabOpen) => set({ fabOpen }),
  setResizeModeActive: (resizeModeActive) => set({ resizeModeActive }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setCopyModeOpen: (copyModeOpen) =>
    set(copyModeOpen ? { copyModeOpen } : { copyModeOpen, capturedPaneId: null, capturedContent: null }),
  setCapturedPane: (capturedPaneId, capturedContent) => set({ capturedPaneId, capturedContent }),
}));

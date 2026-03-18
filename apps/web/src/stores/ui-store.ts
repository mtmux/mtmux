import { create } from "zustand";
import type { MobileTab } from "@/components/mobile/mobile-nav";

interface UiStore {
  mobileTab: MobileTab;
  paneListOpen: boolean;
  fabOpen: boolean;
  resizeModeActive: boolean;
  setMobileTab: (tab: MobileTab) => void;
  setPaneListOpen: (open: boolean) => void;
  setFabOpen: (open: boolean) => void;
  setResizeModeActive: (active: boolean) => void;
}

export const useUiStore = create<UiStore>((set) => ({
  mobileTab: "terminal",
  paneListOpen: false,
  fabOpen: false,
  resizeModeActive: false,
  setMobileTab: (mobileTab) => set({ mobileTab }),
  setPaneListOpen: (paneListOpen) => set({ paneListOpen }),
  setFabOpen: (fabOpen) => set({ fabOpen }),
  setResizeModeActive: (resizeModeActive) => set({ resizeModeActive }),
}));

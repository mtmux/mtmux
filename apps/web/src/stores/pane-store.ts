import { create } from "zustand";
import type { PaneInfo, WindowInfo } from "@repo/protocol";

interface PaneStore {
  windows: WindowInfo[];
  panes: PaneInfo[];
  activeWindowId: string | null;
  activePaneId: string | null;
  zoomedPaneId: string | null;
  pendingAutoZoom: boolean;
  setWindows: (windows: WindowInfo[]) => void;
  setPanes: (panes: PaneInfo[], windowId: string) => void;
  setActiveWindow: (id: string | null) => void;
  setActivePane: (id: string | null) => void;
  setZoomedPane: (id: string | null) => void;
  setPendingAutoZoom: (pending: boolean) => void;
  clearAll: () => void;
}

export const usePaneStore = create<PaneStore>((set) => ({
  windows: [],
  panes: [],
  activeWindowId: null,
  activePaneId: null,
  zoomedPaneId: null,
  pendingAutoZoom: false,
  setWindows: (windows) => {
    const activeWin = windows.find((w) => w.active);
    set({
      windows,
      activeWindowId: activeWin?.id ?? null,
    });
  },
  setPanes: (panes, windowId) => {
    const activePane = panes.find((p) => p.active);
    const zoomedPane = panes.find((p) => p.zoomed);
    set({
      panes,
      activeWindowId: windowId || null,
      activePaneId: activePane?.id ?? null,
      zoomedPaneId: zoomedPane?.id ?? null,
    });
  },
  setActiveWindow: (activeWindowId) => set({ activeWindowId }),
  setActivePane: (activePaneId) => set({ activePaneId }),
  setZoomedPane: (zoomedPaneId) => set({ zoomedPaneId }),
  setPendingAutoZoom: (pendingAutoZoom) => set({ pendingAutoZoom }),
  clearAll: () =>
    set({
      windows: [],
      panes: [],
      activeWindowId: null,
      activePaneId: null,
      zoomedPaneId: null,
      pendingAutoZoom: false,
    }),
}));

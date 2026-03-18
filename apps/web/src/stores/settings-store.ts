import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ToolbarKey {
  id: string;
  label: string;
  key: string;
  visible: boolean;
}

const defaultToolbarKeys: ToolbarKey[] = [
  { id: "tab", label: "Tab", key: "\t", visible: true },
  { id: "esc", label: "Esc", key: "\x1b", visible: true },
  { id: "ctrl", label: "Ctrl", key: "", visible: true },
  { id: "alt", label: "Alt", key: "", visible: true },
  { id: "up", label: "\u2191", key: "\x1b[A", visible: true },
  { id: "down", label: "\u2193", key: "\x1b[B", visible: true },
  { id: "left", label: "\u2190", key: "\x1b[D", visible: true },
  { id: "right", label: "\u2192", key: "\x1b[C", visible: true },
  { id: "pipe", label: "|", key: "|", visible: true },
  { id: "dash", label: "-", key: "-", visible: true },
  { id: "tilde", label: "~", key: "~", visible: true },
  { id: "slash", label: "/", key: "/", visible: true },
];

interface GestureSettings {
  swipeToSwitchSessions: boolean;
  swipeToSwitchPanes: boolean;
  doubleTapToCopy: boolean;
  longPressContextMenu: boolean;
  twoFingerScroll: boolean;
  pinchToZoom: boolean;
}

interface SettingsStore {
  toolbarKeys: ToolbarKey[];
  gestures: GestureSettings;
  hapticEnabled: boolean;
  autoZoom: boolean;
  setToolbarKeys: (keys: ToolbarKey[]) => void;
  toggleToolbarKey: (id: string) => void;
  setGesture: <K extends keyof GestureSettings>(key: K, value: GestureSettings[K]) => void;
  setHapticEnabled: (enabled: boolean) => void;
  setAutoZoom: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      toolbarKeys: defaultToolbarKeys,
      gestures: {
        swipeToSwitchSessions: true,
        swipeToSwitchPanes: true,
        doubleTapToCopy: true,
        longPressContextMenu: true,
        twoFingerScroll: true,
        pinchToZoom: true,
      },
      hapticEnabled: true,
      autoZoom: true,
      setToolbarKeys: (toolbarKeys) => set({ toolbarKeys }),
      toggleToolbarKey: (id) =>
        set((s) => ({
          toolbarKeys: s.toolbarKeys.map((k) =>
            k.id === id ? { ...k, visible: !k.visible } : k,
          ),
        })),
      setGesture: (key, value) =>
        set((s) => ({ gestures: { ...s.gestures, [key]: value } })),
      setHapticEnabled: (hapticEnabled) => set({ hapticEnabled }),
      setAutoZoom: (autoZoom) => set({ autoZoom }),
    }),
    { name: "termbridge-settings" },
  ),
);

export type { ToolbarKey, GestureSettings };

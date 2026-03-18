import { create } from "zustand";
import type { ConnectionState } from "@repo/protocol";

interface ConnectionStore {
  status: ConnectionState;
  latency: number | null;
  reconnectCount: number;
  serverVersion: string | null;
  hostname: string | null;
  setStatus: (status: ConnectionState) => void;
  setLatency: (latency: number) => void;
  incrementReconnect: () => void;
  resetReconnect: () => void;
  setServerInfo: (version: string, hostname: string) => void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  status: "disconnected" as ConnectionState,
  latency: null,
  reconnectCount: 0,
  serverVersion: null,
  hostname: null,
  setStatus: (status) => set({ status }),
  setLatency: (latency) => set({ latency }),
  incrementReconnect: () => set((s) => ({ reconnectCount: s.reconnectCount + 1 })),
  resetReconnect: () => set({ reconnectCount: 0 }),
  setServerInfo: (serverVersion, hostname) => set({ serverVersion, hostname }),
}));

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  clearMachineName,
  moveMachine,
  readAllMachinePrefs,
  renameMachine,
  setMachineCollapsed,
  type MachinePrefs,
} from "@/lib/machine-directory";
import { forgetMachine } from "@/lib/forget-machine";

/**
 * The device-local half of a machine, for React.
 *
 * Both dashboard lists need the same three answers — what is this machine
 * called here, where does it sort, is it folded up — and they need to agree.
 * Two components each reading IndexedDB on mount is how they came to disagree
 * about `online` before `useServers` existed; this is the same fix applied to
 * the same shape of problem.
 *
 * Every writer re-reads afterwards rather than patching local state. These are
 * one-record writes a user makes a few times a session, and a re-read is the
 * only version that cannot drift from what is actually on disk.
 */
export type MachinePrefsState = {
  prefs: Map<string, MachinePrefs>;
  /** Sort a list of machine ids into the user's order. */
  sortIds: (ids: readonly string[]) => string[];
  isCollapsed: (serverId: string) => boolean;
  localName: (serverId: string) => string | null;
  setCollapsed: (serverId: string, collapsed: boolean) => Promise<void>;
  collapseAll: (
    serverIds: readonly string[],
    collapsed: boolean,
  ) => Promise<void>;
  rename: (serverId: string, name: string) => Promise<void>;
  clearName: (serverId: string) => Promise<void>;
  move: (
    orderedIds: readonly string[],
    serverId: string,
    direction: -1 | 1,
  ) => Promise<void>;
  forget: (serverId: string) => Promise<void>;
  reload: () => Promise<void>;
};

const UNORDERED = Number.MAX_SAFE_INTEGER;

export function useMachinePrefs(): MachinePrefsState {
  const [prefs, setPrefs] = useState<Map<string, MachinePrefs>>(
    () => new Map(),
  );

  const reload = useCallback(async () => {
    setPrefs(await readAllMachinePrefs());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return useMemo(() => {
    const orderOf = (serverId: string) =>
      prefs.get(serverId)?.order ?? UNORDERED;

    return {
      prefs,
      // A stable sort, so machines with no explicit order keep whatever order
      // the caller gave them rather than being shuffled by the comparator.
      sortIds: (ids) =>
        [...ids]
          .map((serverId, index) => ({ serverId, index }))
          .sort(
            (a, b) =>
              orderOf(a.serverId) - orderOf(b.serverId) || a.index - b.index,
          )
          .map((entry) => entry.serverId),
      isCollapsed: (serverId) => prefs.get(serverId)?.collapsed === true,
      localName: (serverId) => prefs.get(serverId)?.name || null,
      setCollapsed: async (serverId, collapsed) => {
        await setMachineCollapsed(serverId, collapsed);
        await reload();
      },
      collapseAll: async (serverIds, collapsed) => {
        await Promise.all(
          serverIds.map((serverId) => setMachineCollapsed(serverId, collapsed)),
        );
        await reload();
      },
      rename: async (serverId, name) => {
        await renameMachine(serverId, name);
        await reload();
      },
      clearName: async (serverId) => {
        await clearMachineName(serverId);
        await reload();
      },
      move: async (orderedIds, serverId, direction) => {
        await moveMachine(orderedIds, serverId, direction);
        await reload();
      },
      forget: async (serverId) => {
        await forgetMachine(serverId);
        await reload();
      },
      reload,
    };
  }, [prefs, reload]);
}

"use client";

import { useState, useCallback, useRef } from "react";
import {
  Columns2,
  Rows2,
  Maximize2,
  X,
  Plus,
  Trash2,
  LayoutGrid,
  Move,
  Send,
  ArrowUpDown,
  PenLine,
  LayoutTemplate,
  RotateCw,
  ScrollText,
  Radio,
  LogOut,
} from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { Input } from "@repo/ui/components/ui/input";
import { Button } from "@repo/ui/components/ui/button";
import { getRelayClient } from "@/hooks/use-websocket";
import { useCommandStore } from "@/stores/command-store";
import { usePaneStore } from "@/stores/pane-store";
import { useUiStore } from "@/stores/ui-store";

type PaletteTab = "quick" | "panes" | "windows" | "advanced";

interface QuickCommandPaletteProps {
  open: boolean;
  onClose: () => void;
  className?: string;
}

export function QuickCommandPalette({ open, onClose, className }: QuickCommandPaletteProps) {
  const [command, setCommand] = useState("");
  const [activeTab, setActiveTab] = useState<PaletteTab>("quick");
  const { history, snippets, addToHistory } = useCommandStore();
  const { activePaneId, panes } = usePaneStore();
  const { setPaneListOpen, setResizeModeActive } = useUiStore();
  const inputRef = useRef<HTMLInputElement>(null);

  const executeCommand = useCallback(
    (cmd: string) => {
      const client = getRelayClient();
      if (!client || !cmd.trim()) return;

      client.send({ type: "command:send", command: cmd.trim() });
      addToHistory(cmd.trim());
      setCommand("");
    },
    [addToHistory],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      executeCommand(command);
    },
    [command, executeCommand],
  );

  if (!open) return null;

  const pinnedSnippets = snippets.filter((s) => s.pinned);
  const recentHistory = history.slice(0, 5);

  const paneActions = [
    {
      icon: Columns2,
      label: "Split H",
      action: () => getRelayClient()?.send({ type: "pane:split", direction: "h" as const }),
    },
    {
      icon: Rows2,
      label: "Split V",
      action: () => getRelayClient()?.send({ type: "pane:split", direction: "v" as const }),
    },
    {
      icon: Maximize2,
      label: "Zoom",
      action: () => getRelayClient()?.send({ type: "pane:zoom" }),
    },
    {
      icon: Trash2,
      label: "Kill Pane",
      action: () => {
        if (activePaneId && panes.length > 1) {
          getRelayClient()?.send({ type: "pane:kill", id: activePaneId });
        }
      },
    },
    {
      icon: Move,
      label: "Resize",
      action: () => {
        onClose();
        setResizeModeActive(true);
      },
    },
    {
      icon: LayoutGrid,
      label: "Pane List",
      action: () => {
        onClose();
        setPaneListOpen(true);
      },
    },
    {
      icon: ArrowUpDown,
      label: "Swap Pane",
      action: () => {
        if (activePaneId) {
          getRelayClient()?.send({ type: "pane:swap", id: activePaneId, direction: "D" });
        }
      },
    },
  ];

  const windowActions = [
    {
      icon: Plus,
      label: "New Window",
      action: () => getRelayClient()?.send({ type: "window:create" }),
    },
    {
      icon: Trash2,
      label: "Kill Window",
      action: () => {
        const { activeWindowId } = usePaneStore.getState();
        if (activeWindowId) {
          getRelayClient()?.send({ type: "window:kill", id: activeWindowId });
        }
      },
    },
    {
      icon: LayoutGrid,
      label: "List Windows",
      action: () => getRelayClient()?.send({ type: "window:list" }),
    },
    {
      icon: PenLine,
      label: "Rename Win",
      action: () => {
        const { activeWindowId } = usePaneStore.getState();
        if (activeWindowId) {
          const name = prompt("Window name:");
          if (name) {
            getRelayClient()?.send({ type: "window:rename", id: activeWindowId, name });
          }
        }
      },
    },
    {
      icon: LayoutTemplate,
      label: "Layout",
      action: () => getRelayClient()?.send({ type: "window:layout", preset: "tiled" }),
    },
    {
      icon: RotateCw,
      label: "Rotate",
      action: () => getRelayClient()?.send({ type: "layout:rotate" }),
    },
  ];

  const advancedActions = [
    {
      icon: ScrollText,
      label: "Copy Mode",
      action: () => getRelayClient()?.send({ type: "tmux:copy-mode" }),
    },
    {
      icon: Radio,
      label: "Send Prefix",
      action: () => getRelayClient()?.send({ type: "tmux:prefix" }),
    },
    {
      icon: LogOut,
      label: "Detach",
      action: () => getRelayClient()?.send({ type: "session:detach" }),
    },
  ];

  const tabs: { id: PaletteTab; label: string }[] = [
    { id: "quick", label: "Quick" },
    { id: "panes", label: "Panes" },
    { id: "windows", label: "Windows" },
    { id: "advanced", label: "Advanced" },
  ];

  return (
    <div
      className={cn(
        "absolute inset-x-0 bottom-0 z-50 rounded-t-xl border-t bg-background p-3 shadow-lg",
        "animate-in slide-in-from-bottom duration-200",
        className,
      )}
    >
      <div className="mb-2 flex items-center justify-between">
        {/* Tab bar */}
        <div className="flex gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                activeTab === tab.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {activeTab === "quick" && (
        <>
          <form onSubmit={handleSubmit} className="flex gap-2">
            <Input
              ref={inputRef}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="Type a command..."
              className="text-sm"
              autoFocus
            />
            <Button type="submit" size="icon" className="shrink-0">
              <Send className="h-4 w-4" />
            </Button>
          </form>

          {pinnedSnippets.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {pinnedSnippets.map((snippet) => (
                <button
                  key={snippet.id}
                  className="rounded-md bg-secondary px-2 py-1 text-xs"
                  onClick={() => executeCommand(snippet.command)}
                >
                  {snippet.name}
                </button>
              ))}
            </div>
          )}

          {recentHistory.length > 0 && (
            <div className="mt-2">
              <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Recent</span>
              <div className="mt-1 space-y-0.5">
                {recentHistory.map((cmd, i) => (
                  <button
                    key={i}
                    className="block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-accent"
                    onClick={() => executeCommand(cmd)}
                  >
                    {cmd}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {activeTab === "panes" && (
        <div className="grid grid-cols-3 gap-2">
          {paneActions.map((item) => (
            <Button
              key={item.label}
              variant="outline"
              className="flex h-auto flex-col gap-1 py-2.5 text-xs"
              onClick={item.action}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Button>
          ))}
        </div>
      )}

      {activeTab === "windows" && (
        <div className="grid grid-cols-3 gap-2">
          {windowActions.map((item) => (
            <Button
              key={item.label}
              variant="outline"
              className="flex h-auto flex-col gap-1 py-2.5 text-xs"
              onClick={item.action}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Button>
          ))}
        </div>
      )}

      {activeTab === "advanced" && (
        <div className="grid grid-cols-3 gap-2">
          {advancedActions.map((item) => (
            <Button
              key={item.label}
              variant="outline"
              className="flex h-auto flex-col gap-1 py-2.5 text-xs"
              onClick={item.action}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

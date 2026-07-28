"use client";

import { Plus, LayoutGrid, Maximize2 } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { usePaneStore } from "@/stores/pane-store";
import { useSessionStore } from "@/stores/session-store";
import { useUiStore } from "@/stores/ui-store";
import { useConnectionStore } from "@/stores/connection-store";
import { getRelayClient } from "@/hooks/use-websocket";

interface WindowTabsProps {
  className?: string;
}

export function WindowTabs({ className }: WindowTabsProps) {
  const { windows, activeWindowId, panes, activePaneId, zoomedPaneId } =
    usePaneStore();
  const { activeSessionId } = useSessionStore();
  const { setPaneListOpen } = useUiStore();
  const connected = useConnectionStore((s) => s.status === "connected");

  const multipleWindows = windows.length > 1;
  const multiplePanes = panes.length > 1;

  // Always show when a session is active
  if (!activeSessionId) return null;

  const handleSelectWindow = (id: string) => {
    getRelayClient()?.send({ type: "window:select", id });
  };

  const handleCreateWindow = () => {
    getRelayClient()?.send({ type: "window:create" });
  };

  // Minimal bar when single window + single pane
  const activeWindow = windows.find((w) => w.id === activeWindowId);

  return (
    <div
      className={cn(
        // Fixed 44px row: the tabs stay visually compact pills but each button
        // fills the row height so the tap target clears the 44px minimum.
        "flex h-11 shrink-0 items-center gap-1 overflow-x-auto px-2 border-b scrollbar-none",
        className,
      )}
    >
      {/* Window tabs (only when >1 window) */}
      {multipleWindows ? (
        <>
          {windows.map((win) => (
            <button
              key={win.id}
              className="group flex h-full shrink-0 items-center rounded-md disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              disabled={!connected}
              onClick={() => handleSelectWindow(win.id)}
            >
              <span
                className={cn(
                  "flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  win.id === activeWindowId
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-secondary-foreground group-hover:bg-accent",
                )}
              >
                <span className="text-[10px] opacity-60">{win.index}</span>
                <span className="max-w-[80px] truncate">{win.name}</span>
              </span>
            </button>
          ))}
          <button
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={handleCreateWindow}
            disabled={!connected}
            aria-label="Create window"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </>
      ) : activeWindow ? (
        <span className="text-xs text-muted-foreground truncate max-w-[120px]">
          {activeWindow.name}
        </span>
      ) : null}

      {/* Spacer to push pane indicator right */}
      <div className="flex-1" />

      {/* Pane dots */}
      {multiplePanes && (
        <div className="flex items-center gap-1.5">
          {panes.map((pane) => (
            <div
              key={pane.id}
              className={cn(
                "h-2 w-2 rounded-full transition-colors",
                pane.id === activePaneId
                  ? "bg-primary"
                  : "bg-muted-foreground/30",
              )}
            />
          ))}
        </div>
      )}

      {/* Pane indicator button — always clickable to open PaneListPanel */}
      <button
        className="flex h-11 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => setPaneListOpen(true)}
        aria-label={zoomedPaneId ? "Hide pane list" : "Show pane list"}
      >
        {zoomedPaneId ? (
          <Maximize2 className="h-3.5 w-3.5 text-primary" />
        ) : (
          <LayoutGrid className="h-3.5 w-3.5" />
        )}
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-muted text-[10px] font-medium px-1">
          {panes.length || 1}
        </span>
      </button>
    </div>
  );
}

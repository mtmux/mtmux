"use client";

import { Plus, LayoutGrid, Maximize2 } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { usePaneStore } from "@/stores/pane-store";
import { useUiStore } from "@/stores/ui-store";
import { getRelayClient } from "@/hooks/use-websocket";

interface WindowTabsProps {
  className?: string;
}

export function WindowTabs({ className }: WindowTabsProps) {
  const { windows, activeWindowId, panes, activePaneId, zoomedPaneId } = usePaneStore();
  const { setPaneListOpen } = useUiStore();

  const multipleWindows = windows.length > 1;
  const multiplePanes = panes.length > 1;

  // Hide when 1 window + 1 pane (no useful info)
  if (!multipleWindows && !multiplePanes) return null;

  const handleSelectWindow = (id: string) => {
    getRelayClient()?.send({ type: "window:select", id });
  };

  const handleCreateWindow = () => {
    getRelayClient()?.send({ type: "window:create" });
  };

  return (
    <div
      className={cn(
        "flex items-center gap-1 overflow-x-auto px-2 py-1 border-b scrollbar-none",
        className,
      )}
    >
      {/* Window tabs (only when >1 window) */}
      {multipleWindows && (
        <>
          {windows.map((win) => (
            <button
              key={win.id}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                win.id === activeWindowId
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-secondary-foreground hover:bg-accent",
              )}
              onClick={() => handleSelectWindow(win.id)}
            >
              <span className="text-[10px] opacity-60">{win.index}</span>
              <span className="max-w-[80px] truncate">{win.name}</span>
            </button>
          ))}
          <button
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent transition-colors"
            onClick={handleCreateWindow}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </>
      )}

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

      {/* Pane indicator button */}
      {multiplePanes && (
        <button
          className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent transition-colors"
          onClick={() => setPaneListOpen(true)}
        >
          {zoomedPaneId ? (
            <Maximize2 className="h-3.5 w-3.5 text-primary" />
          ) : (
            <LayoutGrid className="h-3.5 w-3.5" />
          )}
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-muted text-[10px] font-medium px-1">
            {panes.length}
          </span>
        </button>
      )}
    </div>
  );
}

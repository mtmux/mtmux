"use client";

import { Maximize2, X, LayoutGrid } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@repo/ui/components/ui/sheet";
import { Button } from "@repo/ui/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@repo/ui/components/ui/tooltip";
import { cn } from "@repo/ui/lib/utils";
import { useMediaQuery } from "@repo/ui/hooks/use-media-query";
import { usePaneStore } from "@/stores/pane-store";
import { useUiStore } from "@/stores/ui-store";
import { getRelayClient } from "@/hooks/use-websocket";

const SHELL_COMMANDS = new Set(["bash", "zsh", "fish", "sh", "dash", "ksh", "tcsh", "csh"]);

function shortenPath(path: string): string {
  if (!path) return "";
  const home = typeof window !== "undefined" ? "" : "";
  // Replace home dir with ~
  const shortened = path.replace(/^\/home\/[^/]+/, "~").replace(/^\/root/, "~");
  return shortened;
}

function formatPaneName(command?: string, path?: string): string {
  if (!command || SHELL_COMMANDS.has(command)) {
    return path ? shortenPath(path) : command || "shell";
  }
  return path ? `${command} · ${shortenPath(path)}` : command;
}

export function PaneListPanel() {
  const { panes, activePaneId, zoomedPaneId } = usePaneStore();
  const { paneListOpen, setPaneListOpen } = useUiStore();
  const isMobile = useMediaQuery("(max-width: 768px)");

  if (panes.length === 0) {
    if (!paneListOpen) return null;
    return (
      <Sheet open={paneListOpen} onOpenChange={setPaneListOpen}>
        <SheetContent side="bottom" className="h-[30vh] p-4">
          <SheetHeader className="pb-2">
            <SheetTitle className="text-sm">Panes</SheetTitle>
          </SheetHeader>
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground pb-8">
            <LayoutGrid className="h-10 w-10 mb-2 opacity-40" />
            <p className="text-sm">No panes available</p>
            <p className="text-xs mt-1">Attach to a session to see panes</p>
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  const handleSelectPane = (id: string) => {
    const client = getRelayClient();
    if (!client) return;

    if (isMobile) {
      // Auto-zoom on mobile: if tapping the already active+zoomed pane, just close
      if (id === activePaneId && id === zoomedPaneId) {
        setPaneListOpen(false);
        return;
      }

      if (zoomedPaneId) {
        // Unzoom current, select new, zoom new
        client.send({ type: "pane:zoom" });
        client.send({ type: "pane:select", id });
        client.send({ type: "pane:zoom" });
      } else {
        // Select and zoom
        client.send({ type: "pane:select", id });
        client.send({ type: "pane:zoom" });
      }
    } else {
      client.send({ type: "pane:select", id });
    }

    setPaneListOpen(false);
  };

  const handleZoomPane = () => {
    getRelayClient()?.send({ type: "pane:zoom" });
  };

  const handleKillPane = (id: string) => {
    getRelayClient()?.send({ type: "pane:kill", id });
  };

  return (
    <Sheet open={paneListOpen} onOpenChange={setPaneListOpen}>
      <SheetContent side="bottom" className="flex h-[40vh] flex-col p-4">
        <SheetHeader className="pb-2">
          <div className="flex items-center justify-between">
            <SheetTitle className="text-sm">Panes ({panes.length})</SheetTitle>
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleZoomPane}>
                    <Maximize2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{zoomedPaneId ? "Unzoom" : "Zoom"}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </SheetHeader>

        {/* Pane list */}
        <div className="mt-1 flex-1 min-h-0 overflow-y-auto space-y-1">
          {panes.map((pane) => (
            <div
              key={pane.id}
              className={cn(
                "flex items-center justify-between rounded-md px-3 py-2 text-sm",
                pane.id === activePaneId ? "bg-accent" : "hover:bg-accent/50",
              )}
            >
              <button
                className="flex flex-1 items-center gap-2 text-left"
                onClick={() => handleSelectPane(pane.id)}
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {pane.index}
                </span>
                <span className="truncate">
                  {formatPaneName(pane.command, pane.path)}
                </span>
                {pane.dimensions && (
                  <span className="text-[10px] text-muted-foreground">
                    {pane.dimensions.cols}x{pane.dimensions.rows}
                  </span>
                )}
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  handleKillPane(pane.id);
                }}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

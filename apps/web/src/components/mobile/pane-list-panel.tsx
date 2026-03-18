"use client";

import { Maximize2, X } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@repo/ui/components/ui/sheet";
import { Button } from "@repo/ui/components/ui/button";
import { cn } from "@repo/ui/lib/utils";
import { useMediaQuery } from "@repo/ui/hooks/use-media-query";
import { usePaneStore } from "@/stores/pane-store";
import { useUiStore } from "@/stores/ui-store";
import { getRelayClient } from "@/hooks/use-websocket";

export function PaneListPanel() {
  const { panes, activePaneId, zoomedPaneId } = usePaneStore();
  const { paneListOpen, setPaneListOpen } = useUiStore();
  const isMobile = useMediaQuery("(max-width: 768px)");

  if (panes.length === 0) return null;

  // Compute grid layout from pane positions/dimensions (filter out panes with missing data)
  const validPanes = panes.filter((p) => p.dimensions && p.position);
  const maxX = validPanes.length > 0
    ? Math.max(...validPanes.map((p) => p.position.x + p.dimensions.cols))
    : 1;
  const maxY = validPanes.length > 0
    ? Math.max(...validPanes.map((p) => p.position.y + p.dimensions.rows))
    : 1;

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
      <SheetContent side="bottom" className="h-[50vh] p-4">
        <SheetHeader className="pb-2">
          <div className="flex items-center justify-between">
            <SheetTitle className="text-sm">Panes ({panes.length})</SheetTitle>
            <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={handleZoomPane}>
              <Maximize2 className="h-3.5 w-3.5" />
              {zoomedPaneId ? "Unzoom" : "Zoom"}
            </Button>
          </div>
        </SheetHeader>

        {/* Mini-map of pane layout */}
        <div
          className="relative mx-auto w-full rounded-lg border bg-muted/30 p-1"
          style={{ aspectRatio: `${maxX} / ${maxY}`, maxHeight: "200px" }}
        >
          {validPanes.map((pane) => {
            const left = (pane.position.x / maxX) * 100;
            const top = (pane.position.y / maxY) * 100;
            const width = (pane.dimensions.cols / maxX) * 100;
            const height = (pane.dimensions.rows / maxY) * 100;

            return (
              <button
                key={pane.id}
                className={cn(
                  "absolute flex min-h-[44px] min-w-[44px] items-center justify-center rounded border text-xs font-mono transition-colors",
                  pane.id === activePaneId
                    ? "border-primary bg-primary/20 text-primary"
                    : "border-border bg-background hover:bg-accent",
                  pane.id === zoomedPaneId && "ring-2 ring-yellow-500",
                )}
                style={{
                  left: `${left}%`,
                  top: `${top}%`,
                  width: `${width}%`,
                  height: `${height}%`,
                }}
                onClick={() => handleSelectPane(pane.id)}
              >
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-[10px] opacity-70">{pane.index}</span>
                  {pane.command && (
                    <span className="max-w-full truncate text-[9px] opacity-50 px-1">
                      {pane.command}
                    </span>
                  )}
                  {pane.id === zoomedPaneId && (
                    <span className="text-[8px] text-yellow-500 font-semibold">ZOOM</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* Pane list */}
        <div className="mt-3 space-y-1">
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
                  {pane.command || "shell"}
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

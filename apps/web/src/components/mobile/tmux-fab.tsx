"use client";

import { useState, useRef, useCallback } from "react";
import {
  Columns2,
  Rows2,
  Plus,
  Maximize2,
  X,
  Move,
  TerminalSquare,
  ArrowUpDown,
  PenLine,
  LayoutTemplate,
  RotateCw,
  ScrollText,
  Radio,
  LogOut,
  Trash2,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@repo/ui/components/ui/sheet";
import { Button } from "@repo/ui/components/ui/button";
import { cn } from "@repo/ui/lib/utils";
import { useSessionStore } from "@/stores/session-store";
import { usePaneStore } from "@/stores/pane-store";
import { useUiStore } from "@/stores/ui-store";
import { useSettingsStore } from "@/stores/settings-store";
import { getRelayClient } from "@/hooks/use-websocket";

type FabTab = "panes" | "windows" | "advanced";

export function TmuxFab() {
  const { activeSessionId } = useSessionStore();
  const { zoomedPaneId } = usePaneStore();
  const { mobileTab, fabOpen, setFabOpen, setResizeModeActive } = useUiStore();
  const [activeTab, setActiveTab] = useState<FabTab>("panes");
  const [longPressOpen, setLongPressOpen] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleFabTouchStart = useCallback(() => {
    longPressTimer.current = setTimeout(() => {
      setLongPressOpen(true);
    }, 500);
  }, []);

  const handleFabTouchEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleFabClick = useCallback(() => {
    if (!longPressOpen) {
      setFabOpen(!fabOpen);
    }
    setLongPressOpen(false);
  }, [longPressOpen, fabOpen, setFabOpen]);

  // Show whenever a session is attached (any mobile tab)
  if (!activeSessionId) return null;

  const handleSplit = (direction: "h" | "v") => {
    getRelayClient()?.send({ type: "pane:split", direction });
    // Auto-zoom into the new pane after split
    if (useSettingsStore.getState().autoZoom) {
      usePaneStore.getState().setPendingAutoZoom(true);
    }
    setFabOpen(false);
  };

  const paneActions = [
    {
      icon: Columns2,
      label: "Split H",
      action: () => handleSplit("h"),
    },
    {
      icon: Rows2,
      label: "Split V",
      action: () => handleSplit("v"),
    },
    {
      icon: Maximize2,
      label: zoomedPaneId ? "Unzoom" : "Zoom",
      action: () => {
        getRelayClient()?.send({ type: "pane:zoom" });
        setFabOpen(false);
      },
    },
    {
      icon: Move,
      label: "Resize",
      action: () => {
        setFabOpen(false);
        setResizeModeActive(true);
      },
    },
    {
      icon: ArrowUpDown,
      label: "Swap Pane",
      action: () => {
        const { activePaneId } = usePaneStore.getState();
        if (activePaneId) {
          getRelayClient()?.send({ type: "pane:swap", id: activePaneId, direction: "D" });
        }
        setFabOpen(false);
      },
    },
    {
      icon: Trash2,
      label: "Kill Pane",
      variant: "destructive" as const,
      action: () => {
        const { activePaneId, panes } = usePaneStore.getState();
        if (activePaneId && panes.length > 1) {
          getRelayClient()?.send({ type: "pane:kill", id: activePaneId });
        }
        setFabOpen(false);
      },
    },
  ];

  const windowActions = [
    {
      icon: Plus,
      label: "New Window",
      action: () => {
        getRelayClient()?.send({ type: "window:create" });
        setFabOpen(false);
      },
    },
    {
      icon: Trash2,
      label: "Kill Window",
      variant: "destructive" as const,
      action: () => {
        const { activeWindowId } = usePaneStore.getState();
        if (activeWindowId) {
          getRelayClient()?.send({ type: "window:kill", id: activeWindowId });
        }
        setFabOpen(false);
      },
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
        setFabOpen(false);
      },
    },
    {
      icon: LayoutTemplate,
      label: "Layout",
      action: () => {
        getRelayClient()?.send({ type: "window:layout", preset: "tiled" });
        setFabOpen(false);
      },
    },
    {
      icon: RotateCw,
      label: "Rotate",
      action: () => {
        getRelayClient()?.send({ type: "layout:rotate" });
        setFabOpen(false);
      },
    },
  ];

  const advancedActions = [
    {
      icon: ScrollText,
      label: "Copy Mode",
      action: () => {
        getRelayClient()?.send({ type: "tmux:copy-mode" });
        setFabOpen(false);
      },
    },
    {
      icon: Radio,
      label: "Send Prefix",
      action: () => {
        getRelayClient()?.send({ type: "tmux:prefix" });
        setFabOpen(false);
      },
    },
    {
      icon: LogOut,
      label: "Detach",
      action: () => {
        getRelayClient()?.send({ type: "session:detach" });
        setFabOpen(false);
      },
    },
  ];

  const tabs: { id: FabTab; label: string }[] = [
    { id: "panes", label: "Panes" },
    { id: "windows", label: "Windows" },
    { id: "advanced", label: "Advanced" },
  ];

  const currentActions =
    activeTab === "panes" ? paneActions :
    activeTab === "windows" ? windowActions :
    advancedActions;

  return (
    <>
      {/* FAB button with long-press quick split.
          Anchored to the *visual* viewport (--vv-* set by VisualViewportSync)
          so pinch-zoom doesn't push it offscreen horizontally / vertically. */}
      <div
        className="fixed z-40"
        style={{
          right: "calc(1rem + (100vw - var(--vv-width, 100vw)) - var(--vv-offset-left, 0px))",
          bottom: "calc(5rem + max(0px, 100vh - var(--vv-height, 100vh) - var(--vv-offset-top, 0px)))",
        }}
      >
        {longPressOpen && (
          <div className="absolute bottom-14 right-0 flex gap-1 rounded-lg border bg-background p-1 shadow-lg">
            <Button
              variant="outline"
              size="sm"
              className="gap-1 text-xs"
              onClick={() => {
                handleSplit("h");
                setLongPressOpen(false);
              }}
            >
              <Columns2 className="h-3.5 w-3.5" />
              Split H
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1 text-xs"
              onClick={() => {
                handleSplit("v");
                setLongPressOpen(false);
              }}
            >
              <Rows2 className="h-3.5 w-3.5" />
              Split V
            </Button>
          </div>
        )}
        <button
          className={cn(
            "flex h-11 w-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform active:scale-95",
            fabOpen && "rotate-45",
          )}
          onClick={handleFabClick}
          aria-label="Tmux actions"
          onTouchStart={handleFabTouchStart}
          onTouchEnd={handleFabTouchEnd}
          onTouchCancel={handleFabTouchEnd}
        >
          <TerminalSquare className="h-5 w-5" />
        </button>
      </div>

      {/* Action sheet with tabs */}
      <Sheet open={fabOpen} onOpenChange={setFabOpen}>
        <SheetContent side="bottom" className="pb-8">
          <SheetHeader className="pb-2">
            <SheetTitle className="text-sm">Tmux Actions</SheetTitle>
          </SheetHeader>

          {/* Tab bar */}
          <div className="mb-3 flex gap-1">
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

          <div className="grid grid-cols-2 gap-2">
            {currentActions.map((item) => (
              <Button
                key={item.label}
                variant={"variant" in item ? (item.variant as "destructive") : "outline"}
                className="flex h-auto items-center gap-2 px-3 py-2.5 text-xs justify-start"
                onClick={item.action}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Button>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

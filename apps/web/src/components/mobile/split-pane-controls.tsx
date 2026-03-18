"use client";

import { Button } from "@repo/ui/components/ui/button";
import { getRelayClient } from "@/hooks/use-websocket";

interface SplitPaneControlsProps {
  onDone?: () => void;
}

export function SplitPaneControls({ onDone }: SplitPaneControlsProps) {
  const handleSplit = (direction: "h" | "v") => {
    getRelayClient()?.send({ type: "pane:split", direction });
    onDone?.();
  };

  return (
    <div className="flex gap-2">
      <Button
        variant="outline"
        className="flex-1 gap-2 text-sm"
        onClick={() => handleSplit("h")}
      >
        <span className="text-base">━</span>
        Split Horizontal
      </Button>
      <Button
        variant="outline"
        className="flex-1 gap-2 text-sm"
        onClick={() => handleSplit("v")}
      >
        <span className="text-base">┃</span>
        Split Vertical
      </Button>
    </div>
  );
}

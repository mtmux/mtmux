"use client";

import { useState } from "react";
import { Search, Maximize2, Minimize2, Settings } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { ConnectionStatus } from "@repo/ui/components/connection-status";
import { useConnectionStore } from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";
import { TerminalSearch } from "./terminal-search";
import { cn } from "@repo/ui/lib/utils";

interface TerminalToolbarProps {
  onSearch?: (term: string) => void;
  onSearchNext?: () => void;
  onSearchPrevious?: () => void;
  onToggleFullscreen?: () => void;
  onOpenSettings?: () => void;
  isFullscreen?: boolean;
  className?: string;
}

export function TerminalToolbar({
  onSearch,
  onSearchNext,
  onSearchPrevious,
  onToggleFullscreen,
  onOpenSettings,
  isFullscreen = false,
  className,
}: TerminalToolbarProps) {
  const [showSearch, setShowSearch] = useState(false);
  const { status, latency } = useConnectionStore();
  const { activeSessionId } = useSessionStore();

  const connectionStatusType = status === "connected"
    ? "connected"
    : status === "connecting" || status === "authenticating"
      ? "connecting"
      : status === "reconnecting"
        ? "reconnecting"
        : "disconnected";

  return (
    <div className={cn("flex items-center gap-2 px-3 py-1.5", className)}>
      <span className="text-sm font-medium truncate">
        {activeSessionId ?? "No session"}
      </span>

      <ConnectionStatus
        status={connectionStatusType}
        latency={latency ?? undefined}
        className="ml-2"
      />

      <div className="flex-1" />

      {showSearch && (
        <TerminalSearch
          onSearch={onSearch ?? (() => {})}
          onNext={onSearchNext}
          onPrevious={onSearchPrevious}
          onClose={() => setShowSearch(false)}
          className="absolute right-2 top-10 z-10"
        />
      )}

      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={() => setShowSearch(!showSearch)}
      >
        <Search className="h-3.5 w-3.5" />
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onToggleFullscreen}
      >
        {isFullscreen ? (
          <Minimize2 className="h-3.5 w-3.5" />
        ) : (
          <Maximize2 className="h-3.5 w-3.5" />
        )}
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onOpenSettings}
      >
        <Settings className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

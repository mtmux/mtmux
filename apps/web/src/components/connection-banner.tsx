"use client";

import { Loader2, WifiOff } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { useConnectionStore } from "@/stores/connection-store";
import { getRelayClient } from "@/hooks/use-websocket";

/**
 * Slim, persistent banner shown only while the socket is disconnected or
 * reconnecting, so users get clear feedback instead of typing into a dead
 * terminal. Rendered at the bottom of the AppShell header so it *displaces*
 * the content area — as an overlay it sat on top of terminal row 1, hiding
 * output exactly when the user is trying to work out what went wrong.
 */
export function ConnectionBanner() {
  const status = useConnectionStore((s) => s.status);
  const reconnectCount = useConnectionStore((s) => s.reconnectCount);

  // Only surface the "degraded" states. Initial "connecting"/"authenticating"
  // is handled by the header ConnectionStatus indicator.
  if (status !== "disconnected" && status !== "reconnecting") {
    return null;
  }

  const reconnecting = status === "reconnecting";

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex w-full items-center justify-center gap-2 px-3 py-1 text-xs font-medium",
        reconnecting
          ? "bg-warning/95 text-warning-foreground"
          : "bg-destructive/95 text-destructive-foreground",
      )}
    >
      {reconnecting ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
      ) : (
        <WifiOff className="h-3.5 w-3.5 shrink-0" />
      )}
      <span className="truncate">
        {reconnecting
          ? `Reconnecting${reconnectCount > 0 ? ` (attempt ${reconnectCount})` : "…"} — input paused`
          : "Disconnected — input paused"}
      </span>
      {!reconnecting && (
        <button
          type="button"
          className="ml-1 shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] hover:bg-foreground/20 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current"
          onClick={() => getRelayClient()?.connect()}
        >
          Retry
        </button>
      )}
    </div>
  );
}

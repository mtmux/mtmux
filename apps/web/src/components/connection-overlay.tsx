"use client";

import { useEffect, useState } from "react";
import { Wifi, WifiOff } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { useConnectionStore } from "@/stores/connection-store";
import { getRelayClient } from "@/hooks/use-websocket";

export function ConnectionOverlay() {
  const { status, reconnectCount } = useConnectionStore();
  const [countdown, setCountdown] = useState(0);
  // #20: Dismissable after 3 attempts
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (status === "connected") {
      setDismissed(false);
    }
  }, [status]);

  useEffect(() => {
    if (status !== "reconnecting") {
      setCountdown(0);
      return;
    }

    // Match exponential backoff: min(2^count * 1, 30)
    const delay = Math.min(Math.pow(2, reconnectCount) * 1, 30);
    setCountdown(delay);

    const interval = setInterval(() => {
      setCountdown((c) => Math.max(0, c - 1));
    }, 1000);

    return () => clearInterval(interval);
  }, [status, reconnectCount]);

  const handleReconnectNow = () => {
    const client = getRelayClient();
    if (client) {
      client.disconnect();
      client.connect();
    }
  };

  if (status === "connected" || status === "connecting" || status === "authenticating") {
    return null;
  }

  // #20: Dismissed state — show compact top banner instead of full overlay
  if (dismissed) {
    return (
      <div className="fixed top-0 left-0 right-0 z-[100] flex items-center justify-center gap-2 bg-yellow-500/90 px-3 py-1 text-xs text-yellow-950">
        <Wifi className="h-3 w-3 animate-pulse" />
        <span>Reconnecting... (attempt {reconnectCount})</span>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 px-2 text-[10px] text-yellow-950 hover:bg-yellow-600/30"
          onClick={handleReconnectNow}
        >
          Retry Now
        </Button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 rounded-xl border bg-background p-6 shadow-lg max-w-sm mx-4">
        {status === "reconnecting" ? (
          <>
            <Wifi className="h-8 w-8 animate-pulse text-yellow-500" />
            <p className="text-sm font-medium">Connection lost</p>
            <p className="text-xs text-muted-foreground">
              Reconnecting{countdown > 0 ? ` in ${countdown}s` : "..."}
            </p>
            <p className="text-[10px] text-muted-foreground">
              Attempt {reconnectCount}
            </p>
            {/* #20: Progressive context based on attempt count */}
            {reconnectCount >= 3 && (
              <p className="text-xs text-muted-foreground text-center">
                The relay server may be down or unreachable.
              </p>
            )}
            {reconnectCount >= 6 && (
              <div className="text-center space-y-1">
                <p className="text-[10px] text-muted-foreground font-mono break-all">
                  {typeof window !== "undefined" && window.location.origin}
                </p>
                <Button
                  size="sm"
                  variant="link"
                  className="text-xs h-auto p-0"
                  onClick={() => { window.location.href = "/login"; }}
                >
                  Back to Login
                </Button>
              </div>
            )}
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={handleReconnectNow}>
                Reconnect Now
              </Button>
              {reconnectCount >= 3 && (
                <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
                  Dismiss
                </Button>
              )}
            </div>
          </>
        ) : (
          <>
            <WifiOff className="h-8 w-8 text-destructive" />
            <p className="text-sm font-medium">Disconnected</p>
            <p className="text-xs text-muted-foreground">
              Check your connection and try again
            </p>
            <Button size="sm" variant="outline" onClick={handleReconnectNow}>
              Reconnect
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

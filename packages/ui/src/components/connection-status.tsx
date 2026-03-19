"use client";

import { cn } from "../lib/utils";

export type ConnectionStatusType = "connected" | "connecting" | "reconnecting" | "disconnected";

const statusConfig: Record<ConnectionStatusType, { color: string; label: string; pulse: boolean }> = {
  connected: { color: "bg-green-500", label: "Connected", pulse: false },
  connecting: { color: "bg-yellow-500", label: "Connecting...", pulse: true },
  reconnecting: { color: "bg-yellow-500", label: "Reconnecting...", pulse: true },
  disconnected: { color: "bg-red-500", label: "Disconnected", pulse: false },
};

interface ConnectionStatusProps {
  status: ConnectionStatusType;
  latency?: number;
  reconnectCount?: number;
  hostname?: string;
  className?: string;
  showLabel?: boolean;
}

export function ConnectionStatus({
  status,
  latency,
  reconnectCount,
  hostname,
  className,
  showLabel = true,
}: ConnectionStatusProps) {
  const config = statusConfig[status];

  const tooltipParts: string[] = [config.label];
  if (hostname) tooltipParts.push(`Host: ${hostname}`);
  if (status === "connected" && latency != null) tooltipParts.push(`Latency: ${latency}ms`);
  if (reconnectCount && reconnectCount > 0) tooltipParts.push(`Reconnects: ${reconnectCount}`);
  const tooltip = tooltipParts.join(" | ");

  return (
    <div className={cn("flex items-center gap-2", className)} title={tooltip}>
      <span className="relative flex h-3 w-3">
        {config.pulse && (
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
              config.color,
            )}
          />
        )}
        <span className={cn("relative inline-flex h-3 w-3 rounded-full", config.color)} />
      </span>
      {showLabel && (
        <span className="text-xs text-muted-foreground">
          {config.label}
          {status === "connected" && latency != null && (
            <span className="ml-1 opacity-60">{latency}ms</span>
          )}
        </span>
      )}
    </div>
  );
}

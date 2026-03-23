"use client";

import { cn } from "../lib/utils";

export type ConnectionStatusType = "connected" | "connecting" | "reconnecting" | "disconnected";

const statusConfig: Record<ConnectionStatusType, { color: string; label: string; pulse: boolean }> = {
  connected: { color: "bg-success", label: "Connected", pulse: false },
  connecting: { color: "bg-warning", label: "Connecting...", pulse: true },
  reconnecting: { color: "bg-warning", label: "Reconnecting...", pulse: true },
  disconnected: { color: "bg-destructive", label: "Disconnected", pulse: false },
};

interface ConnectionStatusProps {
  status: ConnectionStatusType;
  latency?: number;
  reconnectCount?: number;
  hostname?: string;
  className?: string;
  showLabel?: boolean;
  onReconnect?: () => void;
}

export function ConnectionStatus({
  status,
  latency,
  reconnectCount,
  hostname,
  className,
  showLabel = true,
  onReconnect,
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
          {status === "reconnecting" && reconnectCount != null && reconnectCount > 0 && (
            <span className="ml-1 opacity-60">#{reconnectCount}</span>
          )}
          {status === "connected" && latency != null && (
            <span className="ml-1 opacity-60">{latency}ms</span>
          )}
        </span>
      )}
      {(status === "disconnected" || status === "reconnecting") && onReconnect && (
        <button
          className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          onClick={onReconnect}
        >
          Retry
        </button>
      )}
    </div>
  );
}

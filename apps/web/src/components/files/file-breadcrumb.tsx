"use client";

import { ChevronRight, Home } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { useFileStore } from "@/stores/file-store";
import { getRelayClient } from "@/hooks/use-websocket";

interface FileBreadcrumbProps {
  className?: string;
}

export function FileBreadcrumb({ className }: FileBreadcrumbProps) {
  const { currentPath, setCurrentPath, setIsLoading } = useFileStore();

  const parts = currentPath.split("/").filter(Boolean);

  const navigateTo = (index: number) => {
    const path = "/" + parts.slice(0, index + 1).join("/");
    setCurrentPath(path);
    setIsLoading(true);
    getRelayClient()?.send({ type: "file:list", path });
  };

  return (
    <div className={cn("flex items-center gap-0.5 overflow-x-auto px-2 py-1 text-sm scrollbar-none", className)}>
      <button
        className="shrink-0 rounded p-0.5 hover:bg-accent"
        onClick={() => navigateTo(-1)}
      >
        <Home className="h-3.5 w-3.5" />
      </button>
      {parts.map((part, i) => (
        <div key={i} className="flex items-center gap-0.5 shrink-0">
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
          <button
            className={cn(
              "rounded px-1 py-0.5 hover:bg-accent text-xs",
              i === parts.length - 1 ? "font-medium" : "text-muted-foreground",
            )}
            onClick={() => navigateTo(i)}
          >
            {part}
          </button>
        </div>
      ))}
    </div>
  );
}

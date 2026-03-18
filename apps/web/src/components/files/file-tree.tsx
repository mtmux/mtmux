"use client";

import { useEffect, useCallback } from "react";
import {
  File,
  Folder,
  FolderOpen,
  FileText,
  FileCode,
  Image,
  ChevronRight,
  ChevronDown,
  Grid3x3,
  List,
  ArrowUpDown,
  Home,
} from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { ScrollArea } from "@repo/ui/components/ui/scroll-area";
import { Input } from "@repo/ui/components/ui/input";
import { cn } from "@repo/ui/lib/utils";
import type { FileEntry } from "@repo/protocol";
import { useFileStore } from "@/stores/file-store";
import { getRelayClient } from "@/hooks/use-websocket";
import { useState } from "react";

function getFileIcon(entry: FileEntry) {
  if (entry.type === "directory") return Folder;
  const ext = entry.name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "py":
    case "go":
    case "rs":
    case "java":
    case "c":
    case "cpp":
    case "rb":
    case "php":
      return FileCode;
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "svg":
    case "webp":
      return Image;
    case "md":
    case "txt":
    case "log":
    case "csv":
      return FileText;
    default:
      return File;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface FileTreeProps {
  onFileSelect: (path: string) => void;
  className?: string;
  /** #2: When provided, renders breadcrumb inline in toolbar row */
  breadcrumbPath?: string;
  onNavigate?: (path: string) => void;
}

export function FileTree({ onFileSelect, className, breadcrumbPath, onNavigate }: FileTreeProps) {
  const {
    currentPath,
    entries,
    viewMode,
    sortBy,
    isLoading,
    setCurrentPath,
    setViewMode,
    setSortBy,
    setEntries,
    setIsLoading,
  } = useFileStore();
  const [filter, setFilter] = useState("");

  const loadDirectory = useCallback(
    (path: string) => {
      const client = getRelayClient();
      if (!client) return;
      setIsLoading(true);
      setCurrentPath(path);
      client.send({ type: "file:list", path });
    },
    [setCurrentPath, setIsLoading],
  );

  // Listen for file list responses
  useEffect(() => {
    const client = getRelayClient();
    if (!client) return;

    return client.onMessage((msg) => {
      if (msg.type === "file:list") {
        setEntries(msg.entries);
        setIsLoading(false);
      }
    });
  }, [setEntries, setIsLoading]);

  useEffect(() => {
    loadDirectory(currentPath);
  }, []);

  const handleEntryClick = useCallback(
    (entry: FileEntry) => {
      if (entry.type === "directory") {
        loadDirectory(entry.path);
      } else {
        onFileSelect(entry.path);
      }
    },
    [loadDirectory, onFileSelect],
  );

  const sortedEntries = [...entries]
    .filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => {
      // Directories always first
      if (a.type === "directory" && b.type !== "directory") return -1;
      if (a.type !== "directory" && b.type === "directory") return 1;
      switch (sortBy) {
        case "modified":
          return new Date(b.modified).getTime() - new Date(a.modified).getTime();
        case "size":
          return b.size - a.size;
        default:
          return a.name.localeCompare(b.name);
      }
    });

  return (
    <div className={cn("flex flex-col overflow-hidden", className)}>
      <div className="flex items-center gap-1 px-2 py-1.5 border-b">
        {/* #2: Inline breadcrumb when provided (mobile) */}
        {breadcrumbPath !== undefined && onNavigate && (
          <div className="flex items-center gap-0.5 shrink-0 overflow-x-auto scrollbar-none mr-1">
            <button className="shrink-0 rounded p-0.5 hover:bg-accent" onClick={() => onNavigate("/")}>
              <Home className="h-3.5 w-3.5" />
            </button>
            {breadcrumbPath.split("/").filter(Boolean).map((part, i, arr) => (
              <div key={i} className="flex items-center gap-0.5 shrink-0">
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
                <button
                  className={cn(
                    "rounded px-1 py-0.5 hover:bg-accent text-xs",
                    i === arr.length - 1 ? "font-medium" : "text-muted-foreground",
                  )}
                  onClick={() => onNavigate("/" + arr.slice(0, i + 1).join("/"))}
                >
                  {part}
                </button>
              </div>
            ))}
          </div>
        )}
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter..."
          className="h-7 text-xs"
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => setSortBy(sortBy === "name" ? "modified" : sortBy === "modified" ? "size" : "name")}
        >
          <ArrowUpDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => setViewMode(viewMode === "list" ? "grid" : "list")}
        >
          {viewMode === "list" ? <Grid3x3 className="h-3.5 w-3.5" /> : <List className="h-3.5 w-3.5" />}
        </Button>
      </div>

      <ScrollArea className="h-0 flex-1">
        {isLoading ? (
          <div className="space-y-1 py-1">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2 px-3 py-1.5">
                <div className="h-4 w-4 animate-pulse rounded bg-muted" />
                <div className="h-4 flex-1 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : viewMode === "list" ? (
          <div className="py-1">
            {sortedEntries.map((entry) => {
              const Icon = getFileIcon(entry);
              return (
                <button
                  key={entry.path}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent/50 transition-colors"
                  onClick={() => handleEntryClick(entry)}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate text-left">{entry.name}</span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {entry.type === "file" ? formatSize(entry.size) : ""}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-1 p-2 sm:grid-cols-4">
            {sortedEntries.map((entry) => {
              const Icon = getFileIcon(entry);
              return (
                <button
                  key={entry.path}
                  className="flex flex-col items-center gap-1 rounded-md p-2 hover:bg-accent/50 transition-colors"
                  onClick={() => handleEntryClick(entry)}
                >
                  <Icon className="h-8 w-8 text-muted-foreground" />
                  <span className="text-[10px] truncate w-full text-center">{entry.name}</span>
                </button>
              );
            })}
          </div>
        )}

        {sortedEntries.length === 0 && !isLoading && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {filter ? "No matching files" : "Empty directory"}
          </p>
        )}
      </ScrollArea>
    </div>
  );
}

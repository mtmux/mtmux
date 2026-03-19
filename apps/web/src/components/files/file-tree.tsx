"use client";

import { useEffect, useCallback, useState, useRef } from "react";
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
  FilePlus,
  FolderPlus,
  Upload,
  MoreHorizontal,
  Pencil,
  Trash2,
  ExternalLink,
  Terminal,
} from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { ScrollArea } from "@repo/ui/components/ui/scroll-area";
import { Input } from "@repo/ui/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@repo/ui/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@repo/ui/components/ui/alert-dialog";
import { cn } from "@repo/ui/lib/utils";
import { toast } from "sonner";
import type { FileEntry } from "@repo/protocol";
import { useFileStore } from "@/stores/file-store";
import { useSessionStore } from "@/stores/session-store";
import { useUiStore } from "@/stores/ui-store";
import { getRelayClient } from "@/hooks/use-websocket";

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
    openEditor,
  } = useFileStore();
  const [filter, setFilter] = useState("");
  const [inlineInput, setInlineInput] = useState<{ type: "file" | "folder" | "rename"; value: string; path?: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inlineInputRef = useRef<HTMLInputElement>(null);

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

  // Focus inline input when it appears
  useEffect(() => {
    if (inlineInput) {
      setTimeout(() => inlineInputRef.current?.focus(), 0);
    }
  }, [inlineInput]);

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

  const handleNewFile = useCallback(() => {
    setInlineInput({ type: "file", value: "" });
  }, []);

  const handleNewFolder = useCallback(() => {
    setInlineInput({ type: "folder", value: "" });
  }, []);

  const handleUpload = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const client = getRelayClient();
      if (!client) return;

      const filePath = currentPath + "/" + file.name;
      const reader = new FileReader();
      reader.onload = () => {
        const arrayBuffer = reader.result as ArrayBuffer;
        const bytes = new Uint8Array(arrayBuffer);
        const CHUNK_SIZE = 64 * 1024; // 64KB chunks
        let offset = 0;

        const sendChunk = () => {
          const chunk = bytes.slice(offset, offset + CHUNK_SIZE);
          offset += chunk.length;
          const final = offset >= bytes.length;

          // Convert to base64
          let binary = "";
          for (let i = 0; i < chunk.length; i++) {
            binary += String.fromCharCode(chunk[i]!);
          }
          const base64 = btoa(binary);

          client.send({ type: "file:upload", path: filePath, content: base64, final });

          if (!final) {
            setTimeout(sendChunk, 0);
          }
        };

        sendChunk();
      };
      reader.readAsArrayBuffer(file);

      // Reset input so same file can be re-uploaded
      e.target.value = "";
    },
    [currentPath],
  );

  const handleInlineSubmit = useCallback(() => {
    if (!inlineInput || !inlineInput.value.trim()) {
      setInlineInput(null);
      return;
    }

    const client = getRelayClient();
    if (!client) return;

    if (inlineInput.type === "file") {
      client.send({ type: "file:create", path: currentPath + "/" + inlineInput.value.trim() });
    } else if (inlineInput.type === "folder") {
      client.send({ type: "file:mkdir", path: currentPath + "/" + inlineInput.value.trim() });
    } else if (inlineInput.type === "rename" && inlineInput.path) {
      const dir = inlineInput.path.substring(0, inlineInput.path.lastIndexOf("/"));
      client.send({ type: "file:rename", oldPath: inlineInput.path, newPath: dir + "/" + inlineInput.value.trim() });
    }

    setInlineInput(null);
  }, [inlineInput, currentPath]);

  const handleDelete = useCallback(() => {
    if (!deleteTarget) return;
    const client = getRelayClient();
    if (!client) return;
    client.send({ type: "file:delete", path: deleteTarget.path });
    setDeleteTarget(null);
  }, [deleteTarget]);

  const handleRename = useCallback((entry: FileEntry) => {
    setInlineInput({ type: "rename", value: entry.name, path: entry.path });
  }, []);

  const handleCdInTerminal = useCallback(
    (path: string) => {
      if (!useSessionStore.getState().activeSessionId) {
        toast.error("No active session");
        return;
      }
      const client = getRelayClient();
      if (!client) return;
      client.send({ type: "command:send", command: `cd ${path}` });
      useUiStore.getState().setMobileTab("terminal");
      toast.success("Navigated to " + path.split("/").pop());
    },
    [],
  );

  const sortedEntries = [...entries]
    .filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => {
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
          className="h-9 w-9 shrink-0"
          onClick={handleNewFile}
          title="New file"
        >
          <FilePlus className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={handleNewFolder}
          title="New folder"
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={handleUpload}
          title="Upload file"
        >
          <Upload className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={() => setSortBy(sortBy === "name" ? "modified" : sortBy === "modified" ? "size" : "name")}
        >
          <ArrowUpDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0"
          onClick={() => setViewMode(viewMode === "list" ? "grid" : "list")}
        >
          {viewMode === "list" ? <Grid3x3 className="h-3.5 w-3.5" /> : <List className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {/* Hidden file input for upload */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFileUpload}
      />

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
            {/* Inline input for new file/folder */}
            {inlineInput && inlineInput.type !== "rename" && (
              <div className="flex items-center gap-2 px-3 py-1.5">
                {inlineInput.type === "folder" ? (
                  <FolderPlus className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <FilePlus className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <Input
                  ref={inlineInputRef}
                  value={inlineInput.value}
                  onChange={(e) => setInlineInput({ ...inlineInput, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleInlineSubmit();
                    if (e.key === "Escape") setInlineInput(null);
                  }}
                  onBlur={handleInlineSubmit}
                  placeholder={inlineInput.type === "folder" ? "Folder name..." : "File name..."}
                  className="h-6 text-xs"
                />
              </div>
            )}
            {sortedEntries.map((entry) => {
              const Icon = getFileIcon(entry);
              const isRenaming = inlineInput?.type === "rename" && inlineInput.path === entry.path;

              return (
                <div key={entry.path} className="group flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent/50 transition-colors">
                  {isRenaming ? (
                    <>
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <Input
                        ref={inlineInputRef}
                        value={inlineInput!.value}
                        onChange={(e) => setInlineInput({ ...inlineInput!, value: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleInlineSubmit();
                          if (e.key === "Escape") setInlineInput(null);
                        }}
                        onBlur={handleInlineSubmit}
                        className="h-6 flex-1 text-xs"
                      />
                    </>
                  ) : (
                    <>
                      <button
                        className="flex flex-1 items-center gap-2 min-w-0"
                        onClick={() => handleEntryClick(entry)}
                      >
                        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="flex-1 truncate text-left">{entry.name}</span>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {entry.type === "file" ? formatSize(entry.size) : ""}
                        </span>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {entry.type === "file" && (
                            <DropdownMenuItem onClick={() => openEditor(entry.path)}>
                              <ExternalLink className="mr-2 h-3.5 w-3.5" />
                              Open in Editor
                            </DropdownMenuItem>
                          )}
                          {entry.type === "directory" && (
                            <DropdownMenuItem onClick={() => handleCdInTerminal(entry.path)}>
                              <Terminal className="mr-2 h-3.5 w-3.5" />
                              cd in Terminal
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onClick={() => handleRename(entry)}>
                            <Pencil className="mr-2 h-3.5 w-3.5" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => setDeleteTarget(entry)}
                            className="text-destructive"
                          >
                            <Trash2 className="mr-2 h-3.5 w-3.5" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  )}
                </div>
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

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone.{" "}
              {deleteTarget?.type === "directory" && "All contents will be deleted."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

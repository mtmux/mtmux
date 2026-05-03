"use client";

import { useEffect, useState } from "react";
import { X, Download, Copy, Check, File, Film, Music, Archive, FileQuestion, Image } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { ScrollArea } from "@repo/ui/components/ui/scroll-area";
import { Badge } from "@repo/ui/components/ui/badge";
import { cn } from "@repo/ui/lib/utils";
import { getRelayClient } from "@/hooks/use-websocket";
import { useFileStore } from "@/stores/file-store";
import { getLanguageLabel, isBinaryFile, getFileCategory, formatFileSize, getFileViewMode } from "@/lib/file-utils";
import { getFileUrl } from "@/lib/file-url";

const CATEGORY_ICONS: Record<string, typeof File> = {
  image: Image,
  video: Film,
  audio: Music,
  archive: Archive,
  document: FileQuestion,
  font: FileQuestion,
  binary: FileQuestion,
};

function PreviewMediaError({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-4 text-muted-foreground">
      <FileQuestion className="h-8 w-8 opacity-40" />
      <p className="text-xs">{message}</p>
    </div>
  );
}

function PreviewImage({ path, fileName }: { path: string; fileName: string }) {
  const [error, setError] = useState(false);
  if (error) return <PreviewMediaError message="Failed to load image" />;
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={getFileUrl(path)}
      alt={fileName}
      className="max-h-48 max-w-full object-contain"
      onError={() => setError(true)}
    />
  );
}

function PreviewVideo({ path }: { path: string }) {
  const [error, setError] = useState(false);
  if (error) return <PreviewMediaError message="Failed to load video" />;
  return (
    <video
      src={getFileUrl(path)}
      controls
      preload="metadata"
      className="max-h-48 max-w-full"
      onError={() => setError(true)}
    />
  );
}

function PreviewAudio({ path }: { path: string }) {
  const [error, setError] = useState(false);
  if (error) return <PreviewMediaError message="Failed to load audio" />;
  return (
    <>
      <Music className="h-12 w-12 mb-3 opacity-40" />
      <audio
        src={getFileUrl(path)}
        controls
        preload="metadata"
        className="w-full max-w-[200px]"
        onError={() => setError(true)}
      />
    </>
  );
}

interface FilePreviewProps {
  path: string | null;
  onClose: () => void;
  className?: string;
}

export function FilePreview({ path, onClose, className }: FilePreviewProps) {
  const { fileContent, fileStat, setFileContent, setFileStat } = useFileStore();
  const [copied, setCopied] = useState(false);
  const binary = path ? isBinaryFile(path) : false;

  useEffect(() => {
    if (!path) return;

    const client = getRelayClient();
    if (!client) return;

    if (!isBinaryFile(path)) {
      client.send({ type: "file:read", path });
    }
    client.send({ type: "file:stat", path });

    const unsub = client.onMessage((msg) => {
      if (msg.type === "file:content" && msg.path === path) {
        setFileContent(msg.content);
      }
      if (msg.type === "file:stat" && msg.stat.path === path) {
        setFileStat(msg.stat);
      }
    });

    return () => {
      unsub();
      setFileContent(null);
      setFileStat(null);
    };
  }, [path, setFileContent, setFileStat]);

  if (!path) {
    return (
      <div className={cn("flex flex-col items-center justify-center border-l text-muted-foreground", className)}>
        <File className="h-10 w-10 mb-2 opacity-40" />
        <p className="text-sm">Select a file to preview</p>
      </div>
    );
  }

  const fileName = path.split("/").pop() ?? "";
  const language = getLanguageLabel(path);

  const handleCopy = async () => {
    if (fileContent) {
      await navigator.clipboard.writeText(fileContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className={cn("flex flex-col border-l", className)}>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="flex-1 truncate text-sm font-medium">{fileName}</span>
        <Badge variant="secondary" className="text-[10px]">
          {language}
        </Badge>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleCopy} disabled={binary}>
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
          <X className="h-3 w-3" />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        {binary ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            {(() => {
              const viewMode = getFileViewMode(path!);
              const category = getFileCategory(path!) ?? "binary";
              const Icon = CATEGORY_ICONS[category] ?? FileQuestion;

              if (viewMode === "image") {
                return <PreviewImage path={path!} fileName={fileName} />;
              }

              if (viewMode === "video") {
                return <PreviewVideo path={path!} />;
              }

              if (viewMode === "audio") {
                return <PreviewAudio path={path!} />;
              }

              return (
                <>
                  <Icon className="h-16 w-16 mb-4 opacity-40" />
                  <p className="text-sm font-medium text-foreground mb-1">{fileName}</p>
                  <Badge variant="secondary" className="mb-3 capitalize">{category}</Badge>
                  {fileStat && (
                    <div className="flex flex-col items-center gap-1 text-xs">
                      <span>{formatFileSize(fileStat.size)}</span>
                      <span>{fileStat.permissions}</span>
                      <span>{new Date(fileStat.modified).toLocaleString()}</span>
                    </div>
                  )}
                  <p className="mt-4 text-xs">Binary file — preview not available</p>
                </>
              );
            })()}
          </div>
        ) : fileContent != null ? (
          <pre className="p-3 text-xs font-mono leading-relaxed whitespace-pre-wrap break-all">
            {fileContent.split("\n").map((line, i) => (
              <div key={i} className="flex">
                <span className="inline-block w-10 shrink-0 text-right pr-3 text-muted-foreground select-none">
                  {i + 1}
                </span>
                <span>{line}</span>
              </div>
            ))}
          </pre>
        ) : (
          <div className="flex items-center justify-center py-8">
            <span className="text-sm text-muted-foreground">Loading...</span>
          </div>
        )}
      </ScrollArea>
      {fileStat && (
        <div className="flex items-center gap-3 border-t px-3 py-1 text-[10px] text-muted-foreground">
          <span>{fileStat.size} bytes</span>
          <span>{fileStat.permissions}</span>
          <span>{new Date(fileStat.modified).toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}

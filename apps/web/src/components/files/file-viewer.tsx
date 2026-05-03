"use client";

import { useEffect, useState } from "react";
import { X, Download, FileText, Film, Music, Archive, FileQuestion, Image as ImageIcon, FileType } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { Button } from "@repo/ui/components/ui/button";
import { Badge } from "@repo/ui/components/ui/badge";
import { useFileStore } from "@/stores/file-store";
import { getFileUrl } from "@/lib/file-url";
import { getFileViewMode, getFileCategory, formatFileSize, type FileViewMode } from "@/lib/file-utils";
import { getRelayClient } from "@/hooks/use-websocket";

const CATEGORY_ICONS: Record<string, typeof FileQuestion> = {
  image: ImageIcon,
  video: Film,
  audio: Music,
  archive: Archive,
  document: FileQuestion,
  font: FileType,
  binary: FileQuestion,
};

function MediaError({ path, message }: { path: string; message: string }) {
  const fileName = path.split("/").pop() ?? "";
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-8 text-muted-foreground">
      <FileQuestion className="h-12 w-12 opacity-40" />
      <p className="text-sm">{message}</p>
      <a href={getFileUrl(path, true)} download={fileName}>
        <Button variant="secondary" size="sm">
          <Download className="mr-2 h-4 w-4" />
          Download Instead
        </Button>
      </a>
    </div>
  );
}

function ImageContent({ path }: { path: string }) {
  const [actualSize, setActualSize] = useState(false);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  if (error) {
    return <MediaError path={path} message="Failed to load image — the file may be missing or inaccessible." />;
  }

  return (
    <div
      className="flex h-full items-center justify-center overflow-auto"
      style={{
        backgroundImage: "linear-gradient(45deg, hsl(var(--muted)) 25%, transparent 25%), linear-gradient(-45deg, hsl(var(--muted)) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, hsl(var(--muted)) 75%), linear-gradient(-45deg, transparent 75%, hsl(var(--muted)) 75%)",
        backgroundSize: "20px 20px",
        backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
      }}
    >
      <div className="relative">
        {loading && (
          <div className="flex items-center justify-center p-8">
            <span className="text-sm text-muted-foreground">Loading...</span>
          </div>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={getFileUrl(path)}
          alt={path.split("/").pop() ?? ""}
          className={cn(
            actualSize ? "" : "max-w-full object-contain",
            loading && "hidden",
          )}
          style={{
            touchAction: "pinch-zoom",
            ...(actualSize ? {} : { maxHeight: "calc(var(--vv-height, 100dvh) - 8rem)" }),
          }}
          onLoad={() => setLoading(false)}
          onError={() => { setLoading(false); setError(true); }}
        />
        {!loading && (
          <Button
            variant="secondary"
            size="sm"
            className="absolute bottom-3 right-3 opacity-80 hover:opacity-100"
            onClick={() => setActualSize(!actualSize)}
          >
            {actualSize ? "Fit to Screen" : "Actual Size"}
          </Button>
        )}
      </div>
    </div>
  );
}

function VideoContent({ path }: { path: string }) {
  const [error, setError] = useState(false);

  if (error) {
    return <MediaError path={path} message="Failed to load video — the format may be unsupported or the file inaccessible." />;
  }

  return (
    <div className="flex h-full items-center justify-center">
      <video
        src={getFileUrl(path)}
        controls
        preload="metadata"
        className="max-h-full max-w-full"
        onError={() => setError(true)}
      />
    </div>
  );
}

function AudioContent({ path }: { path: string }) {
  const fileName = path.split("/").pop() ?? "";
  const [duration, setDuration] = useState<string | null>(null);
  const [error, setError] = useState(false);

  if (error) {
    return <MediaError path={path} message="Failed to load audio — the format may be unsupported or the file inaccessible." />;
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <Music className="h-20 w-20 text-muted-foreground opacity-40" />
      <p className="text-sm font-medium">{fileName}</p>
      {duration && <p className="text-xs text-muted-foreground">{duration}</p>}
      <audio
        src={getFileUrl(path)}
        controls
        preload="metadata"
        className="w-full max-w-md"
        onError={() => setError(true)}
        onLoadedMetadata={(e) => {
          const secs = (e.target as HTMLAudioElement).duration;
          if (Number.isFinite(secs)) {
            const m = Math.floor(secs / 60);
            const s = Math.floor(secs % 60);
            setDuration(`${m}:${s.toString().padStart(2, "0")}`);
          }
        }}
      />
    </div>
  );
}

function PdfContent({ path }: { path: string }) {
  const [error, setError] = useState(false);

  if (error) {
    return <MediaError path={path} message="Failed to load PDF — try downloading it instead." />;
  }

  return (
    <iframe
      src={getFileUrl(path)}
      className="h-full w-full border-0"
      title={path.split("/").pop() ?? "PDF"}
      onError={() => setError(true)}
    />
  );
}

function BinaryContent({ path, size }: { path: string; size?: number }) {
  const fileName = path.split("/").pop() ?? "";
  const category = getFileCategory(path) ?? "binary";
  const Icon = CATEGORY_ICONS[category] ?? FileQuestion;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <Icon className="h-20 w-20 opacity-40" />
      <p className="text-sm font-medium text-foreground">{fileName}</p>
      <Badge variant="secondary" className="capitalize">{category}</Badge>
      {size != null && <p className="text-xs">{formatFileSize(size)}</p>}
      <a href={getFileUrl(path, true)} download={fileName}>
        <Button variant="default" size="lg" className="mt-4">
          <Download className="mr-2 h-4 w-4" />
          Download
        </Button>
      </a>
      <p className="mt-2 text-xs">This file type can&apos;t be previewed in the browser</p>
    </div>
  );
}

const VIEW_MODE_LABELS: Record<FileViewMode, string> = {
  text: "text",
  image: "image",
  video: "video",
  audio: "audio",
  pdf: "PDF",
  binary: "binary",
};

export function FileViewer() {
  const editorFile = useFileStore((s) => s.editorFile);
  const closeEditor = useFileStore((s) => s.closeEditor);
  const openEditorAsText = useFileStore((s) => s.openEditorAsText);
  const setFileStat = useFileStore((s) => s.setFileStat);
  const fileStat = useFileStore((s) => s.fileStat);

  useEffect(() => {
    if (!editorFile) return;
    const client = getRelayClient();
    if (!client) return;
    client.send({ type: "file:stat", path: editorFile });
    const unsub = client.onMessage((msg) => {
      if (msg.type === "file:stat" && msg.stat.path === editorFile) {
        setFileStat(msg.stat);
      }
    });
    return () => {
      unsub();
      setFileStat(null);
    };
  }, [editorFile, setFileStat]);

  if (!editorFile) return null;

  const fileName = editorFile.split("/").pop() ?? "";
  const viewMode = getFileViewMode(editorFile);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{fileName}</span>
        <Badge variant="secondary" className="text-[10px]">
          {VIEW_MODE_LABELS[viewMode]}
        </Badge>
        <a href={getFileUrl(editorFile, true)} download={fileName}>
          <Button variant="ghost" size="icon" className="h-7 w-7" title="Download">
            <Download className="h-4 w-4" />
          </Button>
        </a>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Open as Text"
          onClick={() => openEditorAsText(editorFile)}
        >
          <FileText className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          title="Close"
          onClick={closeEditor}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {viewMode === "image" && <ImageContent path={editorFile} />}
        {viewMode === "video" && <VideoContent path={editorFile} />}
        {viewMode === "audio" && <AudioContent path={editorFile} />}
        {viewMode === "pdf" && <PdfContent path={editorFile} />}
        {viewMode === "binary" && <BinaryContent path={editorFile} size={fileStat?.size} />}
      </div>

      {/* Status bar */}
      {fileStat && (
        <div className="flex items-center gap-3 border-t px-3 py-1 text-[10px] text-muted-foreground">
          <span>{formatFileSize(fileStat.size)}</span>
          <span>{fileStat.permissions}</span>
          <span>{new Date(fileStat.modified).toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}

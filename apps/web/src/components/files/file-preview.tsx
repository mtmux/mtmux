"use client";

import { useEffect, useState } from "react";
import { X, Download, Copy, Check, File } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { ScrollArea } from "@repo/ui/components/ui/scroll-area";
import { Badge } from "@repo/ui/components/ui/badge";
import { cn } from "@repo/ui/lib/utils";
import { getRelayClient } from "@/hooks/use-websocket";
import { useFileStore } from "@/stores/file-store";
import { getLanguageLabel } from "@/lib/file-utils";

interface FilePreviewProps {
  path: string | null;
  onClose: () => void;
  className?: string;
}

export function FilePreview({ path, onClose, className }: FilePreviewProps) {
  const { fileContent, fileStat, setFileContent, setFileStat } = useFileStore();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!path) return;

    const client = getRelayClient();
    if (!client) return;

    client.send({ type: "file:read", path });
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
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleCopy}>
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
          <X className="h-3 w-3" />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        {fileContent != null ? (
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

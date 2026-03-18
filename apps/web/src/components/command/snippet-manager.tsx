"use client";

import { useState } from "react";
import { Plus, Trash2, Pin, PinOff } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/ui/dialog";
import { Input } from "@repo/ui/components/ui/input";
import { Label } from "@repo/ui/components/ui/label";
import { Button } from "@repo/ui/components/ui/button";
import { ScrollArea } from "@repo/ui/components/ui/scroll-area";
import { useCommandStore } from "@/stores/command-store";

interface SnippetManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SnippetManager({ open, onOpenChange }: SnippetManagerProps) {
  const { snippets, addSnippet, removeSnippet, togglePinned } = useCommandStore();
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");

  const handleAdd = () => {
    if (!name.trim() || !command.trim()) return;
    addSnippet({ name: name.trim(), command: command.trim(), pinned: false });
    setName("");
    setCommand("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Command Snippets</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex gap-2">
            <div className="flex-1 space-y-1">
              <Label className="text-xs">Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Build project"
                className="h-8 text-sm"
              />
            </div>
            <div className="flex-1 space-y-1">
              <Label className="text-xs">Command</Label>
              <Input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npm run build"
                className="h-8 text-sm"
              />
            </div>
            <Button
              variant="outline"
              size="icon"
              className="mt-5 h-8 w-8 shrink-0"
              onClick={handleAdd}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>

          <ScrollArea className="max-h-[300px]">
            <div className="space-y-1">
              {snippets.length === 0 && (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  No snippets yet
                </p>
              )}
              {snippets.map((snippet) => (
                <div
                  key={snippet.id}
                  className="flex items-center gap-2 rounded-md border px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{snippet.name}</div>
                    <div className="text-xs text-muted-foreground font-mono truncate">
                      {snippet.command}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={() => togglePinned(snippet.id)}
                  >
                    {snippet.pinned ? (
                      <PinOff className="h-3 w-3" />
                    ) : (
                      <Pin className="h-3 w-3" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 text-destructive"
                    onClick={() => removeSnippet(snippet.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

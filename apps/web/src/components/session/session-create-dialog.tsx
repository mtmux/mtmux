"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@repo/ui/components/ui/dialog";
import { Input } from "@repo/ui/components/ui/input";
import { Label } from "@repo/ui/components/ui/label";
import { Button } from "@repo/ui/components/ui/button";
import { getRelayClient } from "@/hooks/use-websocket";
import { useSessionStore } from "@/stores/session-store";

interface SessionCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SessionCreateDialog({ open, onOpenChange }: SessionCreateDialogProps) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [command, setCommand] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const { setActiveSession } = useSessionStore();
  const waitingForSession = useRef(false);

  // Listen for session:created to auto-attach
  useEffect(() => {
    const client = getRelayClient();
    if (!client) return;

    return client.onMessage((msg) => {
      if (msg.type === "session:created" && waitingForSession.current) {
        waitingForSession.current = false;
        setIsCreating(false);
        setActiveSession(msg.session.name);
        if (typeof window !== "undefined") {
          localStorage.setItem("termbridge-last-session", msg.session.name);
        }
      }
    });
  }, [setActiveSession]);

  const handleCreate = useCallback(() => {
    const client = getRelayClient();
    if (!client) return;

    setIsCreating(true);
    waitingForSession.current = true;

    client.send({
      type: "session:create",
      name: name || undefined,
      cwd: cwd || undefined,
      command: command || undefined,
    });

    setName("");
    setCwd("");
    setCommand("");
    onOpenChange(false);
  }, [name, cwd, command, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Session</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="session-name">Name (optional)</Label>
            <Input
              id="session-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-session"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="session-cwd">Working Directory (optional)</Label>
            <Input
              id="session-cwd"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/home/user/project"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="session-command">Command (optional)</Label>
            <Input
              id="session-command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="bash"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={isCreating}>
            {isCreating ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

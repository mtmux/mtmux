"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@repo/ui/components/ui/badge";
import { Button } from "@repo/ui/components/ui/button";
import { Input } from "@repo/ui/components/ui/input";
import { cn } from "@repo/ui/lib/utils";
import { Check, Info, Loader2, Pencil, Share2, Trash2, X } from "lucide-react";
import { platformName, timeAgo } from "./format";
import { ShareDialog } from "./share-dialog";

export type RegisteredServer = {
  id: string;
  name: string;
  slug: string;
  /** Ed25519 identity, hex. The browser derives its local key id from this. */
  publicKey: string;
  online: boolean;
  lastSeenAt: number | null;
  platform: string | null;
  cliVersion: string | null;
};

export type ServerRowProps = {
  server: RegisteredServer;
  /** Re-rendered on a timer so "4m ago" ages without a refresh. */
  now: number;
  connecting: boolean;
  /**
   * Whether *this* browser holds a pairing for the machine.
   *
   * Being signed in is not the same as being able to open a terminal: the keys
   * live on the device, not in the account. False means the primary action is
   * "pair this device once", not "connect".
   */
  paired: boolean;
  /** Set when a connect attempt came back with something to say. */
  notice: string | null;
  onConnect: () => void;
  onRename: (name: string) => Promise<boolean>;
  onRemove: () => void;
};

export function ServerRow({
  server,
  now,
  connecting,
  paired,
  notice,
  onConnect,
  onRename,
  onRemove,
}: ServerRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(server.name);
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function startEditing() {
    setDraft(server.name);
    setEditing(true);
  }

  async function save() {
    const name = draft.trim();
    if (!name || name === server.name) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const ok = await onRename(name);
    setSaving(false);
    // A refusal (402, validation) keeps the field open with what they typed, so
    // the rename survives reading the upgrade prompt behind the dialog.
    if (ok) setEditing(false);
  }

  return (
    <li className="rounded-lg border border-border bg-card text-card-foreground transition-colors hover:border-border/80">
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4">
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <Input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditing(false);
                }}
                aria-label={`Name for ${server.name}`}
                maxLength={64}
                className="h-11"
                disabled={saving}
              />
              <Button
                type="submit"
                size="icon"
                className="h-11 w-11 shrink-0"
                disabled={saving}
                aria-label="Save name"
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Check className="h-4 w-4" aria-hidden />
                )}
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-11 w-11 shrink-0"
                onClick={() => setEditing(false)}
                disabled={saving}
                aria-label="Cancel rename"
              >
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </form>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-full",
                    server.online ? "bg-success" : "bg-muted-foreground/40",
                  )}
                  aria-hidden
                />
                <h2 className="truncate text-base font-medium text-foreground">
                  {server.name}
                </h2>
                <Badge
                  variant={server.online ? "secondary" : "outline"}
                  className="shrink-0"
                >
                  {server.online ? "Online" : "Offline"}
                </Badge>
                <button
                  type="button"
                  onClick={startEditing}
                  aria-label={`Rename ${server.name}`}
                  className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:hidden"
                >
                  <Pencil className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <p className="mt-1 truncate text-sm text-muted-foreground">
                {platformName(server.platform)}
                <span aria-hidden> · </span>
                {server.online ? "active now" : timeAgo(server.lastSeenAt, now)}
                {server.cliVersion && (
                  <>
                    <span aria-hidden> · </span>
                    <span className="font-mono text-xs">
                      v{server.cliVersion}
                    </span>
                  </>
                )}
              </p>
            </>
          )}
        </div>

        {!editing && (
          <div className="flex shrink-0 items-center gap-1">
            {/* The label is the honest one: this browser can only open a
                machine it already holds keys for, and "Connect" on a machine
                it has never paired with would be a promise it cannot keep. */}
            <Button
              onClick={onConnect}
              disabled={connecting}
              variant={paired ? "default" : "outline"}
              className="h-11 flex-1 px-5 sm:flex-none"
            >
              {connecting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Opening…
                </>
              ) : paired ? (
                "Open"
              ) : (
                "Pair this device"
              )}
            </Button>
            {/* Shows the command rather than running it — the browser has no
                way to mint a grant. See share-dialog.tsx. */}
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11"
              onClick={() => setSharing(true)}
              aria-label={`Share a session on ${server.name}`}
            >
              <Share2 className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="hidden h-11 w-11 sm:inline-flex"
              onClick={startEditing}
              aria-label={`Rename ${server.name}`}
            >
              <Pencil className="h-4 w-4" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-11 w-11 text-muted-foreground hover:text-destructive"
              onClick={onRemove}
              aria-label={`Remove ${server.name}`}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        )}
      </div>

      {notice && (
        <p
          role="status"
          className="flex items-start gap-2 border-t border-border px-4 py-3 text-sm text-muted-foreground"
        >
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{notice}</span>
        </p>
      )}

      <ShareDialog
        open={sharing}
        onOpenChange={setSharing}
        serverName={server.name}
      />
    </li>
  );
}

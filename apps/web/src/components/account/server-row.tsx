"use client";

import { useEffect, useRef, useState } from "react";
import { Badge } from "@repo/ui/components/ui/badge";
import { Button } from "@repo/ui/components/ui/button";
import { Input } from "@repo/ui/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/ui/dropdown-menu";
import { cn } from "@repo/ui/lib/utils";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Info,
  Loader2,
  MoreVertical,
  Pencil,
  QrCode,
  Share2,
  Trash2,
  Unlink,
  X,
} from "lucide-react";
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
  /** A name this device gave the machine, shadowing the account's. */
  localName?: string | null;
  /** Set when a connect attempt came back with something to say. */
  notice: string | null;
  /** Position, so the move controls can disable rather than silently no-op. */
  first?: boolean;
  last?: boolean;
  onConnect: () => void;
  onRename: (name: string) => Promise<boolean>;
  onRemove: () => void;
  /** Ask the machine to admit this browser again, paired or not. */
  onRepair?: () => void;
  /** Drop this device's keys. Absent when there are none to drop. */
  onForget?: () => void;
  /** Absent when the machine's identity cannot be read, so it cannot be keyed. */
  onMove?: (direction: -1 | 1) => void;
};

export function ServerRow({
  server,
  now,
  connecting,
  paired,
  localName,
  notice,
  first,
  last,
  onConnect,
  onRename,
  onRemove,
  onRepair,
  onForget,
  onMove,
}: ServerRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(localName ?? server.name);
  const [saving, setSaving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const displayName = localName || server.name;

  function startEditing() {
    setDraft(displayName);
    setEditing(true);
  }

  async function save() {
    const name = draft.trim();
    if (!name || name === displayName) {
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
                aria-label={`Name for ${displayName}`}
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
                  {displayName}
                </h2>
                <Badge
                  variant={server.online ? "secondary" : "outline"}
                  className="shrink-0"
                >
                  {server.online ? "Online" : "Offline"}
                </Badge>
                {/* Said out loud, because a name only this browser can see is
                    otherwise indistinguishable from one everybody sees. */}
                {localName && localName !== server.name && (
                  <Badge variant="outline" className="shrink-0">
                    This device
                  </Badge>
                )}
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

            {/*
              A menu rather than four icon buttons.

              The row had share, rename and remove as bare icons and no room for
              the three actions that mattered more — re-pair, reorder, forget —
              which is how "unpair and start over" became the only way to fix a
              pairing. A menu holds all six, names them in words, and gives the
              destructive ones somewhere to sit that is not one mis-tap from
              Open.
            */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11"
                  aria-label={`More actions for ${displayName}`}
                >
                  <MoreVertical className="h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onSelect={() => startEditing()}>
                  <Pencil className="h-4 w-4" aria-hidden />
                  Rename
                </DropdownMenuItem>
                {/* Shows the command rather than running it — the browser has
                    no way to mint a grant. See share-dialog.tsx. */}
                <DropdownMenuItem onSelect={() => setSharing(true)}>
                  <Share2 className="h-4 w-4" aria-hidden />
                  Share a session
                </DropdownMenuItem>

                {onMove && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={first}
                      onSelect={() => onMove(-1)}
                    >
                      <ArrowUp className="h-4 w-4" aria-hidden />
                      Move up
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={last}
                      onSelect={() => onMove(1)}
                    >
                      <ArrowDown className="h-4 w-4" aria-hidden />
                      Move down
                    </DropdownMenuItem>
                  </>
                )}

                {onRepair && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled={!server.online}
                      onSelect={() => onRepair()}
                    >
                      <QrCode className="h-4 w-4" aria-hidden />
                      {paired ? "Pair this device again" : "Pair this device"}
                    </DropdownMenuItem>
                  </>
                )}

                <DropdownMenuSeparator />
                {onForget && (
                  <DropdownMenuItem onSelect={() => onForget()}>
                    <Unlink className="h-4 w-4" aria-hidden />
                    Forget on this device
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  onSelect={() => onRemove()}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                  Remove from account
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
        serverName={displayName}
      />
    </li>
  );
}

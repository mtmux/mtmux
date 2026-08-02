"use client";

import { useState } from "react";
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
import { Button } from "@repo/ui/components/ui/button";
import { Skeleton } from "@repo/ui/components/ui/skeleton";
import { AlertCircle, RefreshCw, Server } from "lucide-react";
import { toast } from "sonner";
import { ApiError, apiFetch } from "@/lib/auth-client";
import type { ServersState } from "@/hooks/use-servers";
import type { MachinePrefsState } from "@/hooks/use-machine-prefs";
import { connectToServer, deviceIdForPublicKey } from "./connect-to-server";
import { ServerRow, type RegisteredServer } from "./server-row";
import { InstallMachine } from "@/components/entry/install-machine";
import type { RenameTarget } from "./dashboard-body";

/**
 * The management section: rename, reorder, re-pair, share, remove, install.
 *
 * No longer the only route to pairing, and no longer a second copy of the
 * machine list — the cards above own that, and this owns what you do to a
 * machine rather than with it. Its state comes from `useServers`, so there is
 * one `GET /v1/servers`, one normalizer and one clock tick for the page.
 *
 * Rename moved out to `DashboardBody`: there are two names a machine can have
 * (the account's and this device's), the choice between them is the same
 * everywhere, and this component was the only place that could reach either.
 */
export function ServerList({
  servers: state,
  machines,
  onRequestAccess,
  onRename,
}: {
  servers: ServersState;
  /** Device-local names, ordering and pairings. See `use-machine-prefs.ts`. */
  machines: MachinePrefsState;
  /** Owned by the page — one dialog, because the broker allows one request. */
  onRequestAccess: (server: RegisteredServer) => void;
  onRename: (target: RenameTarget, name: string) => Promise<boolean>;
}) {
  const { servers, phase, message, pairedKeys, now, refresh, remove } = state;
  const [connecting, setConnecting] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<RegisteredServer | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [pendingForget, setPendingForget] = useState<RegisteredServer | null>(
    null,
  );

  /**
   * Three outcomes, and only one of them used to work.
   *
   * Paired takes the local path: the keys and descriptor are already here, so
   * this is a lookup and a mirror write with nothing asked of the broker.
   *
   * Unpaired and online now opens the request dialog — the thing the button has
   * always been labelled "Pair this device" and never done. It used to run the
   * same local lookup, fail, and tell you to go and use the other computer.
   *
   * Unpaired and offline keeps the notice, because there is nothing to ask: the
   * request is delivered over the machine's own tunnel, so a machine that is not
   * connected cannot be asked anything.
   */
  async function handleConnect(server: RegisteredServer) {
    setConnecting(server.id);
    setNotices((prev) => ({ ...prev, [server.id]: "" }));
    try {
      const result = await connectToServer(server.publicKey);
      if (result.ok) {
        // A hard navigation, deliberately: `connectToServer` writes the active
        // descriptor and the terminal reads it during store hydration on mount.
        // `router.push` would reuse the running client tree, which has already
        // hydrated against the previous machine.
        window.location.assign(result.href);
        return;
      }
      if (server.online) {
        onRequestAccess(server);
        return;
      }
      setNotices((prev) => ({ ...prev, [server.id]: result.reason }));
      toast.info("Not available yet", { description: result.reason });
    } finally {
      setConnecting(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setDeleting(true);
    try {
      await apiFetch(`/v1/servers/${encodeURIComponent(target.id)}`, {
        method: "DELETE",
      });
      remove(target.id);
      // The account row is gone, so this device's keys for it are dead weight —
      // and its local name would otherwise outlive the machine it named.
      const serverId = deviceIdForPublicKey(target.publicKey);
      if (serverId) await machines.forget(serverId);
      toast.success(`Removed ${target.name}`);
      setPendingDelete(null);
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not remove that machine.",
      );
    } finally {
      setDeleting(false);
    }
  }

  async function confirmForget() {
    if (!pendingForget) return;
    const serverId = deviceIdForPublicKey(pendingForget.publicKey);
    if (serverId) await machines.forget(serverId);
    await state.refreshPaired();
    toast.success(`Forgot ${pendingForget.name} on this device`, {
      description: "It stays on your account. Pair with it again any time.",
    });
    setPendingForget(null);
  }

  /**
   * The user's order, applied to the account's list.
   *
   * Sorting by device id rather than by account id, because the order is stored
   * against the pairing — the same key the terminal's switcher and the session
   * groups sort by, so all three agree.
   */
  const ordered = (() => {
    const byServerId = new Map<string, RegisteredServer>();
    const unkeyed: RegisteredServer[] = [];
    for (const server of servers) {
      const id = deviceIdForPublicKey(server.publicKey);
      if (id) byServerId.set(id, server);
      else unkeyed.push(server);
    }
    const sorted = machines
      .sortIds([...byServerId.keys()])
      .map((id) => byServerId.get(id)!)
      .filter(Boolean);
    return [...sorted, ...unkeyed];
  })();

  return (
    <>
      {phase === "loading" && <ServerSkeletons count={servers.length} />}

      {phase === "error" && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-center">
          <AlertCircle
            className="mx-auto h-6 w-6 text-destructive"
            aria-hidden
          />
          <h2 className="mt-3 text-base font-medium text-foreground">
            Couldn&apos;t load your machines
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{message}</p>
          <Button
            variant="outline"
            className="mt-4 h-11"
            onClick={() => void refresh()}
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Try again
          </Button>
        </div>
      )}

      {phase === "ready" && servers.length === 0 && <EmptyState />}

      {phase === "ready" && servers.length > 0 && (
        <ul className="space-y-3" aria-label="Machines on this account">
          {ordered.map((server, index) => {
            const serverId = deviceIdForPublicKey(server.publicKey);
            const paired = pairedKeys.has(server.publicKey);
            return (
              <ServerRow
                key={server.id}
                server={server}
                now={now}
                connecting={connecting === server.id}
                paired={paired}
                localName={serverId ? machines.localName(serverId) : null}
                notice={notices[server.id] || null}
                first={index === 0}
                last={index === ordered.length - 1}
                onConnect={() => void handleConnect(server)}
                onRename={(name) =>
                  onRename(
                    { accountId: server.id, serverId, current: server.name },
                    name,
                  )
                }
                onRemove={() => setPendingDelete(server)}
                // Available *while* paired, which is the whole point: re-pairing
                // used to mean removing the machine from the account and
                // registering it again, because nothing else could reach the
                // request dialog once a pairing existed.
                onRepair={() => onRequestAccess(server)}
                onForget={paired ? () => setPendingForget(server) : undefined}
                onMove={
                  serverId
                    ? (direction) =>
                        void machines.move(
                          ordered
                            .map((s) => deviceIdForPublicKey(s.publicKey))
                            .filter((id): id is string => id !== null),
                          serverId,
                          direction,
                        )
                    : undefined
                }
              />
            );
          })}
        </ul>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              It disappears from this list and any device trusted through it
              loses access. Nothing on the machine itself is changed — running{" "}
              <code className="font-mono">mtmux</code> there registers it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting} className="h-11">
              Keep it
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              disabled={deleting}
              className="h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Distinct from Remove, and the distinction is the feature: this drops
          the keys on *this* device, which is what "let me pair again" means. */}
      <AlertDialog
        open={pendingForget !== null}
        onOpenChange={(open) => !open && setPendingForget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Forget {pendingForget?.name} on this device?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This browser deletes its keys for that machine. The machine keeps
              running, stays on your account, and your other devices are
              untouched — you can pair with it again from here whenever you
              like.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmForget();
              }}
              className="h-11 bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Forget it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * Skeletons shaped like what is about to arrive.
 *
 * Two hardcoded rows meant a user with five machines watched the list jump on
 * every load. `knownMachines` is whatever the previous fetch left behind.
 */
function ServerSkeletons({ count }: { count: number }) {
  return (
    <div className="space-y-3" aria-hidden>
      {Array.from({ length: Math.max(1, Math.min(count || 2, 3)) }, (_, i) => (
        <div key={i} className="rounded-lg border border-border p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="flex-1 space-y-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-56" />
            </div>
            <Skeleton className="h-11 w-full sm:w-28" />
          </div>
        </div>
      ))}
      <span className="sr-only" role="status">
        Loading your machines
      </span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-center sm:p-10">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Server className="h-6 w-6 text-muted-foreground" aria-hidden />
      </div>
      <h2 className="mt-4 text-base font-medium text-foreground">
        No machines yet
      </h2>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
        Install mtmux on a machine you want to reach, then run these two
        commands on it. It shows up here within a few seconds.
      </p>
      <InstallMachine withLogin className="mx-auto mt-6 max-w-sm" />
    </div>
  );
}

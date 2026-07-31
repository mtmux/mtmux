"use client";

import { useState } from "react";
import Link from "next/link";
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
import { AlertCircle, RefreshCw, Server, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { ApiError, apiFetch } from "@/lib/auth-client";
import type { ServersState } from "@/hooks/use-servers";
import { connectToServer } from "./connect-to-server";
import { ServerRow, type RegisteredServer } from "./server-row";
import { InstallMachine } from "@/components/entry/install-machine";

/**
 * The management section: rename, remove, share, install.
 *
 * No longer the only route to pairing, and no longer a second copy of the
 * machine list — the cards above own that, and this owns what you do to a
 * machine rather than with it. Its state comes from `useServers`, so there is
 * one `GET /v1/servers`, one normalizer and one clock tick for the page.
 */
export function ServerList({
  servers: state,
  onRequestAccess,
}: {
  servers: ServersState;
  /** Owned by the page — one dialog, because the broker allows one request. */
  onRequestAccess: (server: RegisteredServer) => void;
}) {
  const { servers, phase, message, pairedKeys, now, refresh, patch, remove } =
    state;
  const [connecting, setConnecting] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<RegisteredServer | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [upgrade, setUpgrade] = useState<string | null>(null);

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

  async function handleRename(
    server: RegisteredServer,
    name: string,
  ): Promise<boolean> {
    try {
      await apiFetch(`/v1/servers/${encodeURIComponent(server.id)}`, {
        method: "PATCH",
        json: { name },
      });
      patch(server.id, { name });
      toast.success(`Renamed to ${name}`);
      return true;
    } catch (error) {
      // 402 is not an error worth a red toast — it is the product telling
      // someone about a plan, and it deserves an offer rather than a failure.
      if (error instanceof ApiError && error.status === 402) {
        setUpgrade(error.message);
        return false;
      }
      toast.error(
        error instanceof ApiError
          ? error.message
          : "Could not rename that machine.",
      );
      return false;
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
          {servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              now={now}
              connecting={connecting === server.id}
              paired={pairedKeys.has(server.publicKey)}
              notice={notices[server.id] || null}
              onConnect={() => void handleConnect(server)}
              onRename={(name) => handleRename(server, name)}
              onRemove={() => setPendingDelete(server)}
            />
          ))}
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

      <AlertDialog
        open={upgrade !== null}
        onOpenChange={(open) => !open && setUpgrade(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
              <Sparkles className="h-5 w-5 text-primary" aria-hidden />
            </div>
            <AlertDialogTitle>
              Naming machines is a Pro feature
            </AlertDialogTitle>
            <AlertDialogDescription>
              {upgrade ??
                "On the free plan a machine keeps its hostname. Pro lets you call it whatever you like."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11">Not now</AlertDialogCancel>
            <AlertDialogAction asChild className="h-11">
              <Link href="/settings/billing">See Pro</Link>
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

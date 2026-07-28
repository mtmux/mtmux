"use client";

import { useCallback, useEffect, useState } from "react";
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
import { connectToServer, pairedServerKeys } from "./connect-to-server";
import { CopyCommand } from "./copy-command";
import { toEpochMs } from "./format";
import { ServerRow, type RegisteredServer } from "./server-row";

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; servers: RegisteredServer[] };

type RawServer = Partial<Record<keyof RegisteredServer, unknown>>;

/** The broker sends `lastSeenAt` as epoch ms; tolerate an ISO string too. */
function normalize(raw: RawServer): RegisteredServer {
  return {
    id: String(raw.id ?? ""),
    name:
      typeof raw.name === "string" && raw.name ? raw.name : "Unnamed machine",
    slug: typeof raw.slug === "string" ? raw.slug : "",
    publicKey: typeof raw.publicKey === "string" ? raw.publicKey : "",
    online: raw.online === true,
    lastSeenAt: toEpochMs(raw.lastSeenAt),
    platform: typeof raw.platform === "string" ? raw.platform : null,
    cliVersion: typeof raw.cliVersion === "string" ? raw.cliVersion : null,
  };
}

export function ServerList() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [now, setNow] = useState(() => Date.now());
  const [connecting, setConnecting] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<RegisteredServer | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [upgrade, setUpgrade] = useState<string | null>(null);
  /**
   * Machines this browser holds keys for.
   *
   * Read from IndexedDB, never from the broker — which browsers can open which
   * machines is precisely the thing we do not want the server to know.
   */
  const [pairedKeys, setPairedKeys] = useState<Set<string>>(() => new Set());

  const refresh = useCallback(async () => {
    setLoad({ state: "loading" });
    try {
      const body = await apiFetch<{ servers?: RawServer[] }>("/v1/servers");
      const servers = Array.isArray(body.servers)
        ? body.servers.map(normalize)
        : [];
      setLoad({ state: "ready", servers });
    } catch (error) {
      setLoad({
        state: "error",
        message:
          error instanceof ApiError
            ? error.message
            : "Could not load your machines.",
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (load.state !== "ready") return;
    let cancelled = false;
    void pairedServerKeys(load.servers.map((s) => s.publicKey)).then((keys) => {
      if (!cancelled) setPairedKeys(keys);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  // Keeps "4m ago" honest without polling the broker.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  async function handleConnect(server: RegisteredServer) {
    setConnecting(server.id);
    setNotices((prev) => ({ ...prev, [server.id]: "" }));
    try {
      const result = await connectToServer(server.publicKey);
      if (result.ok) {
        window.location.assign(result.href);
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
      setLoad((prev) =>
        prev.state === "ready"
          ? {
              ...prev,
              servers: prev.servers.map((s) =>
                s.id === server.id ? { ...s, name } : s,
              ),
            }
          : prev,
      );
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
      setLoad((prev) =>
        prev.state === "ready"
          ? { ...prev, servers: prev.servers.filter((s) => s.id !== target.id) }
          : prev,
      );
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
      {load.state === "loading" && <ServerSkeletons />}

      {load.state === "error" && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-center">
          <AlertCircle
            className="mx-auto h-6 w-6 text-destructive"
            aria-hidden
          />
          <h2 className="mt-3 text-base font-medium text-foreground">
            Couldn&apos;t load your machines
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{load.message}</p>
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

      {load.state === "ready" && load.servers.length === 0 && <EmptyState />}

      {load.state === "ready" && load.servers.length > 0 && (
        <ul className="space-y-3">
          {load.servers.map((server) => (
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

function ServerSkeletons() {
  return (
    <div className="space-y-3" aria-hidden>
      {[0, 1].map((i) => (
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
      <div className="mx-auto mt-6 max-w-sm space-y-3 text-left">
        <CopyCommand command="npm install -g mtmux" />
        <CopyCommand command="mtmux login" />
        <CopyCommand command="mtmux" />
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@repo/ui/components/ui/badge";
import { Button } from "@repo/ui/components/ui/button";
import { Skeleton } from "@repo/ui/components/ui/skeleton";
import { cn } from "@repo/ui/lib/utils";
import {
  AlertCircle,
  Lock,
  RefreshCw,
  Share2,
  TerminalSquare,
} from "lucide-react";
import { toast } from "sonner";
import { apiFetch, hostedApiUrl, isHostedBuild } from "@/lib/auth-client";
import { getActive, getActiveServerId } from "@/lib/relay-registry";
import {
  browserProbe,
  collectTargets,
  indexedDbCache,
  runCensus,
  type BrokerServer,
  type CensusRow,
  type CensusSnapshot,
  type CensusTarget,
} from "@/lib/session-census";
import { activateDescriptor } from "@/lib/session-store";
import { isSessionLocked, setSessionLock } from "@/lib/lock-store";
import { isEnrolled, isUnlocked } from "@/lib/unlocked";
import { RequireUnlockDialog } from "@/components/lock/require-unlock-dialog";
import { LAST_SESSION_KEY, writeStored } from "@/lib/storage-keys";
import {
  filesDisabled,
  isReadOnly,
  useConnectionStore,
} from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";
import { deviceIdForPublicKey } from "./connect-to-server";
import { timeAgo } from "./format";
import { ShareDialog } from "./share-dialog";

/**
 * Everything running on every machine this browser can open.
 *
 * The list is assembled here, in the browser, one short-lived connection per
 * machine — never from a broker endpoint. See the header of
 * `lib/session-census.ts` for why that is not negotiable.
 *
 * Two rules the UI has to keep: a machine that cannot be reached shows its last
 * known sessions, dated and greyed, with a Retry — never a spinner that never
 * ends; and a machine this browser has never paired with is simply not here,
 * because it has no sessions we could honestly show. `ServerList` is where that
 * machine gets its "pair this device" invitation.
 */

type RawServer = { publicKey?: unknown; name?: unknown; online?: unknown };

/** The account's view of the same machines, for names and an online hint. */
async function fetchServers(): Promise<BrokerServer[] | null> {
  if (!isHostedBuild) return null;
  const body = await apiFetch<{ servers?: RawServer[] }>("/v1/servers");
  const servers = Array.isArray(body.servers) ? body.servers : [];
  return servers
    .map((raw) => {
      const publicKey = typeof raw.publicKey === "string" ? raw.publicKey : "";
      const serverId = publicKey ? deviceIdForPublicKey(publicKey) : null;
      return serverId
        ? {
            serverId,
            name: typeof raw.name === "string" ? raw.name : "",
            online: raw.online === true,
          }
        : null;
    })
    .filter((s): s is BrokerServer => s !== null);
}

/**
 * The machine the terminal already has open, if this tab has one.
 *
 * Probing it would open a second socket to a machine we are mid-conversation
 * with, and the answer would be staler than the one already in the store.
 */
function liveSnapshots(): Map<string, CensusSnapshot> {
  const serverId = getActiveServerId();
  const client = getActive();
  if (!serverId || client?.status !== "connected") return new Map();
  return new Map([
    [
      serverId,
      {
        sessions: useSessionStore.getState().sessions,
        capabilities: useConnectionStore.getState().capabilities,
        observedAt: Date.now(),
      },
    ],
  ]);
}

function seedRow(target: CensusTarget): CensusRow {
  return {
    ...target,
    sessions: [],
    capabilities: null,
    observedAt: null,
    source: "cache",
    pending: true,
    error: null,
  };
}

export function AllSessions() {
  const [rows, setRows] = useState<CensusRow[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [now, setNow] = useState(() => Date.now());
  const [opening, setOpening] = useState<string | null>(null);
  const [share, setShare] = useState<{
    serverName: string;
    session: string;
  } | null>(null);
  /** Set when opening a session the user asked to be re-prompted for. */
  const [challenge, setChallenge] = useState<{
    row: CensusRow;
    session: string;
  } | null>(null);
  /** Bumped after a toggle so the lock icons repaint from the sealed record. */
  const [lockTick, setLockTick] = useState(0);
  /** Only the newest run may paint; a Refresh mid-fan-out must not interleave. */
  const runId = useRef(0);

  const refresh = useCallback(async (force = false) => {
    const id = ++runId.current;
    setPhase("loading");
    try {
      const targets = await collectTargets({ fetchServers });
      if (id !== runId.current) return;

      const byId = new Map(targets.map((t) => [t.serverId, seedRow(t)]));
      const paint = () => {
        if (id === runId.current) setRows([...byId.values()]);
      };
      paint();

      await runCensus({
        targets,
        probe: browserProbe({ apiBase: hostedApiUrl }),
        cache: indexedDbCache,
        live: liveSnapshots(),
        force,
        onUpdate: (row) => {
          byId.set(row.serverId, row);
          paint();
        },
      });
      if (id === runId.current) setPhase("ready");
    } catch {
      if (id === runId.current) setPhase("error");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keeps "3h ago" honest without re-probing anything.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  async function handleOpen(row: CensusRow, session: string) {
    // "Require unlock to open" re-asks for the PIN even though the device is
    // already open — the gap it covers is handing someone an unlocked phone.
    if (isSessionLocked(row.serverId, session)) {
      setChallenge({ row, session });
      return;
    }
    await openNow(row, session);
  }

  async function openNow(row: CensusRow, session: string) {
    const key = `${row.serverId}:${session}`;
    setOpening(key);
    const paired = await activateDescriptor(row.serverId);
    if (!paired) {
      setOpening(null);
      toast.info("Not available yet", {
        description:
          "This browser no longer holds keys for that machine. Run `mtmux` " +
          "on it and scan the code once.",
      });
      return;
    }
    // The terminal layout restores this on mount, so the session you asked for
    // is the one that opens.
    writeStored(LAST_SESSION_KEY, session);
    window.location.assign("/");
  }

  async function toggleSessionLock(row: CensusRow, session: string) {
    if (!isEnrolled() || !isUnlocked()) {
      toast.info("Set a device PIN first", {
        description:
          "The flag is stored inside the encrypted record, so there has to be " +
          "a key to seal it under.",
      });
      return;
    }
    try {
      const next = !isSessionLocked(row.serverId, session);
      await setSessionLock(row.serverId, session, next);
      setLockTick((n) => n + 1);
      toast.success(
        next
          ? `You will be asked for your PIN before opening ${session}.`
          : `${session} opens without a prompt again.`,
      );
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const total = rows.reduce((sum, row) => sum + row.sessions.length, 0);
  const busy = phase === "loading" || rows.some((row) => row.pending);

  if (phase === "loading" && rows.length === 0) return <SessionSkeletons />;

  if (phase === "error") {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-center">
        <AlertCircle className="mx-auto h-6 w-6 text-destructive" aria-hidden />
        <h2 className="mt-3 text-base font-medium text-foreground">
          Couldn&apos;t gather your sessions
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Nothing was lost — this list is built from this device, so trying
          again costs only a moment.
        </p>
        <Button
          variant="outline"
          className="mt-4 h-11"
          onClick={() => void refresh(true)}
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
          Try again
        </Button>
      </div>
    );
  }

  if (rows.length === 0) return <EmptyState />;

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground" role="status">
          {busy
            ? "Checking your machines…"
            : `${total} session${total === 1 ? "" : "s"} across ${rows.length} machine${
                rows.length === 1 ? "" : "s"
              }`}
        </p>
        <Button
          variant="ghost"
          className="h-11"
          onClick={() => void refresh(true)}
          disabled={busy}
        >
          <RefreshCw
            className={cn("h-4 w-4", busy && "animate-spin")}
            aria-hidden
          />
          Refresh
        </Button>
      </div>

      <ul className="space-y-3">
        {rows.map((row) => (
          <MachineGroup
            key={row.serverId}
            row={row}
            now={now}
            opening={opening}
            onOpen={handleOpen}
            onShare={(session) => setShare({ serverName: row.name, session })}
            onToggleLock={(session) => void toggleSessionLock(row, session)}
            lockTick={lockTick}
            onRetry={() => void refresh(true)}
          />
        ))}
      </ul>

      <ShareDialog
        open={share !== null}
        onOpenChange={(open) => {
          if (!open) setShare(null);
        }}
        serverName={share?.serverName ?? ""}
        session={share?.session ?? ""}
      />

      <RequireUnlockDialog
        open={challenge !== null}
        onOpenChange={(open) => {
          if (!open) setChallenge(null);
        }}
        sessionName={challenge?.session ?? ""}
        onUnlocked={() => {
          const pending = challenge;
          setChallenge(null);
          if (pending) void openNow(pending.row, pending.session);
        }}
      />
    </>
  );
}

function MachineGroup({
  row,
  now,
  opening,
  onOpen,
  onShare,
  onToggleLock,
  lockTick,
  onRetry,
}: {
  row: CensusRow;
  now: number;
  opening: string | null;
  onOpen: (row: CensusRow, session: string) => void;
  onShare: (session: string) => void;
  onToggleLock: (session: string) => void;
  /** Changes when a lock is toggled, so the icons re-read the sealed record. */
  lockTick: number;
  onRetry: () => void;
}) {
  const stale = row.source === "cache" && !row.pending;
  const reachable = !stale;

  return (
    <li className="rounded-lg border border-border bg-card text-card-foreground">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            reachable ? "bg-success" : "bg-muted-foreground/40",
          )}
          aria-hidden
        />
        <h3 className="min-w-0 truncate text-sm font-medium text-foreground">
          {row.name}
        </h3>

        {isReadOnly(row.capabilities) && (
          <Badge variant="outline" className="shrink-0">
            Read-only
          </Badge>
        )}
        {filesDisabled(row.capabilities) && (
          <Badge variant="outline" className="shrink-0">
            Files off
          </Badge>
        )}

        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {row.pending
            ? "checking…"
            : stale
              ? `last seen ${timeAgo(row.observedAt, now)}`
              : "just now"}
        </span>

        {stale && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0"
            onClick={onRetry}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Retry
          </Button>
        )}
      </div>

      {row.error && (
        <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          {row.error}
        </p>
      )}

      {row.sessions.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          {row.pending
            ? "Looking for sessions…"
            : stale
              ? "No sessions known from the last time this machine answered."
              : "Nothing running here yet."}
        </p>
      ) : (
        <ul className={cn("divide-y divide-border", stale && "opacity-60")}>
          {row.sessions.map((session) => {
            // `lockTick` is read so a toggle repaints; the value itself is a
            // module-level lookup, not React state.
            void lockTick;
            const locked = isSessionLocked(row.serverId, session.name);
            return (
              <li
                key={session.id}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3"
              >
                <TerminalSquare
                  className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm text-foreground">
                    {session.name}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {session.windows} window{session.windows === 1 ? "" : "s"}
                    {session.attached && (
                      <>
                        <span aria-hidden> · </span>attached
                      </>
                    )}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    className="h-11 px-5"
                    disabled={opening !== null}
                    onClick={() => onOpen(row, session.name)}
                  >
                    {opening === `${row.serverId}:${session.name}`
                      ? "Opening…"
                      : "Open"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11"
                    onClick={() => onShare(session.name)}
                    aria-label={`Share ${session.name} on ${row.name}`}
                  >
                    <Share2 className="h-4 w-4" aria-hidden />
                  </Button>
                  {/*
                  The flag lives inside the sealed record, so a locked attacker
                  cannot even enumerate which sessions are marked. The label is
                  deliberately "require unlock to open" and never "protected":
                  anyone with a console on an unlocked device can call
                  `getRelayClient().send({ type: "session:attach", … })`.
                */}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11"
                    onClick={() => onToggleLock(session.name)}
                    aria-pressed={locked}
                    title={
                      locked
                        ? "Asks for your PIN before opening"
                        : "Require unlock to open"
                    }
                    aria-label={`Require unlock to open ${session.name}`}
                  >
                    <Lock
                      className={cn(
                        "h-4 w-4",
                        locked ? "text-primary" : "text-muted-foreground",
                      )}
                      aria-hidden
                    />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function SessionSkeletons() {
  return (
    <div className="space-y-3" aria-hidden>
      {[0, 1].map((i) => (
        <div key={i} className="rounded-lg border border-border">
          <div className="border-b border-border px-4 py-3">
            <Skeleton className="h-4 w-40" />
          </div>
          <div className="space-y-3 p-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-24" />
          </div>
        </div>
      ))}
      <span className="sr-only" role="status">
        Gathering sessions from your machines
      </span>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <TerminalSquare className="h-6 w-6 text-muted-foreground" aria-hidden />
      </div>
      <h2 className="mt-4 text-base font-medium text-foreground">
        No sessions to show yet
      </h2>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
        Sessions are read from this device, not from your account — so a machine
        appears here once this browser has paired with it. Pair one below and it
        shows up straight away.
      </p>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@repo/ui/components/ui/badge";
import { Button } from "@repo/ui/components/ui/button";
import { Skeleton } from "@repo/ui/components/ui/skeleton";
import { cn } from "@repo/ui/lib/utils";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Loader2,
  Lock,
  MoreVertical,
  Pencil,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Share2,
  TerminalSquare,
  Unlink,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@repo/ui/components/ui/dropdown-menu";
import { toast } from "sonner";
import { hostedApiUrl, isHostedBuild } from "@/lib/auth-client";
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
import {
  LAST_SESSION_KEY,
  OPEN_NEW_SESSION_KEY,
  writeStored,
} from "@/lib/storage-keys";
import {
  filesDisabled,
  isReadOnly,
  useConnectionStore,
} from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";
import { deviceIdForPublicKey } from "./connect-to-server";
import { timeAgo } from "./format";
import { ShareDialog } from "./share-dialog";
import type { RegisteredServer } from "./server-row";
import { MIN_PAIR_CLI_VERSION, semverGte } from "@/lib/semver-gte";
import { CopyCommand } from "./copy-command";
import { Input } from "@repo/ui/components/ui/input";
import type { MachinePrefsState } from "@/hooks/use-machine-prefs";
import type { RenameTarget } from "./dashboard-body";

/**
 * Everything running on every machine this browser can open.
 *
 * The list is assembled here, in the browser, one short-lived connection per
 * machine — never from a broker endpoint. See the header of
 * `lib/session-census.ts` for why that is not negotiable.
 *
 * Two rules the UI has to keep.
 *
 * A machine that cannot be reached shows its last known sessions, dated and
 * greyed, with a Retry — never a spinner that never ends.
 *
 * And a machine this browser has never paired with **is listed, but is never
 * probed**. It has no sessions we could honestly show, so its row is an
 * invitation to pair rather than a session list. Leaving it out entirely — as
 * this used to, and as the previous version of this comment described — meant a
 * user with ten registered machines and a fresh phone opened the dashboard to
 * an empty list with nothing on it to act on.
 */

/**
 * The account's view of the same machines, for names and an online hint.
 *
 * Built from what the page already fetched rather than from a second `GET
 * /v1/servers`. Two requests for one answer was the small problem; two
 * different normalizers for it was the real one, because a machine could be
 * online in this list and offline in the one below it.
 */
function toBrokerServers(servers: RegisteredServer[]): BrokerServer[] | null {
  if (!isHostedBuild) return null;
  return servers
    .map((raw) => {
      const serverId = raw.publicKey
        ? deviceIdForPublicKey(raw.publicKey)
        : null;
      return serverId ? { serverId, name: raw.name, online: raw.online } : null;
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

export type AllSessionsProps = {
  /** Fetched once by the page — see `hooks/use-servers.ts`. */
  servers: RegisteredServer[];
  /** Whether that fetch has landed, so skeletons can be the right shape. */
  serversReady: boolean;
  /**
   * Open the access-request dialog for a machine.
   *
   * Owned by the page rather than by the card. The broker allows one live
   * request per device, so N mounted dialogs are N ways to race into a 409 —
   * which is exactly why the unpaired card used to point at an anchor instead
   * of just doing the thing.
   */
  onRequestAccess: (server: RegisteredServer) => void;
  /** Device-local names, ordering and collapse state. See `use-machine-prefs.ts`. */
  machines: MachinePrefsState;
  /** Owned by the page, because there are two names a machine can have. */
  onRename: (target: RenameTarget, name: string) => Promise<boolean>;
};

export function AllSessions({
  servers,
  serversReady,
  onRequestAccess,
  machines,
  onRename,
}: AllSessionsProps) {
  const [rows, setRows] = useState<CensusRow[]>([]);
  /** Free-text filter over session and machine names. Only shown when it earns it. */
  const [filter, setFilter] = useState("");
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

  const serversRef = useRef(servers);
  serversRef.current = servers;

  const refresh = useCallback(async (force = false) => {
    const id = ++runId.current;
    setPhase("loading");
    try {
      const targets = await collectTargets({
        fetchServers: async () => toBrokerServers(serversRef.current),
      });
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

  // Re-run when the machine list arrives or changes, since the census is built
  // from it. `servers` is a fresh array each fetch, so the length+ids key keeps
  // this from re-probing on every render.
  const serverKey = servers.map((s) => `${s.id}:${s.online}`).join(",");
  useEffect(() => {
    if (!serversReady) return;
    void refresh();
  }, [refresh, serversReady, serverKey]);

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
    /*
     * A full document load, deliberately, and this is the one place it is.
     *
     * `router.push` would keep the running client tree, and with it three
     * Zustand stores holding the *previous* machine's state: `session-store`'s
     * session list, `pane-store`'s panes, `connection-store`'s capabilities.
     * None has a reset path, and all three are repopulated only once the new
     * relay answers — so the terminal would paint another machine's session
     * names for a beat before correcting itself. On a page whose entire premise
     * is that session names never leave the device that owns them, a flash of
     * the wrong machine's names is the wrong trade for a smoother transition.
     *
     * Making this a soft navigation means giving those stores a reset, which is
     * a change to the terminal's lifecycle rather than to this page.
     */
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

  /**
   * A filter, once there is enough on screen to need one.
   *
   * Below about eight sessions the box is a control that costs a row and earns
   * nothing; above it, scrolling a phone to find `deploy-prod` among twenty is
   * the actual task.
   */
  const showFilter = total > 8;
  const needle = filter.trim().toLowerCase();
  const visible = !needle
    ? rows
    : rows
        .map((row) => {
          // A machine matching by name keeps all of its sessions, so filtering
          // by machine is a way to see everything on one box.
          if (row.name.toLowerCase().includes(needle)) return row;
          const sessions = row.sessions.filter((session) =>
            session.name.toLowerCase().includes(needle),
          );
          return sessions.length > 0 ? { ...row, sessions } : null;
        })
        .filter((row): row is CensusRow => row !== null);

  const serverFor = (serverId: string): RegisteredServer | null =>
    servers.find((s) => deviceIdForPublicKey(s.publicKey) === serverId) ?? null;

  /**
   * The user's order, applied here as well as in the management list.
   *
   * Two lists of the same machines in two different orders is worse than either
   * order on its own, so both sort through `machines.sortIds`.
   */
  const byId = new Map(visible.map((row) => [row.serverId, row]));
  const ordered = machines
    .sortIds(visible.map((row) => row.serverId))
    .map((id) => byId.get(id)!)
    .filter(Boolean);
  const orderedIds = ordered.map((row) => row.serverId);
  const anyExpanded = ordered.some(
    (row) => !machines.isCollapsed(row.serverId),
  );

  /**
   * Start a session without opening a terminal first.
   *
   * A strange gap on a page whose entire job is sessions: the only way to make
   * one was to open an existing one and use the terminal's own UI, which is
   * impossible on a machine with none.
   */
  async function handleNewSession(row: CensusRow) {
    const paired = await activateDescriptor(row.serverId);
    if (!paired) {
      toast.info("Not available yet", {
        description:
          "This browser no longer holds keys for that machine. Run `mtmux` " +
          "on it and scan the code once.",
      });
      return;
    }
    // Creating one needs a live relay connection, which this page has for no
    // machine in particular. So the instruction travels instead: the terminal
    // reads this flag once on arrival and opens the create dialog.
    window.sessionStorage.setItem(OPEN_NEW_SESSION_KEY, "1");
    window.location.assign("/");
  }

  if (phase === "loading" && rows.length === 0) {
    // Shaped like what is arriving, so the first paint does not jump.
    return <SessionSkeletons count={servers.length} />;
  }

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
        {/*
          Not a live region. One `role="status"` alternating between "Checking…"
          and a count re-announces the whole count on every 30-second tick, so a
          screen reader user hears "4 sessions across 2 machines" twice a minute
          forever. The transition is announced separately, once.
        */}
        <p className="text-sm text-muted-foreground">
          {busy
            ? "Checking your machines…"
            : `${total} session${total === 1 ? "" : "s"} across ${rows.length} machine${
                rows.length === 1 ? "" : "s"
              }`}
        </p>
        <span className="sr-only" role="status">
          {busy ? "Checking your machines" : ""}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {/* Only earns its place once there is more than one machine to fold. */}
          {/* Labels only where there is room for them. On a phone this bar
              carries a sentence and two controls, and the sentence is the part
              worth reading. */}
          {ordered.length > 1 && (
            <Button
              variant="ghost"
              className="h-11 px-2 sm:px-3"
              onClick={() => void machines.collapseAll(orderedIds, anyExpanded)}
              aria-label={anyExpanded ? "Collapse all" : "Expand all"}
            >
              {anyExpanded ? (
                <ChevronsDownUp className="h-4 w-4" aria-hidden />
              ) : (
                <ChevronsUpDown className="h-4 w-4" aria-hidden />
              )}
              <span className="hidden sm:inline">
                {anyExpanded ? "Collapse all" : "Expand all"}
              </span>
            </Button>
          )}
          <Button
            variant="ghost"
            className="h-11 px-2 sm:px-3"
            onClick={() => void refresh(true)}
            disabled={busy}
            aria-label="Refresh"
          >
            <RefreshCw
              className={cn("h-4 w-4", busy && "animate-spin")}
              aria-hidden
            />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      {showFilter && (
        <div className="relative mb-3">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter sessions"
            aria-label="Filter sessions by name or machine"
            className="h-11 pl-9"
          />
        </div>
      )}

      <ul className="space-y-3" aria-label="Machines and their sessions">
        {ordered.length === 0 && (
          <li className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            Nothing matches &ldquo;{filter}&rdquo;.
          </li>
        )}
        {ordered.map((row, index) => {
          const localName = machines.localName(row.serverId);
          const server = serverFor(row.serverId);
          const name = localName || row.name;
          return (
            <MachineGroup
              key={row.serverId}
              row={row}
              name={name}
              localName={localName}
              now={now}
              opening={opening}
              onOpen={handleOpen}
              onShare={(session) => setShare({ serverName: name, session })}
              onToggleLock={(session) => void toggleSessionLock(row, session)}
              lockTick={lockTick}
              onRetry={() => void refresh(true)}
              onRequestAccess={onRequestAccess}
              server={server}
              onNewSession={() => void handleNewSession(row)}
              collapsed={machines.isCollapsed(row.serverId)}
              onToggleCollapsed={() =>
                void machines.setCollapsed(
                  row.serverId,
                  !machines.isCollapsed(row.serverId),
                )
              }
              first={index === 0}
              last={index === ordered.length - 1}
              onMove={(direction) =>
                void machines.move(orderedIds, row.serverId, direction)
              }
              onRename={(next) =>
                onRename(
                  {
                    accountId: server?.id ?? null,
                    serverId: row.serverId,
                    current: name,
                  },
                  next,
                )
              }
              onForget={
                row.paired === false
                  ? undefined
                  : async () => {
                      await machines.forget(row.serverId);
                      toast.success(`Forgot ${name} on this device`);
                      await refresh(true);
                    }
              }
            />
          );
        })}
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
  name,
  localName,
  now,
  opening,
  onOpen,
  onShare,
  onToggleLock,
  lockTick,
  onRetry,
  onRequestAccess,
  server,
  onNewSession,
  collapsed,
  onToggleCollapsed,
  first,
  last,
  onMove,
  onRename,
  onForget,
}: {
  row: CensusRow;
  /** The resolved display name — this device's, else the account's, else the host's. */
  name: string;
  /** Set when the name above came from a rename made on this device. */
  localName: string | null;
  now: number;
  opening: string | null;
  onOpen: (row: CensusRow, session: string) => void;
  onShare: (session: string) => void;
  onToggleLock: (session: string) => void;
  /** Changes when a lock is toggled, so the icons re-read the sealed record. */
  lockTick: number;
  onRetry: () => void;
  onRequestAccess: (server: RegisteredServer) => void;
  /** The account's record for this machine, when there is one. */
  server: RegisteredServer | null;
  onNewSession: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  first: boolean;
  last: boolean;
  onMove: (direction: -1 | 1) => void;
  onRename: (name: string) => Promise<boolean>;
  /** Absent for a machine this browser holds no keys for. */
  onForget?: () => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(name);
      nameInputRef.current?.focus();
    }
  }, [editing, name]);

  async function saveName() {
    setSaving(true);
    const ok = await onRename(draft);
    setSaving(false);
    if (ok) setEditing(false);
  }

  /**
   * A machine on the account that this browser holds no keys for.
   *
   * It needs its own branch rather than falling through to the stale one:
   * unprobed and unreachable look identical in a `CensusRow` (both are
   * `source: "cache"`, not pending, with no sessions), but "last seen never,
   * press Retry" is a lie about a machine that is very likely online and simply
   * has not met this device.
   */
  const unpaired = row.paired === false;
  const stale = !unpaired && row.source === "cache" && !row.pending;
  const reachable = !stale && !unpaired;
  /**
   * Whether to tell the user to upgrade.
   *
   * `semverGte` returns null for anything it cannot parse, and `=== false` is
   * the point: `cliVersion` is free text the broker stores on a machine's
   * behalf, so an unrecognised value must read as "unknown" and show nothing.
   * Telling someone to upgrade a CLI that is already current is worse than
   * saying nothing, because the upgrade changes nothing they can see.
   */
  const needsUpgrade =
    semverGte(server?.cliVersion ?? null, MIN_PAIR_CLI_VERSION) === false;

  if (unpaired) {
    return (
      <li className="rounded-lg border border-dashed border-border bg-card text-card-foreground">
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <span
            className={cn(
              "h-2 w-2 shrink-0 rounded-full",
              row.online ? "bg-success" : "bg-muted-foreground/40",
            )}
            aria-hidden
          />
          <h3 className="min-w-0 truncate text-sm font-medium text-foreground">
            {name}
          </h3>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {row.online ? "online" : "offline"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            This browser has no keys for {name}, so it cannot see what is
            running there yet.
          </p>
          {/*
            Does the thing, rather than pointing at a second card for the same
            machine that has a second button that does the thing. That anchor
            cost two taps and a scroll for one action, and moved no focus.
          */}
          <Button
            size="sm"
            className="h-9 shrink-0"
            disabled={!server || !row.online}
            onClick={() => server && onRequestAccess(server)}
          >
            Pair this device
          </Button>
        </div>
        {!row.online && (
          <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
            It has to be online to be asked — the request travels over its own
            tunnel.
          </p>
        )}
        {needsUpgrade && (
          <div className="space-y-2 border-t border-border px-4 py-3">
            <p className="text-xs text-muted-foreground">
              {/* The direct dependency between this section and the rest of the
                  branch: `mtmux approve` does not exist before 0.6.0, and
                  `mtmux pair` below it cannot read the code this app now shows. */}
              This machine is on mtmux v{server?.cliVersion}. Update it to pair
              from here.
            </p>
            <CopyCommand command="mtmux upgrade" />
          </div>
        )}
      </li>
    );
  }

  return (
    <li className="rounded-lg border border-border bg-card text-card-foreground">
      {editing ? (
        <form
          className="flex items-center gap-2 border-b border-border p-2 sm:p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void saveName();
          }}
        >
          <Input
            ref={nameInputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
            }}
            maxLength={64}
            className="h-11"
            disabled={saving}
            aria-label={`Name for ${name}`}
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
            aria-label="Cancel rename"
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </form>
      ) : (
        /*
         * Two lines, and on a phone that is the whole point.
         *
         * This was one wrapping row carrying the name, the badges, the session
         * count, the freshness, Retry, New session and the menu. At 390px the
         * name — the only thing that identifies which machine you are looking
         * at — was squeezed between a status dot and six controls until it
         * truncated to nothing. Everything except the name is metadata or an
         * action, so it goes on the second line and the name gets a row of its
         * own at every width.
         */
        <div className="border-b border-border">
          <div className="flex items-center gap-1 px-1 py-1 sm:px-2">
            {/* The name is the disclosure control. A machine with fourteen
                sessions used to be fourteen rows you had to scroll past to
                reach the next machine, with nothing to fold it away. */}
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-expanded={!collapsed}
              aria-controls={`sessions-${row.serverId}`}
              className={cn(
                "flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left",
                "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
            >
              <ChevronDown
                className={cn(
                  "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                  collapsed && "-rotate-90",
                )}
                aria-hidden
              />
              <span
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  reachable ? "bg-success" : "bg-muted-foreground/40",
                )}
                aria-hidden
              />
              <h3 className="min-w-0 truncate text-sm font-medium text-foreground">
                {name}
              </h3>
            </button>

            {/* Creating a session used to require opening one first, which is
                impossible on a machine that has none. Icon-only on a phone:
                the label is what pushed the name off the screen. */}
            {reachable && (
              <Button
                variant="ghost"
                size="sm"
                className="h-11 shrink-0 px-2"
                onClick={onNewSession}
                aria-label={`New session on ${name}`}
              >
                <Plus className="h-4 w-4" aria-hidden />
                <span className="hidden sm:inline">New session</span>
              </Button>
            )}

            {/* Everything you can do *to* a machine, on the card you are
                already looking at. All of this used to live one collapsed
                section further down the page, on a second card for the same
                machine. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-11 w-11 shrink-0"
                  aria-label={`More actions for ${name}`}
                >
                  <MoreVertical className="h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onSelect={() => setEditing(true)}>
                  <Pencil className="h-4 w-4" aria-hidden />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onToggleCollapsed}>
                  <ChevronDown className="h-4 w-4" aria-hidden />
                  {collapsed ? "Expand" : "Collapse"}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={first} onSelect={() => onMove(-1)}>
                  <ArrowUp className="h-4 w-4" aria-hidden />
                  Move up
                </DropdownMenuItem>
                <DropdownMenuItem disabled={last} onSelect={() => onMove(1)}>
                  <ArrowDown className="h-4 w-4" aria-hidden />
                  Move down
                </DropdownMenuItem>
                {server && (
                  <>
                    <DropdownMenuSeparator />
                    {/* Reachable while paired, which is the change: re-pairing used
                    to require removing the machine from the account first. */}
                    <DropdownMenuItem
                      disabled={!server.online}
                      onSelect={() => onRequestAccess(server)}
                    >
                      <QrCode className="h-4 w-4" aria-hidden />
                      Pair this device again
                    </DropdownMenuItem>
                  </>
                )}
                {onForget && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => void onForget()}>
                      <Unlink className="h-4 w-4" aria-hidden />
                      Forget on this device
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/*
            The second line: what the machine is doing, not what it is called.
            Indented to the name's text so the two lines read as one block, and
            small and muted so it never competes with the name above it.
          */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2 pl-9 text-xs text-muted-foreground sm:pl-11">
            <span>
              {row.sessions.length} session
              {row.sessions.length === 1 ? "" : "s"}
            </span>
            <span aria-hidden>·</span>
            <span>
              {row.pending
                ? "checking…"
                : stale
                  ? `last seen ${timeAgo(row.observedAt, now)}`
                  : "just now"}
            </span>

            {localName && localName !== server?.name && (
              <Badge variant="outline" className="shrink-0 font-normal">
                This device
              </Badge>
            )}
            {isReadOnly(row.capabilities) && (
              <Badge variant="outline" className="shrink-0 font-normal">
                Read-only
              </Badge>
            )}
            {filesDisabled(row.capabilities) && (
              <Badge variant="outline" className="shrink-0 font-normal">
                Files off
              </Badge>
            )}

            {/* Only ever shown on a stale group, so it does not need to hold a
                place in the layout the rest of the time. */}
            {stale && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto h-8 shrink-0 text-xs"
                onClick={onRetry}
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                Retry
              </Button>
            )}
          </div>
        </div>
      )}

      {row.error && !collapsed && (
        <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          {row.error}
        </p>
      )}

      {collapsed ? null : row.sessions.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          {row.pending
            ? "Looking for sessions…"
            : stale
              ? "No sessions known from the last time this machine answered."
              : "Nothing running here yet."}
        </p>
      ) : (
        // No `opacity-60` on a stale group. It landed under 4.5:1 against
        // `text-muted-foreground`, and `theme-contrast.test.ts` cannot catch it
        // because the tokens are fine and the opacity is not. Staleness is
        // carried by the dated label and the dot in the header instead.
        <ul
          id={`sessions-${row.serverId}`}
          className="divide-y divide-border"
          aria-label={`Sessions on ${name}`}
        >
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
                  {/* Scoped to this row. It used to be `opening !== null`,
                      which greyed out every Open button on the page while one
                      session was being opened — on a dashboard whose whole job
                      is a list of things to open. */}
                  <Button
                    className="h-11 px-5"
                    disabled={opening === `${row.serverId}:${session.name}`}
                    onClick={() => onOpen(row, session.name)}
                  >
                    {opening === `${row.serverId}:${session.name}` ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                        Opening…
                      </>
                    ) : (
                      "Open"
                    )}
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

function SessionSkeletons({ count }: { count: number }) {
  // Hardcoded 2 meant a user with five machines watched the list jump on every
  // load. Capped at 3 because past that the skeleton is noise, not a preview.
  return (
    <div className="space-y-3" aria-hidden>
      {Array.from({ length: Math.max(1, Math.min(count || 2, 3)) }, (_, i) => (
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
        appears here once this browser has paired with it. Run{" "}
        <code className="font-mono text-xs">mtmux</code> on a machine and scan
        the code once.
      </p>
    </div>
  );
}

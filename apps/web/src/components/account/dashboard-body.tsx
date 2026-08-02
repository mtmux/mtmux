"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, Sparkles } from "lucide-react";
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
import { cn } from "@repo/ui/lib/utils";
import { toast } from "sonner";
import { useServers } from "@/hooks/use-servers";
import { useMachinePrefs } from "@/hooks/use-machine-prefs";
import { AllSessions } from "./all-sessions";
import { RequestAccessDialog } from "./request-access-dialog";
import { ServerList } from "./server-list";
import type { RegisteredServer } from "./server-row";

/**
 * The dashboard, with one card per machine.
 *
 * It used to render every machine twice. `AllSessions` listed them all — paired
 * ones as session groups, unpaired ones as an invitation — and `ServerList`
 * then listed the same machines again under "Your machines", so two machines
 * produced four cards. Worse, the invitation's button was an `<a
 * href="#your-machines">`: it scrolled you to a *second* card for the same
 * machine, to press a *second* button that did the actual thing. Two taps and a
 * scroll for one action, and no focus moved with the anchor.
 *
 * So there is one list, and the card's shape follows the machine's state. "Your
 * machines" survives as a management section — rename, remove, share, install —
 * collapsed by default, and no longer the only route to pairing.
 *
 * The fetch, the request dialog, the rename and the device-local preferences
 * all live here rather than in either list. The dialog especially: the broker
 * allows one live request per device, so N mounted dialogs would be N ways to
 * race each other into a 409. Rename for a duller reason — it lived in
 * `ServerList`, which is why the session cards above it, the ones people
 * actually look at, had no way to rename anything.
 */

/**
 * What a rename is being applied to.
 *
 * Two ids because there are two names. `accountId` is the registry row, shared
 * by every device on the account and gated behind Pro. `serverId` is this
 * browser's own key for the machine, which is free, works offline, and is the
 * only name a self-hosted pairing has ever had. Either may be absent: a machine
 * on the account this device has never paired with has no `serverId`, and a
 * self-hosted pairing has no `accountId`.
 */
export type RenameTarget = {
  accountId: string | null;
  serverId: string | null;
  current: string;
};

export function DashboardBody() {
  const servers = useServers();
  const machines = useMachinePrefs();
  const [requesting, setRequesting] = useState<RegisteredServer | null>(null);
  const [managing, setManaging] = useState(false);
  /** Set when the account refused a rename because of the plan. */
  const [upgrade, setUpgrade] = useState<{
    message: string;
    target: RenameTarget;
    name: string;
  } | null>(null);

  /**
   * Rename, wherever the name actually lives.
   *
   * The account first when there is one, because that name is what every other
   * device sees. When the plan refuses it, the offer is no longer just "see
   * Pro" — this device can still name the machine for itself, which is free and
   * is what most people wanted from the button.
   */
  async function handleRename(
    target: RenameTarget,
    name: string,
  ): Promise<boolean> {
    const trimmed = name.trim();
    if (!trimmed || trimmed === target.current) return true;

    if (target.accountId) {
      const outcome = await servers.rename(target.accountId, trimmed);
      if (outcome.ok) {
        // A local rename would shadow the account name from here on, which is
        // not what someone who just renamed it on the account meant.
        if (target.serverId) await machines.clearName(target.serverId);
        toast.success(`Renamed to ${trimmed}`);
        return true;
      }
      if (outcome.kind === "upgrade") {
        setUpgrade({ message: outcome.message, target, name: trimmed });
        return false;
      }
      toast.error(outcome.message);
      return false;
    }

    if (!target.serverId) return false;
    await machines.rename(target.serverId, trimmed);
    toast.success(`Renamed to ${trimmed} on this device`);
    return true;
  }

  async function renameLocallyInstead() {
    if (!upgrade?.target.serverId) return;
    await machines.rename(upgrade.target.serverId, upgrade.name);
    setUpgrade(null);
    toast.success(`Renamed to ${upgrade.name} on this device`, {
      description: "Your other devices still see the old name.",
    });
  }

  return (
    <>
      <header className="mb-5">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Your sessions
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Gathered by this browser, straight from each machine. mtmux&apos;s
          servers never see a session name.
        </p>
      </header>

      <AllSessions
        servers={servers.servers}
        serversReady={servers.phase !== "loading"}
        onRequestAccess={setRequesting}
        machines={machines}
        onRename={handleRename}
      />

      <section className="mt-10">
        <button
          type="button"
          onClick={() => setManaging((open) => !open)}
          aria-expanded={managing}
          aria-controls="your-machines"
          className="flex w-full items-center gap-2 rounded-md py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              managing && "rotate-180",
            )}
            aria-hidden
          />
          <span className="text-lg font-semibold tracking-tight text-foreground">
            Manage machines
          </span>
          <span className="ml-auto text-sm text-muted-foreground">
            {servers.servers.length || ""}
          </span>
        </button>
        <p className="mb-4 ml-6 text-sm text-muted-foreground">
          Rename, reorder, re-pair, share or remove. Pairing lives in the list
          above.
        </p>

        <div id="your-machines" hidden={!managing}>
          {managing && (
            <ServerList
              servers={servers}
              machines={machines}
              onRequestAccess={setRequesting}
              onRename={handleRename}
            />
          )}
        </div>
      </section>

      <RequestAccessDialog
        server={requesting}
        onOpenChange={(open) => {
          if (!open) setRequesting(null);
        }}
        onPaired={() => {
          // Re-read which machines this browser holds keys for, so the card
          // flips from an invitation to a session list without a reload.
          void servers.refreshPaired();
          void machines.reload();
        }}
      />

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
              {upgrade?.message ??
                "On the free plan a machine keeps its hostname. Pro lets you call it whatever you like."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* The free thing that was always possible and never offered: the
              name can live on this device, where nothing is gated. */}
          {upgrade?.target.serverId && (
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <p className="text-sm text-muted-foreground">
                Or name it just for this browser. It stays on this device — your
                other devices keep seeing {upgrade.target.current}.
              </p>
              <Button
                variant="outline"
                className="mt-3 h-11 w-full"
                onClick={() => void renameLocallyInstead()}
              >
                Call it &ldquo;{upgrade.name}&rdquo; on this device
              </Button>
            </div>
          )}
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

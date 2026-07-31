"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@repo/ui/lib/utils";
import { useServers } from "@/hooks/use-servers";
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
 * The fetch and the request dialog both live here rather than in either list.
 * The dialog especially: the broker allows one live request per device, so N
 * mounted dialogs would be N ways to race each other into a 409.
 */
export function DashboardBody() {
  const servers = useServers();
  const [requesting, setRequesting] = useState<RegisteredServer | null>(null);
  const [managing, setManaging] = useState(false);

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
          Rename, remove, share, or add another. Pairing lives in the list
          above.
        </p>

        <div id="your-machines" hidden={!managing}>
          {managing && (
            <ServerList servers={servers} onRequestAccess={setRequesting} />
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
        }}
      />
    </>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatSas } from "@repo/crypto";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@repo/ui/components/ui/dialog";
import { Button } from "@repo/ui/components/ui/button";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { env } from "@/env";
import {
  requestAccess,
  type AccessRequestUpdate,
  type PairingHandle,
} from "@/lib/pairing-client";
import { pairedMessage, persistPairing } from "@/lib/persist-pairing";
import { CopyCommand } from "./copy-command";
import type { RegisteredServer } from "./server-row";

/**
 * "Pair this device", made to actually pair.
 *
 * The button existed and did a local IndexedDB lookup, failed, and told you to
 * go and use the other computer. `requestAccess()` — fully wired through
 * crypto, protocol, broker and CLI — had zero callers. This is the caller.
 *
 * ## Why there is no "yes, they match" button
 *
 * The six digits are a *verification* the human at the machine performs, not a
 * decision this browser makes. By the time `confirm` renders, `pair:reveal` has
 * already gone — it has to, because the SAS is derived from both public keys.
 * A button here would imply the browser is still holding something back, and
 * it is not. What the user does with the digits is read them aloud; the machine
 * is where the y/N lives.
 *
 * ## Mounted once, not per row
 *
 * The broker enforces one live request per device. N dialogs would be N ways to
 * race each other into a 409, so `ServerList` keeps a single
 * `useState<RegisteredServer | null>` and this component reads it.
 */

type State =
  | { phase: "asking" }
  | { phase: "confirm"; sas: string }
  | { phase: "connecting" }
  | { phase: "failed"; message: string; reason?: string };

/**
 * The first CLI that answers `mtmux approve`.
 *
 * Gating the *copy* on a self-reported version is fine; gating a security
 * decision on one would not be. If this is wrong the user sees a command their
 * CLI does not have, which the recovery below already covers.
 */
const APPROVE_SINCE = "0.5.0";

function hasApprove(cliVersion: string | null): boolean {
  if (!cliVersion) return false;
  const parse = (v: string) =>
    v
      .split(".")
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const [a, b, c] = parse(cliVersion);
  const [x, y, z] = parse(APPROVE_SINCE);
  if (a! !== x!) return a! > x!;
  if (b! !== y!) return b! > y!;
  return c! >= z!;
}

export function RequestAccessDialog({
  server,
  onOpenChange,
  onPaired,
}: {
  /** Null when closed. Opening is "set this to a machine". */
  server: RegisteredServer | null;
  onOpenChange: (open: boolean) => void;
  onPaired: () => void;
}) {
  const [state, setState] = useState<State>({ phase: "asking" });
  const handleRef = useRef<PairingHandle | null>(null);

  const apiBase = env.NEXT_PUBLIC_API_URL;
  const serverId = server?.id ?? null;

  useEffect(() => {
    if (!serverId || !apiBase) return;
    setState({ phase: "asking" });

    const onUpdate = (update: AccessRequestUpdate) => {
      if (update.phase === "confirm") {
        setState({ phase: "confirm", sas: update.sas });
        return;
      }
      if (update.phase === "failed") {
        setState({
          phase: "failed",
          message: update.message,
          reason: update.reason,
        });
        return;
      }
      if (update.phase === "asking") return;

      setState({ phase: "connecting" });
      void (async () => {
        try {
          const { winner } = await persistPairing(update);
          toast.success(pairedMessage(update.descriptor, winner));
          onPaired();
          onOpenChange(false);
        } catch (err) {
          // The one that actually happens: a locked device, where
          // `saveSessionKeys` refuses to write plaintext keys.
          setState({
            phase: "failed",
            message:
              err instanceof Error
                ? err.message
                : "Could not save this pairing.",
          });
        }
      })();
    };

    handleRef.current = requestAccess({
      apiBase,
      serverId,
      deviceLabel: deviceLabel(),
      onUpdate,
    });

    return () => handleRef.current?.cancel();
    // `onPaired`/`onOpenChange` are stable callers; re-running on their
    // identity would restart a live request mid-handshake.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, apiBase]);

  const noTty = state.phase === "failed" && state.reason === "no-tty";

  return (
    <Dialog open={server !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {state.phase === "confirm"
              ? "Check these digits match"
              : `Pair with ${server?.name ?? "this machine"}`}
          </DialogTitle>
          <DialogDescription>
            {state.phase === "asking" &&
              "Asking that machine to let this browser in. Someone at it has to approve."}
            {state.phase === "confirm" &&
              "The same six digits are on that machine's screen. Approve there only if they match."}
            {state.phase === "connecting" &&
              "Approved. Setting up the session."}
            {state.phase === "failed" && "That did not go through."}
          </DialogDescription>
        </DialogHeader>

        {state.phase === "asking" && (
          <div
            className="flex items-center gap-3 py-6 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Waiting for someone to answer…
          </div>
        )}

        {state.phase === "confirm" && (
          <div className="space-y-4">
            <div
              className="flex items-center justify-center gap-1 rounded-lg border border-border bg-muted/40 py-6"
              aria-label={`Verification digits ${state.sas.split("").join(" ")}`}
            >
              {formatSas(state.sas)
                .split("")
                .map((ch, i) =>
                  ch === " " ? (
                    <span key={i} className="px-2 opacity-30">
                      ·
                    </span>
                  ) : (
                    <span
                      key={i}
                      className="font-mono text-4xl tabular-nums tracking-tight sm:text-5xl"
                    >
                      {ch}
                    </span>
                  ),
                )}
            </div>
            <p className="text-center text-xs text-muted-foreground">
              If they differ, refuse it on the machine. Nothing usable has been
              exchanged.
            </p>
          </div>
        )}

        {state.phase === "connecting" && (
          <div
            className="flex items-center gap-3 py-6 text-sm text-muted-foreground"
            role="status"
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Connecting…
          </div>
        )}

        {state.phase === "failed" && (
          <div className="space-y-4">
            <p className="text-sm text-destructive" role="alert">
              {state.message}
            </p>

            {/*
              The no-tty case needs a real way out, and used to name a command
              that did not exist. The primary recovery is the code path, which
              works on every CLI version in the field with no new protocol: the
              browser shows digits, the user runs `mtmux pair <code>` over SSH.
            */}
            {noTty && (
              <div className="space-y-3 rounded-lg border border-border bg-muted/40 p-4">
                <p className="text-sm text-muted-foreground">
                  Nobody is sitting at that machine. If you can reach it over
                  SSH, pair with a code instead — it works on any version.
                </p>
                <Button asChild className="h-11 w-full">
                  <Link href="/pair">Pair with a code instead</Link>
                </Button>
                {hasApprove(server?.cliVersion ?? null) && (
                  <div className="space-y-2 pt-1">
                    <p className="text-xs text-muted-foreground">
                      Or open an approval window on the machine, then try again:
                    </p>
                    <CopyCommand command="mtmux approve" />
                  </div>
                )}
              </div>
            )}

            <Button
              variant="outline"
              className="h-11 w-full"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * What the machine's screen calls this browser.
 *
 * Coarse on purpose. It is shown to a human deciding whether the request is
 * theirs, and "Chrome on macOS" answers that; a full user-agent string is both
 * unreadable and more than the question needs.
 */
function deviceLabel(): string {
  if (typeof navigator === "undefined") return "A browser";
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "A browser";
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  return os ? `${browser} on ${os}` : browser;
}

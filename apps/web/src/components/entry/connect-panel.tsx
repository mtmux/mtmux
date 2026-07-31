"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@repo/ui/components/ui/button";
import { Input } from "@repo/ui/components/ui/input";
import { Label } from "@repo/ui/components/ui/label";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { describeBadCode, normalizeCode, parseCode } from "@repo/crypto";
import { env } from "@/env";
import {
  joinPairing,
  type PairingHandle,
  type PairingUpdate,
} from "@/lib/pairing-client";
import { pairedMessage, persistPairing } from "@/lib/persist-pairing";

/**
 * Claim a code the terminal is showing.
 *
 * This is the majority path through the whole product, and it used to live only
 * at `/j` — a route linked from nowhere. It is a component rather than a page so
 * that `/start` can lead with it while `/j` stays exactly what the QR points at.
 *
 * ## The fragment
 *
 * The code arrives in the URL *fragment* (`/j#49271638`), never the query
 * string. A fragment is not sent to any server, so the four-digit half that is
 * the PAKE password never reaches the web host's access log, a referrer header,
 * or a CDN — which is the entire reason the code can be short enough to read off
 * a screen. It is stripped from the address bar before anything else happens, so
 * it does not survive into history either.
 *
 * With a fragment this pairs with zero taps. Without one it falls back to the
 * six-digit field, which is what someone typing the code by hand needs.
 */

type State =
  | { phase: "idle" }
  | { phase: "verifying" }
  | { phase: "connecting" }
  | { phase: "failed"; message: string };

export type ConnectPanelProps = {
  /**
   * `full` centres the panel in the viewport with its own heading — what `/j`
   * wants, since the code is the only thing on the page. `compact` drops the
   * outer centring and the heading so `/start` can supply its own and put
   * secondary routes underneath.
   */
  variant?: "full" | "compact";
};

export function ConnectPanel({ variant = "full" }: ConnectPanelProps) {
  const router = useRouter();
  const [state, setState] = useState<State>({ phase: "idle" });
  const [code, setCode] = useState("");
  const handleRef = useRef<PairingHandle | null>(null);

  const apiBase = env.NEXT_PUBLIC_API_URL;

  const onUpdate = useCallback(
    (update: PairingUpdate) => {
      if (update.phase === "verifying") {
        setState({ phase: "verifying" });
        return;
      }
      if (update.phase === "failed") {
        setState({ phase: "failed", message: update.message });
        return;
      }
      if (update.phase === "waiting") return; // joinPairing never emits this

      // Paired. Race the direct candidates before falling back to the tunnel,
      // then hand off to the terminal. Identical to the /pair tail on purpose —
      // which side showed the code changes nothing about what to do with the
      // descriptor once it is open — which is why both go through
      // `persistPairing`.
      setState({ phase: "connecting" });
      void (async () => {
        const { winner } = await persistPairing(update);
        toast.success(pairedMessage(update.descriptor, winner));
        router.push("/");
      })();
    },
    [router],
  );

  const join = useCallback(
    (raw: string) => {
      if (!apiBase) return;
      handleRef.current?.cancel();
      setState({ phase: "verifying" });
      handleRef.current = joinPairing({ apiBase, code: raw, onUpdate });
    },
    [apiBase, onUpdate],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Either shape: six typed digits, or the QR's slot + 128-bit secret.
    // `parseCode` validates both and rejects anything else, so a junk fragment
    // still lands on the manual form rather than starting a doomed handshake.
    const raw = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    const fromFragment = parseCode(raw) ? raw : null;

    // Out of the address bar first, before anything can fail or return early.
    // A live code sitting in the URL bar is a live code whether or not *this*
    // build can use it — and the obvious next move for someone who lands here
    // without a broker is to open the same URL somewhere that has one.
    if (fromFragment) {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    }

    if (!apiBase) {
      setState({
        phase: "failed",
        message:
          "This build has no pairing service configured. Self-hosted installs use the token shown by `mtmux start` instead.",
      });
      return;
    }

    if (!fromFragment) return;
    join(fromFragment);

    return () => handleRef.current?.cancel();
  }, [apiBase, join]);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const digits = normalizeCode(code);
    if (!digits) {
      // Names the lengths we accept rather than asserting one, so this survives
      // the next change of length instead of becoming a lie about the code the
      // terminal is showing.
      toast.error(describeBadCode(code));
      return;
    }
    join(digits);
  }

  const busy = state.phase === "verifying" || state.phase === "connecting";

  return (
    <div className="space-y-4">
      {variant === "full" && (
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            Connect to your terminal
          </h1>
          <p className="text-sm text-muted-foreground">
            {busy
              ? "Setting up a secure channel"
              : "Enter the code shown in your terminal"}
          </p>
        </div>
      )}

      {state.phase === "verifying" && (
        <p className="text-center text-sm text-muted-foreground" role="status">
          Verifying the code…
        </p>
      )}

      {state.phase === "connecting" && (
        <p className="text-center text-sm text-muted-foreground" role="status">
          Connecting…
        </p>
      )}

      {state.phase === "failed" && (
        <p className="text-center text-sm text-destructive" role="alert">
          {state.message}
        </p>
      )}

      {!busy && apiBase && (
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="code">Pairing code</Label>
            <Input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="49 271 638"
              className="h-14 text-center font-mono text-2xl tracking-[0.3em] tabular-nums"
              // Eight digits plus separators, and long enough to hold a pasted
              // 26-character scan code — which is a thing people do when a QR
              // will not focus and they copy the link out of the page.
              maxLength={32}
              autoFocus
            />
          </div>
          <Button className="h-11 w-full" type="submit">
            {state.phase === "failed" && <RefreshCw className="mr-2 h-4 w-4" />}
            {state.phase === "failed" ? "Try again" : "Connect"}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Only the first two digits reach our servers.
          </p>
        </form>
      )}
    </div>
  );
}

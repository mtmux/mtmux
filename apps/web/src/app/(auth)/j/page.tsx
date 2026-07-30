"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@repo/ui/components/ui/button";
import { Input } from "@repo/ui/components/ui/input";
import { Label } from "@repo/ui/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/ui/card";
import { RefreshCw, Terminal } from "lucide-react";
import { toast } from "sonner";
import { normalizeCode } from "@repo/crypto";
import { env } from "@/env";
import {
  joinPairing,
  type PairingHandle,
  type PairingUpdate,
} from "@/lib/pairing-client";
import { raceCandidates } from "@/lib/candidate-race";
import { markJustPaired } from "@/lib/lock-controller";
import {
  saveDescriptor,
  saveSessionKeys,
  serverIdFor,
} from "@/lib/session-store";

/**
 * Claim a code the terminal is showing — the QR target for `mtmux start`.
 *
 * The six digits arrive in the URL *fragment* (`/j#492716`), never the query
 * string. A fragment is not sent to any server, so the four-digit half that is
 * the PAKE password never reaches the web host's access log, a referrer header,
 * or a CDN — which is the entire reason the code can be short enough to read
 * off a screen. The fragment is stripped from the address bar before anything
 * else happens, so it does not survive into history either.
 *
 * With a fragment this pairs with zero taps. Without one it falls back to a
 * six-digit field, which is what someone typing the code by hand needs.
 */

type State =
  | { phase: "idle" }
  | { phase: "verifying" }
  | { phase: "connecting" }
  | { phase: "failed"; message: string };

export default function JoinPage() {
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
      // then hand off to the terminal. Identical to the /pair tail on purpose:
      // which side showed the code changes nothing about what to do with the
      // descriptor once it is open.
      setState({ phase: "connecting" });
      void (async () => {
        // The probe authenticates with the token both ends derived, so a
        // candidate only wins if it really is the machine we just paired with.
        const { winner } = await raceCandidates(
          update.descriptor.candidates,
          update.keys.directToken,
        );
        await saveSessionKeys(serverIdFor(update.descriptor), update.keys);
        saveDescriptor({
          descriptor: update.descriptor,
          preferredCandidate: winner ?? undefined,
          directToken: update.keys.directToken,
          pairedAt: Date.now(),
        });
        toast.success(
          winner
            ? `Connected to ${update.descriptor.label} directly`
            : `Connected to ${update.descriptor.label} over the relay`,
        );
        // Offer the device lock once, here and nowhere else — see
        // `takeEnrollmentPrompt`.
        markJustPaired();
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
    if (!apiBase) {
      setState({
        phase: "failed",
        message:
          "This build has no pairing service configured. Self-hosted installs use the token shown by `mtmux start` instead.",
      });
      return;
    }
    if (typeof window === "undefined") return;

    const fromFragment = normalizeCode(
      decodeURIComponent(window.location.hash.replace(/^#/, "")),
    );
    if (!fromFragment) return;

    // Out of the address bar before the handshake starts, so a screenshot, a
    // shared tab, or the back button cannot resurrect a live code.
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
    join(fromFragment);

    return () => handleRef.current?.cancel();
  }, [apiBase, join]);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const digits = normalizeCode(code);
    if (!digits) {
      toast.error("Enter the six digits shown in your terminal.");
      return;
    }
    join(digits);
  }

  const busy = state.phase === "verifying" || state.phase === "connecting";

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Terminal className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl">Connect to your terminal</CardTitle>
          <CardDescription>
            {busy
              ? "Setting up a secure channel"
              : "Enter the six digits shown by mtmux"}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {state.phase === "verifying" && (
            <p className="text-center text-sm text-muted-foreground">
              Verifying the code…
            </p>
          )}

          {state.phase === "connecting" && (
            <p className="text-center text-sm text-muted-foreground">
              Connecting…
            </p>
          )}

          {state.phase === "failed" && (
            <p className="text-center text-sm text-destructive">
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
                  placeholder="49 27 16"
                  className="text-center font-mono text-2xl tracking-[0.3em] tabular-nums"
                  maxLength={12}
                  autoFocus
                />
              </div>
              <Button className="w-full" type="submit">
                {state.phase === "failed" && (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                {state.phase === "failed" ? "Try again" : "Connect"}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                The last four digits never leave this device.
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

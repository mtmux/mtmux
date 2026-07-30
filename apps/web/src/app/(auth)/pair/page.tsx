"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@repo/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/ui/card";
import { Check, Copy, RefreshCw, Terminal } from "lucide-react";
import { toast } from "sonner";
import { env } from "@/env";
import {
  startPairing,
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

type State =
  | { phase: "requesting" }
  | { phase: "waiting"; code: string; expiresAt: number }
  | { phase: "verifying" }
  | { phase: "connecting" }
  | { phase: "failed"; message: string };

function secondsLeft(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

export default function PairPage() {
  const router = useRouter();
  const [state, setState] = useState<State>({ phase: "requesting" });
  const [remaining, setRemaining] = useState(0);
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const handleRef = useRef<PairingHandle | null>(null);

  const apiBase = env.NEXT_PUBLIC_API_URL;

  const onUpdate = useCallback(
    (update: PairingUpdate) => {
      if (update.phase === "waiting") {
        setState({
          phase: "waiting",
          code: update.code,
          expiresAt: update.expiresAt,
        });
        setRemaining(secondsLeft(update.expiresAt));
        return;
      }
      if (update.phase === "verifying") {
        setState({ phase: "verifying" });
        return;
      }
      if (update.phase === "failed") {
        setState({ phase: "failed", message: update.message });
        return;
      }

      // Paired. Race the direct candidates before falling back to the tunnel,
      // then hand off to the terminal.
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

  useEffect(() => {
    if (!apiBase) {
      setState({
        phase: "failed",
        message:
          "This build has no pairing service configured. Self-hosted installs use the code shown by `mtmux start` instead.",
      });
      return;
    }
    setState({ phase: "requesting" });
    const handle = startPairing({ apiBase, onUpdate });
    handleRef.current = handle;
    return () => handle.cancel();
  }, [apiBase, onUpdate, attempt]);

  // Live countdown, so an expired code visibly expires instead of just failing.
  useEffect(() => {
    if (state.phase !== "waiting") return;
    const id = setInterval(() => {
      const left = secondsLeft(state.expiresAt);
      setRemaining(left);
      if (left === 0) {
        setState({
          phase: "failed",
          message: "This code expired. Get a new one.",
        });
      }
    }, 1000);
    return () => clearInterval(id);
  }, [state]);

  const code = state.phase === "waiting" ? state.code : "";

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy — read the digits instead.");
    }
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Terminal className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl">Pair this device</CardTitle>
          <CardDescription>
            {state.phase === "waiting"
              ? "Type this code into your terminal"
              : "Setting up a secure channel"}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          {state.phase === "requesting" && (
            <p className="text-center text-sm text-muted-foreground">
              Getting a code…
            </p>
          )}

          {state.phase === "waiting" && (
            <>
              <button
                type="button"
                onClick={copyCode}
                aria-label={`Pairing code ${code.split("").join(" ")}, tap to copy`}
                className="mx-auto flex w-full items-center justify-center gap-1 rounded-lg border border-border bg-muted/40 py-6 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {code.split("").map((digit, i) => (
                  <span
                    key={i}
                    className={`font-mono text-4xl tabular-nums tracking-tight sm:text-5xl ${
                      i < 2 ? "text-muted-foreground" : "text-foreground"
                    }`}
                  >
                    {digit}
                    {i === 1 && <span className="px-2 opacity-30">·</span>}
                  </span>
                ))}
                <span className="ml-3 text-muted-foreground">
                  {copied ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </span>
              </button>

              <div className="space-y-2 rounded-lg bg-muted/40 p-4">
                <p className="text-sm text-muted-foreground">
                  On the machine running mtmux:
                </p>
                <code className="block rounded bg-background px-3 py-2 font-mono text-sm">
                  mtmux pair {code}
                </code>
              </div>

              <p className="text-center text-xs text-muted-foreground">
                Expires in {remaining}s. The last four digits never leave this
                device.
              </p>
            </>
          )}

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
            <div className="space-y-4">
              <p className="text-center text-sm text-destructive">
                {state.message}
              </p>
              <Button
                className="w-full"
                onClick={() => setAttempt((n) => n + 1)}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Get a new code
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

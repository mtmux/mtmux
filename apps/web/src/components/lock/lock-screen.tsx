"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@repo/ui/components/ui/button";
import { Fingerprint, Loader2, Lock } from "lucide-react";
import { toast } from "sonner";
import { wipe } from "@repo/crypto";
import {
  readLockRecord,
  unlockWithFactorKey,
  unlockWithPin,
  type LockRecord,
} from "@/lib/lock-store";
import { duringCeremony } from "@/lib/lock-controller";
import { evaluatePrf, prfSupport } from "@/lib/passkey-prf";
import { PinPad } from "./pin-pad";

/**
 * The whole app while locked.
 *
 * Rendered *instead of* the terminal subtree, never over it — the xterm
 * scrollback has to be garbage-collected rather than merely covered, or the
 * lock is a CSS overlay with the shell still in the DOM one devtools panel
 * away.
 */
export function LockScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [record, setRecord] = useState<LockRecord | null>(null);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    void readLockRecord().then((r) => {
      setRecord(r);
      if (r?.lockedUntil && r.lockedUntil > Date.now()) {
        setWaitUntil(r.lockedUntil);
      }
    });
  }, []);

  // Ticks only while there is a countdown to show.
  useEffect(() => {
    if (!waitUntil) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [waitUntil]);

  const throttled = waitUntil !== null && waitUntil > now;

  const submit = useCallback(
    async (value: string) => {
      setBusy(true);
      try {
        const outcome = await unlockWithPin(value);
        if (outcome.ok) {
          onUnlocked();
          return;
        }
        setPin("");
        if (outcome.reason === "throttled") {
          setWaitUntil(outcome.until);
          return;
        }
        if (outcome.reason === "wiped") {
          toast.error("Too many attempts. This device has been erased.");
          window.location.href = "/login";
          return;
        }
        if (outcome.reason === "no-lock") {
          onUnlocked();
          return;
        }
        const fresh = await readLockRecord();
        if (fresh?.lockedUntil && fresh.lockedUntil > Date.now()) {
          setWaitUntil(fresh.lockedUntil);
        }
        toast.error(
          outcome.attemptsLeft === null
            ? "Wrong PIN."
            : `Wrong PIN. ${outcome.attemptsLeft} left before this device erases itself.`,
        );
      } finally {
        setBusy(false);
      }
    },
    [onUnlocked],
  );

  async function unlockWithPasskey(factorId: string) {
    setBusy(true);
    try {
      const secret = await duringCeremony(() => evaluatePrf(factorId));
      if (!secret) {
        toast.error("That did not produce a key. Use your PIN.");
        return;
      }
      const outcome = await unlockWithFactorKey(factorId, secret);
      wipe(secret);
      if (outcome.ok) onUnlocked();
      else toast.error("That passkey does not open this device.");
    } finally {
      setBusy(false);
    }
  }

  const passkey = record?.factors.find((f) => f.kind === "passkey");
  // Recorded at enrollment so the dots match what was chosen. The digit count
  // is not a secret — hiding it would only mean the pad silently accepts more
  // digits than it draws.
  const length = record?.pinLength ?? 6;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Lock className="h-5 w-5 text-muted-foreground" aria-hidden />
        </span>
        <h1 className="text-lg font-medium text-foreground">Locked</h1>
        <p className="max-w-xs text-sm text-muted-foreground">
          Your keys are encrypted on this device. Nothing on the machine was
          stopped — your sessions are still running.
        </p>
      </div>

      <div className="w-full max-w-xs">
        <PinPad
          length={length}
          value={pin}
          onChange={setPin}
          onComplete={(value) => void submit(value)}
          disabled={busy || throttled}
          label="Enter your PIN"
          autoFocus
        />
        {busy && (
          <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Checking…
          </p>
        )}
        {throttled && (
          <p
            role="status"
            className="text-center text-sm text-muted-foreground"
          >
            Too many attempts. Try again in{" "}
            {Math.ceil((waitUntil - now) / 1000)}s.
          </p>
        )}
      </div>

      {passkey && prfSupport() === "available" && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void unlockWithPasskey(passkey.id)}
        >
          <Fingerprint className="h-4 w-4" aria-hidden />
          Use a passkey
        </Button>
      )}

      <p className="max-w-xs text-center text-xs text-muted-foreground">
        Forgotten it? There is no reset — run <code>mtmux</code> on the machine
        and pair this browser again.
      </p>
    </div>
  );
}

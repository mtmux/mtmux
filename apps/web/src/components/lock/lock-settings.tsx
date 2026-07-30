"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@repo/ui/components/ui/button";
import { Label } from "@repo/ui/components/ui/label";
import { Switch } from "@repo/ui/components/ui/switch";
import { toast } from "sonner";
import { wipe } from "@repo/crypto";
import {
  addFactor,
  eraseDevice,
  readLockRecord,
  removeFactor,
  updateLockSettings,
  type LockRecord,
} from "@/lib/lock-store";
import { duringCeremony, lockNow } from "@/lib/lock-controller";
import { enrollPasskeyFactor, prfSupport } from "@/lib/passkey-prf";
import { isEnrolled } from "@/lib/unlocked";
import { LockEnrollDialog } from "./lock-enroll-dialog";

const IDLE_OPTIONS = [1, 5, 15, 60, 0] as const;

function idleLabel(minutes: number): string {
  if (minutes === 0) return "Never";
  if (minutes < 60) return `${minutes} min`;
  return "1 hour";
}

/** The lock's settings, wherever the app decides to show them. */
export function LockSettings({ className }: { className?: string }) {
  const [record, setRecord] = useState<LockRecord | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setRecord(await readLockRecord());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function patch(next: Partial<LockRecord>) {
    await updateLockSettings(next);
    await refresh();
  }

  async function addPasskey() {
    setBusy(true);
    try {
      const result = await duringCeremony(() =>
        enrollPasskeyFactor("mtmux device lock"),
      );
      if (!result.ok) {
        toast.error(
          result.reason === "no-prf"
            ? "That authenticator cannot derive a key. The passkey it created is unused — remove it in your device's settings."
            : "Could not add that passkey.",
        );
        return;
      }
      await addFactor("passkey", result.secret, { label: "Passkey" });
      wipe(result.secret);
      await refresh();
      toast.success("Passkey added.");
    } finally {
      setBusy(false);
    }
  }

  async function drop(id: string) {
    try {
      await removeFactor(id);
      await refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function erase() {
    if (
      !window.confirm(
        "Erase every key on this device? Your sessions keep running — this browser just has to pair again.",
      )
    ) {
      return;
    }
    await eraseDevice();
    window.location.href = "/start";
  }

  if (!record || !isEnrolled()) {
    return (
      <section className={className}>
        <h3 className="mb-1 text-sm font-semibold">Device lock</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          Encrypt this browser&apos;s keys behind a PIN, so an unlocked phone in
          someone else&apos;s hand is not a terminal on your machine.
        </p>
        <Button size="sm" onClick={() => setEnrolling(true)}>
          Set a PIN
        </Button>
        <LockEnrollDialog
          open={enrolling}
          onOpenChange={setEnrolling}
          onEnrolled={() => void refresh()}
        />
      </section>
    );
  }

  const passkeys = record.factors.filter((f) => f.kind === "passkey");

  return (
    <section className={className}>
      <h3 className="mb-3 text-sm font-semibold">Device lock</h3>

      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <Label className="text-xs">Lock after</Label>
          <div className="flex flex-wrap gap-1">
            {IDLE_OPTIONS.map((minutes) => (
              <button
                key={minutes}
                type="button"
                aria-pressed={record.idleMinutes === minutes}
                onClick={() => void patch({ idleMinutes: minutes })}
                className={
                  record.idleMinutes === minutes
                    ? "rounded border border-primary bg-primary/10 px-2 py-1 text-xs"
                    : "rounded border border-border px-2 py-1 text-xs text-muted-foreground"
                }
              >
                {idleLabel(minutes)}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Label className="text-xs">Lock when I switch apps</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Off by default on phones: iOS treats the app switcher, the share
              sheet and the Face ID prompt itself as leaving the app.
            </p>
          </div>
          <Switch
            checked={record.lockOnBackground}
            onCheckedChange={(v) => void patch({ lockOnBackground: v })}
          />
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Label className="text-xs">Erase after 10 wrong PINs</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Off by default. A child mashing the pad is likelier than the
              attack this stops — and anyone who copied this browser&apos;s
              storage is not typing into it anyway.
            </p>
          </div>
          <Switch
            checked={record.wipeAfter10}
            onCheckedChange={(v) => void patch({ wipeAfter10: v })}
          />
        </div>

        <div>
          <Label className="text-xs">Passkeys</Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The only factor that also protects a copy of this browser&apos;s
            storage taken elsewhere.
          </p>
          <ul className="mt-2 space-y-1">
            {passkeys.map((factor) => (
              <li
                key={factor.id}
                className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1.5 text-xs"
              >
                <span className="truncate text-muted-foreground">
                  {factor.label ?? "Passkey"} ·{" "}
                  {new Date(factor.createdAt).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => void drop(factor.id)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {prfSupport() === "available" ? (
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={busy}
              onClick={() => void addPasskey()}
            >
              Add a passkey
            </Button>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              {prfSupport() === "insecure-context"
                ? "Passkeys need a secure origin — open mtmux over the tunnel to add one."
                : "This browser does not support passkeys."}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          <Button size="sm" variant="outline" onClick={() => lockNow("manual")}>
            Lock now
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void erase()}>
            Erase this device
          </Button>
        </div>
      </div>
    </section>
  );
}

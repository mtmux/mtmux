"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, LayoutGrid, LogOut } from "lucide-react";
import { Button } from "@repo/ui/components/ui/button";
import { SettingsPanel } from "@/components/settings/settings-panel";
import { isHostedBuild } from "@/lib/auth-client";
import { disconnectDevice } from "@/lib/sign-out";

export default function SettingsPage() {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);

  /**
   * "Logout" used to clear `TOKEN_KEY` and push `/login`, which did nothing at
   * all for a device attached through a hosted pairing — the entry page found
   * the descriptor still in IndexedDB and sent you straight back. See
   * `disconnectDevice` for what actually has to be dropped.
   *
   * The label is **Disconnect** now because that is the true scope: this device
   * lets go of this machine. Nothing on the machine stops, and nothing else on
   * this device is touched. "Erase everything here" is a separate, louder
   * action and it already exists in the device-lock settings below.
   */
  async function handleDisconnect() {
    setLeaving(true);
    try {
      await disconnectDevice();
    } catch {
      // `disconnectDevice` ends in a full navigation; if it threw before that,
      // re-enable the button rather than stranding the page mid-sign-out.
      setLeaving(false);
    }
  }

  return (
    <div className="flex h-[100dvh] flex-col bg-background">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => router.back()}
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="flex-1 text-sm font-semibold">Settings</h1>
        {isHostedBuild && (
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard">
              <LayoutGrid className="mr-1 h-3.5 w-3.5" aria-hidden />
              Machines
            </Link>
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          onClick={() => void handleDisconnect()}
          disabled={leaving}
        >
          <LogOut className="mr-1 h-3.5 w-3.5" />
          {leaving ? "Disconnecting…" : "Disconnect"}
        </Button>
      </header>
      <SettingsPanel className="flex-1" />
    </div>
  );
}

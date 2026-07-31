import type { Metadata } from "next";
import { DashboardBody } from "@/components/account/dashboard-body";
import { LockGate } from "@/components/lock/lock-gate";
import { RequireSession } from "@/components/account/require-session";

export const metadata: Metadata = {
  title: "Your sessions · mtmux",
  description:
    "Every tmux session on every machine you can reach, gathered by this browser.",
};

/**
 * Gated on the device lock as well as the account session.
 *
 * This page renders every tmux session name on every machine you own — which is
 * the single most descriptive thing this browser can display, and precisely
 * what a lock is for. A lock screen in front of the terminal but not in front of
 * "deploy-prod, client-acme, staging-db" is not a lock.
 *
 * Applied here, on this page, rather than to `(account)/layout.tsx`: that
 * layout also holds `signin`, `signup` and `reset`, and a device lock in front
 * of account recovery is a lockout generator.
 */
export default function DashboardPage() {
  return (
    <LockGate>
      <RequireSession>
        <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-8">
          {/*
            One card per machine, whatever state it is in. The page used to
            render every machine twice — once as a session group and once under
            "Your machines" — and the invitation card's CTA was an anchor to the
            duplicate rather than the action itself.
          */}
          <DashboardBody />
        </div>
      </RequireSession>
    </LockGate>
  );
}

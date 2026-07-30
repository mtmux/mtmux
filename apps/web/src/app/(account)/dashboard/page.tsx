import type { Metadata } from "next";
import { AllSessions } from "@/components/account/all-sessions";
import { LockGate } from "@/components/lock/lock-gate";
import { RequireSession } from "@/components/account/require-session";
import { ServerList } from "@/components/account/server-list";

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
          Sessions first, machines second. "What is running" is the question
          people open this page with; the machine list is how you answer the
          rarer one, "which of these do I still want".
        */}
          <header className="mb-5">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Your sessions
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Gathered by this browser, straight from each machine. mtmux&apos;s
              servers never see a session name.
            </p>
          </header>
          <AllSessions />

          <header className="mt-10 mb-5">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              Your machines
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Everything signed in to this account. Anything running{" "}
              <code className="font-mono text-xs">mtmux</code> shows up here on
              its own.
            </p>
          </header>
          <ServerList />
        </div>
      </RequireSession>
    </LockGate>
  );
}

import type { Metadata } from "next";
import { RequireSession } from "@/components/account/require-session";
import { ServerList } from "@/components/account/server-list";

export const metadata: Metadata = {
  title: "Your machines · mtmux",
  description: "Every machine running mtmux under your account, in one list.",
};

export default function DashboardPage() {
  return (
    <RequireSession>
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-8">
        <header className="mb-5">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Your machines
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything signed in to this account. Anything running{" "}
            <code className="font-mono text-xs">mtmux</code> shows up here on
            its own.
          </p>
        </header>
        <ServerList />
      </div>
    </RequireSession>
  );
}

import type { Metadata } from "next";
import { RequireSession } from "@/components/account/require-session";
import { SecurityPanel } from "./security-panel";

export const metadata: Metadata = {
  title: "Security · mtmux",
  description: "Passkeys and connected accounts for your mtmux account.",
};

export default function SecurityPage() {
  return (
    <RequireSession>
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-8">
        <header className="mb-5">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Security
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            How you sign in to mtmux.
          </p>
        </header>
        <SecurityPanel />
      </div>
    </RequireSession>
  );
}

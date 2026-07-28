import type { Metadata } from "next";
import { BillingPanel } from "@/components/account/billing-panel";
import { RequireSession } from "@/components/account/require-session";

export const metadata: Metadata = {
  title: "Billing · mtmux",
  description: "Your mtmux plan, usage this month, and payment settings.",
};

export default function BillingPage() {
  return (
    <RequireSession>
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:py-8">
        <header className="mb-5">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            Billing
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            What you&apos;re on, what you&apos;ve used, and where to change it.
          </p>
        </header>
        <BillingPanel />
      </div>
    </RequireSession>
  );
}

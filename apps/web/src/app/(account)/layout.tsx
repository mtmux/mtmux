import { AccountHeader } from "@/components/account/account-header";

/**
 * Chrome for the hosted-account surfaces (sign in, device approval, dashboard,
 * billing).
 *
 * Kept separate from the terminal layout on purpose: these pages must render
 * for someone with no session and no paired server, so they cannot sit behind
 * the terminal's auth guard or its WebSocket bootstrap.
 */
export default function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-background">
      <AccountHeader />
      <main className="flex flex-1 flex-col pb-[max(env(safe-area-inset-bottom),1rem)]">
        {children}
      </main>
    </div>
  );
}

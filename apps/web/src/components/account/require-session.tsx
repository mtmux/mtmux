"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { isHostedBuild, useSession } from "@/lib/auth-client";
import { HostedUnavailable } from "./hosted-unavailable";

/**
 * Gate a page on a signed-in session.
 *
 * The whole point is the `isPending` branch: better-auth resolves the session
 * with a network call, so rendering children optimistically would flash a
 * signed-in dashboard at a signed-out visitor before bouncing them, and
 * rendering the redirect optimistically would bounce a signed-in one.
 */
export function RequireSession({
  children,
  /** Where to return after signing in. Defaults to the current path. */
  next,
}: {
  children: React.ReactNode;
  next?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, isPending } = useSession();

  const target = next ?? pathname;

  useEffect(() => {
    if (!isHostedBuild || isPending || session) return;
    router.replace(`/signin?next=${encodeURIComponent(target)}`);
  }, [isPending, session, router, target]);

  if (!isHostedBuild) return <HostedUnavailable />;

  if (isPending || !session) {
    return (
      <div
        className="flex flex-1 items-center justify-center py-24"
        role="status"
        aria-live="polite"
      >
        <Loader2
          className="h-5 w-5 animate-spin text-muted-foreground"
          aria-hidden
        />
        <span className="sr-only">
          {isPending ? "Checking your session" : "Redirecting to sign in"}
        </span>
      </div>
    );
  }

  return <>{children}</>;
}

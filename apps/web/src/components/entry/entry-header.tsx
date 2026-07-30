import Link from "next/link";
import { Terminal } from "lucide-react";

/**
 * The chrome for every page you can reach without being connected to anything.
 *
 * ## Why this is not `AccountHeader`
 *
 * It looks like thirty lines begging to be shared, and it must not be.
 * `AccountHeader` calls `useSession()`, which is an unconditional fetch to
 * api.mtmux.com on every render of every page that mounts it. The entry pages
 * are the ones a *self-hosted* install serves from its own machine — `/login`
 * is where `mtmux start`'s own `#token=` link lands — and putting a call to our
 * servers on that page would break invariant #4: the self-hosted path stays
 * fully functional with zero contact with our servers. Not "degrades
 * gracefully". Zero contact.
 *
 * So the duplication is the feature. If you find yourself factoring these two
 * together, the thing to extract is the markup, never the session hook.
 *
 * The wordmark goes to `/start` rather than `/`, because everything here is
 * reached by someone who is *not* connected — sending them to the terminal
 * would bounce them straight back.
 */
export function EntryHeader() {
  return (
    <header className="border-b border-border pt-[env(safe-area-inset-top)]">
      <div className="mx-auto flex h-14 w-full max-w-3xl items-center px-4">
        <Link
          href="/start"
          className="flex items-center gap-2 rounded-md py-2 pr-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10">
            <Terminal className="h-4 w-4 text-primary" aria-hidden />
          </span>
          <span className="font-mono text-sm font-semibold tracking-tight">
            mtmux
          </span>
        </Link>
      </div>
    </header>
  );
}

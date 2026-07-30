import { EntryHeader } from "@/components/entry/entry-header";

/**
 * Chrome for the pages you reach before you are connected to anything.
 *
 * This group had no layout at all, which is why `/pair` and `/j` were
 * dead ends: a full-bleed centred card, no header, no wordmark, and no link
 * back to anywhere. Someone who mistyped a code, or who followed a QR to the
 * wrong page, had the back button and nothing else.
 *
 * Deliberately *not* wrapped in `LockGate`. These are the pages a locked device
 * would use to re-pair, and a lock screen in front of them would be a
 * lockout — see `sealKeysIfUnlocked`, which is what actually keeps a locked
 * device from writing plaintext keys on this path.
 */
export default function EntryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-background">
      <EntryHeader />
      <main className="flex flex-1 flex-col">{children}</main>
    </div>
  );
}

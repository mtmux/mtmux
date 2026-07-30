import { ConnectPanel } from "@/components/entry/connect-panel";

/**
 * The QR target for `mtmux start` — `/j#492716`.
 *
 * Deliberately short, because it is printed as a QR next to a six-digit code
 * and every character costs modules in the symbol. All the behaviour, including
 * the fragment handling that makes this zero-tap, lives in `ConnectPanel`; the
 * same component leads `/start`, so the two cannot drift.
 */
export default function JoinPage() {
  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 py-10">
      <ConnectPanel variant="full" />
    </div>
  );
}

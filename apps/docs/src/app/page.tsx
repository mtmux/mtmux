import Link from "next/link";

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-20 text-center">
      <h1 className="mb-4 text-5xl font-bold tracking-tight">
        TermBridge
      </h1>
      <p className="mx-auto mb-8 max-w-2xl text-lg text-fd-muted-foreground">
        Access your server&apos;s terminal from any browser. Full xterm.js terminal with session management,
        file browsing, and mobile support — all over WebSocket.
      </p>
      <div className="flex gap-4">
        <Link
          href="/docs"
          className="rounded-lg bg-fd-primary px-6 py-2.5 text-sm font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/90"
        >
          Get Started
        </Link>
        <Link
          href="/docs/architecture"
          className="rounded-lg border border-fd-border px-6 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
        >
          Architecture
        </Link>
      </div>
      <div className="mt-16 grid max-w-3xl grid-cols-1 gap-6 text-left sm:grid-cols-3">
        <div className="rounded-lg border border-fd-border p-4">
          <h3 className="mb-2 font-semibold">Remote Terminal</h3>
          <p className="text-sm text-fd-muted-foreground">
            Full xterm.js with WebGL, themes, search, and Unicode support.
          </p>
        </div>
        <div className="rounded-lg border border-fd-border p-4">
          <h3 className="mb-2 font-semibold">Session Management</h3>
          <p className="text-sm text-fd-muted-foreground">
            Create, attach, rename, and kill tmux sessions from the browser.
          </p>
        </div>
        <div className="rounded-lg border border-fd-border p-4">
          <h3 className="mb-2 font-semibold">Mobile Ready</h3>
          <p className="text-sm text-fd-muted-foreground">
            Responsive UI with swipe gestures, keyboard toolbar, and tab navigation.
          </p>
        </div>
      </div>
    </main>
  );
}

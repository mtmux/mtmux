import Link from "next/link";

const features = [
  {
    title: "Remote Terminal",
    description:
      "Full xterm.js terminal with WebGL rendering, custom themes, inline search, and Unicode 11 support.",
  },
  {
    title: "Session Management",
    description:
      "Create, attach, rename, and kill tmux sessions directly from the browser UI.",
  },
  {
    title: "File Browser & Editor",
    description:
      "Browse directories, preview files with syntax highlighting, and navigate your remote filesystem.",
  },
  {
    title: "Mobile Optimized",
    description:
      "Swipe gestures, virtual keyboard toolbar, landscape mode, and haptic feedback for mobile coding.",
  },
  {
    title: "Self-Hosted",
    description:
      "Deploy on your own server with Docker or PM2. No third-party dependencies, full control over your data.",
  },
  {
    title: "Claude Code Ready",
    description:
      "Purpose-built for monitoring and interacting with Claude Code terminal sessions from anywhere.",
  },
];

const steps = [
  {
    step: "1",
    title: "Install",
    description: "Clone the repo and run pnpm setup to install dependencies and create your config.",
    code: "git clone https://github.com/nicholasgriffintn/ccremote.git\ncd ccremote && pnpm setup",
  },
  {
    step: "2",
    title: "Configure",
    description: "Set your auth token and relay URL in .env.",
    code: 'AUTH_TOKEN="your-secure-token"\nNEXT_PUBLIC_RELAY_URL="ws://your-server:14300"',
  },
  {
    step: "3",
    title: "Connect",
    description: "Start the server and open your browser — or use Docker for production.",
    code: "pnpm dev\n# or\ndocker compose -f docker-compose.prod.yml up -d",
  },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      {/* Hero */}
      <section className="flex flex-col items-center justify-center px-4 py-24 text-center">
        <div className="mb-4 inline-flex items-center rounded-full border border-fd-border px-3 py-1 text-xs font-medium text-fd-muted-foreground">
          Open Source &middot; Self-Hosted &middot; Mobile Ready
        </div>
        <h1 className="mb-4 max-w-3xl text-5xl font-bold tracking-tight sm:text-6xl">
          Access Claude Code from Any Browser
        </h1>
        <p className="mx-auto mb-8 max-w-2xl text-lg text-fd-muted-foreground">
          A remote terminal-in-browser app that connects to tmux sessions over
          WebSocket. Monitor Claude Code, manage sessions, browse files, and
          code from your phone.
        </p>
        <div className="flex flex-wrap justify-center gap-4">
          <Link
            href="/docs/getting-started"
            className="rounded-lg bg-fd-primary px-6 py-2.5 text-sm font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/90"
          >
            Get Started
          </Link>
          <Link
            href="/docs/self-hosting"
            className="rounded-lg border border-fd-border px-6 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
          >
            Self-Host Guide
          </Link>
          <a
            href="https://github.com/nicholasgriffintn/ccremote"
            className="rounded-lg border border-fd-border px-6 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
        </div>
      </section>

      {/* Features Grid */}
      <section className="mx-auto max-w-5xl px-4 py-16">
        <h2 className="mb-2 text-center text-3xl font-bold tracking-tight">
          Everything You Need
        </h2>
        <p className="mb-12 text-center text-fd-muted-foreground">
          A complete remote terminal solution, built for Claude Code workflows.
        </p>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-lg border border-fd-border p-6 transition-colors hover:bg-fd-accent/50"
            >
              <h3 className="mb-2 font-semibold">{feature.title}</h3>
              <p className="text-sm text-fd-muted-foreground">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* How It Works */}
      <section className="mx-auto max-w-4xl px-4 py-16">
        <h2 className="mb-2 text-center text-3xl font-bold tracking-tight">
          Up and Running in Minutes
        </h2>
        <p className="mb-12 text-center text-fd-muted-foreground">
          Three steps to access your terminal from anywhere.
        </p>
        <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
          {steps.map((item) => (
            <div key={item.step}>
              <div className="mb-3 flex items-center gap-3">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-fd-primary text-sm font-bold text-fd-primary-foreground">
                  {item.step}
                </span>
                <h3 className="font-semibold">{item.title}</h3>
              </div>
              <p className="mb-3 text-sm text-fd-muted-foreground">
                {item.description}
              </p>
              <pre className="overflow-x-auto rounded-lg bg-fd-secondary p-3 text-xs">
                <code>{item.code}</code>
              </pre>
            </div>
          ))}
        </div>
      </section>

      {/* Architecture */}
      <section className="mx-auto max-w-3xl px-4 py-16 text-center">
        <h2 className="mb-8 text-3xl font-bold tracking-tight">
          Simple Architecture
        </h2>
        <pre className="mx-auto inline-block rounded-lg bg-fd-secondary p-6 text-left text-sm">
          <code>{`┌─────────────┐   WebSocket    ┌──────────────┐   PTY/exec   ┌──────────┐
│   Browser    │ ◄───────────► │ Relay Server │ ◄──────────► │   tmux   │
│  (Next.js)   │   Protocol    │  (Node.js)   │              │  (host)  │
└─────────────┘               └──────────────┘              └──────────┘`}</code>
        </pre>
        <p className="mt-6 text-fd-muted-foreground">
          The web app communicates over a typed WebSocket protocol. The relay
          server bridges messages to tmux sessions and PTY streams on the host.
        </p>
      </section>

      {/* CTA */}
      <section className="flex flex-col items-center px-4 py-16 text-center">
        <h2 className="mb-4 text-3xl font-bold tracking-tight">
          Ready to Get Started?
        </h2>
        <p className="mb-6 text-fd-muted-foreground">
          Deploy ccremote on your server and access Claude Code from anywhere.
        </p>
        <div className="flex gap-4">
          <Link
            href="/docs/getting-started"
            className="rounded-lg bg-fd-primary px-6 py-2.5 text-sm font-medium text-fd-primary-foreground transition-colors hover:bg-fd-primary/90"
          >
            Read the Docs
          </Link>
          <a
            href="https://github.com/nicholasgriffintn/ccremote"
            className="rounded-lg border border-fd-border px-6 py-2.5 text-sm font-medium transition-colors hover:bg-fd-accent"
            target="_blank"
            rel="noopener noreferrer"
          >
            View on GitHub
          </a>
        </div>
      </section>
    </main>
  );
}

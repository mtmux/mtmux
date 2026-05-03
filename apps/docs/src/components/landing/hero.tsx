import Link from "next/link";
import { AnimatedTerminal } from "./animated-terminal";

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-border bg-gradient-to-b from-background via-background to-accent/10">
      <div className="absolute inset-0 -z-10 [background:radial-gradient(60%_60%_at_50%_0%,oklch(0.66_0.20_35/0.12)_0%,transparent_70%)]" />
      <div className="mx-auto grid max-w-6xl gap-12 px-6 py-24 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:py-32">
        <div>
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary animate-pulse" />
            <span>Open source · Self-hosted · MIT</span>
          </div>
          <h1 className="text-balance text-5xl font-bold leading-[1.05] tracking-tight md:text-6xl lg:text-7xl">
            Your Claude.
            <br />
            Your terminal.
            <br />
            <span className="bg-gradient-to-r from-primary to-primary/70 bg-clip-text text-transparent">
              Anywhere.
            </span>
          </h1>
          <p className="mt-6 max-w-xl text-pretty text-lg text-muted-foreground md:text-xl">
            A polished browser terminal for Claude Code. Connect to your tmux sessions from any
            device — phone, tablet, laptop — over a single secure WebSocket. One npm install away.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Link
              href="/docs"
              className="inline-flex h-12 items-center justify-center rounded-lg bg-primary px-6 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 transition hover:opacity-90"
            >
              Get started →
            </Link>
            <a
              href="https://github.com/nicholasgriffintn/ccremote"
              className="inline-flex h-12 items-center justify-center rounded-lg border border-border bg-card px-6 text-sm font-medium transition hover:bg-accent"
            >
              Star on GitHub
            </a>
            <Link
              href="#install"
              className="inline-flex h-12 items-center justify-center rounded-lg px-4 font-mono text-sm text-muted-foreground transition hover:text-foreground"
            >
              $ npm i -g ccremote
            </Link>
          </div>
        </div>
        <div className="relative">
          <AnimatedTerminal />
        </div>
      </div>
    </section>
  );
}

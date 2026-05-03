import Link from "next/link";

export function CTA() {
  return (
    <section className="py-24">
      <div className="mx-auto max-w-3xl px-6 text-center">
        <h2 className="text-balance text-4xl font-bold tracking-tight md:text-5xl">
          Bring your terminal with you.
        </h2>
        <p className="mt-4 text-lg text-muted-foreground">
          Self-hosted, MIT-licensed, no telemetry. Read the docs and ship today.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            href="/docs"
            className="inline-flex h-12 items-center justify-center rounded-lg bg-primary px-6 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 transition hover:opacity-90"
          >
            Read the docs →
          </Link>
          <a
            href="https://github.com/nicholasgriffintn/ccremote"
            className="inline-flex h-12 items-center justify-center rounded-lg border border-border bg-card px-6 text-sm font-medium transition hover:bg-accent"
          >
            View on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}

export function Architecture() {
  const Box = ({ label, sub }: { label: string; sub: string }) => (
    <div className="rounded-lg border border-border bg-card p-4 text-center">
      <div className="font-semibold">{label}</div>
      <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
    </div>
  );
  return (
    <section className="border-b border-border py-24">
      <div className="mx-auto max-w-5xl px-6">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
          One process. One port. Zero magic.
        </h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          The CLI runs Next.js and the WebSocket relay in a single Node process sharing one HTTP
          server. Everything is same-origin — trivial to put behind any reverse proxy.
        </p>
        <div className="mt-12 grid gap-4 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-center">
          <Box label="Browser" sub="xterm.js · Monaco · React 19" />
          <div className="text-center font-mono text-primary">⇄ wss</div>
          <Box label="ccremote node" sub="Next.js · ws · node-pty" />
          <div className="text-center font-mono text-primary">⇄ pty</div>
          <Box label="tmux" sub="your sessions, untouched" />
        </div>
      </div>
    </section>
  );
}

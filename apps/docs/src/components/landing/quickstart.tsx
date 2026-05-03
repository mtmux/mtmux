const steps = [
  {
    n: "01",
    title: "Install once",
    body: "Globally on the machine where your tmux runs.",
    code: "npm i -g ccremote",
  },
  {
    n: "02",
    title: "Start the server",
    body: "Auto-generates a token, opens your browser, prints the URL.",
    code: "ccremote start",
  },
  {
    n: "03",
    title: "Connect from anywhere",
    body: "Put it behind nginx with TLS. Works on phones, tablets, laptops.",
    code: "ccremote start --host 0.0.0.0",
  },
];

export function Quickstart() {
  return (
    <section className="border-b border-border py-24" id="quickstart">
      <div className="mx-auto max-w-6xl px-6">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">
          From zero to remote in 60 seconds.
        </h2>
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {steps.map((s) => (
            <div key={s.n} className="relative rounded-xl border border-border bg-card p-6">
              <div className="font-mono text-xs text-primary">{s.n}</div>
              <h3 className="mt-2 text-lg font-semibold">{s.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{s.body}</p>
              <pre className="mt-4 rounded-md bg-background p-3 font-mono text-xs">
                <code>{s.code}</code>
              </pre>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

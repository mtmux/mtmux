"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";

const cmds = {
  npm: "npm install -g ccremote\nccremote start",
  bun: "bun install -g ccremote\nccremote start",
  pnpm: "pnpm add -g ccremote\nccremote start",
  docker: "docker run -p 14100:14100 ghcr.io/nicholasgriffintn/ccremote",
};

export function Install() {
  const [tab, setTab] = useState<keyof typeof cmds>("npm");
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(cmds[tab]);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="border-b border-border py-24" id="install">
      <div className="mx-auto max-w-3xl px-6 text-center">
        <h2 className="text-3xl font-bold tracking-tight md:text-4xl">Install in one line.</h2>
        <p className="mt-3 text-muted-foreground">No clone, no .env, no Docker required.</p>
        <div className="mx-auto mt-8 max-w-2xl rounded-xl border border-border bg-card text-left">
          <div className="flex items-center justify-between border-b border-border px-2 py-1">
            <div className="flex">
              {(Object.keys(cmds) as Array<keyof typeof cmds>).map((k) => (
                <button
                  key={k}
                  onClick={() => setTab(k)}
                  className={`px-3 py-1.5 text-sm font-medium transition ${
                    tab === k ? "text-primary" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {k}
                </button>
              ))}
            </div>
            <button
              onClick={copy}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="overflow-x-auto p-5 font-mono text-sm leading-relaxed">
            <code>{cmds[tab]}</code>
          </pre>
        </div>
      </div>
    </section>
  );
}

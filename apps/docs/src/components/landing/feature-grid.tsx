import { Terminal, Smartphone, FolderTree, Lock, Wifi, Layers } from "lucide-react";

const features = [
  {
    icon: Terminal,
    title: "True terminal fidelity",
    body: "xterm.js with WebGL rendering, Unicode 11, and 256-color support. Your zsh prompt looks the same on your phone as it does on your laptop.",
  },
  {
    icon: Smartphone,
    title: "Built for mobile first",
    body: "Custom keyboard toolbar, swipe gestures, haptic feedback. Manage Claude Code from a coffee shop with one thumb.",
  },
  {
    icon: FolderTree,
    title: "Files & previews",
    body: "Lazy Monaco editor for code, syntax highlighting for 80+ languages, image previews. Browse and edit without dropping into vim.",
  },
  {
    icon: Lock,
    title: "Self-hosted, by you",
    body: "Your machine, your tmux sessions, your token. No third-party servers. Token auto-rotates with one command.",
  },
  {
    icon: Wifi,
    title: "One port, one upstream",
    body: "WebSocket and HTTP share a single port. Trivial to put behind nginx, Caddy, or Cloudflare Tunnel.",
  },
  {
    icon: Layers,
    title: "tmux, your way",
    body: "Lists, attaches, creates, and kills tmux sessions. Works with your existing workflow. Survives reconnects.",
  },
];

export function FeatureGrid() {
  return (
    <section className="border-b border-border py-24" id="features">
      <div className="mx-auto max-w-6xl px-6">
        <h2 className="max-w-2xl text-balance text-3xl font-bold tracking-tight md:text-4xl">
          Everything you need to keep coding when you&apos;re not at your desk.
        </h2>
        <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, body }) => (
            <div key={title} className="bg-card p-6 transition hover:bg-accent/40">
              <div className="mb-4 inline-flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon className="size-5" />
              </div>
              <h3 className="font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

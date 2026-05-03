export function AnimatedTerminal() {
  return (
    <div className="rounded-xl border border-border bg-card shadow-2xl shadow-primary/10">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="size-3 rounded-full bg-destructive/60" />
        <span className="size-3 rounded-full bg-yellow-500/60" />
        <span className="size-3 rounded-full bg-green-500/60" />
        <span className="ml-3 font-mono text-xs text-muted-foreground">ccremote — claude</span>
      </div>
      <div className="font-mono text-sm leading-relaxed p-5 min-h-[320px]">
        <div className="text-muted-foreground">
          <span className="text-primary">$</span> ccremote start
        </div>
        <div className="text-foreground">→ ccremote ready on http://localhost:14100</div>
        <div className="text-foreground">→ token saved to ~/.ccremote/config.json</div>
        <div className="mt-3 text-muted-foreground">
          <span className="text-primary">$</span> claude
        </div>
        <div className="mt-2 text-muted-foreground">
          <span className="inline-block overflow-hidden whitespace-nowrap align-bottom [animation:type_3s_steps(40)_1s_both]">
            Refactor the auth flow to use bearer tokens instead of cookies
          </span>
          <span className="ml-1 inline-block size-2 translate-y-[1px] bg-primary [animation:blink_1s_step-end_infinite]" />
        </div>
      </div>
      <style>{`
        @keyframes type { from { width: 0 } to { width: 100% } }
        @keyframes blink { 50% { opacity: 0 } }
      `}</style>
    </div>
  );
}

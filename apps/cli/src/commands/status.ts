import kleur from "kleur";
import * as serverState from "../server-state.js";

function ago(since: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - since) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export async function status(): Promise<void> {
  const state = await serverState.read();
  if (!state) {
    console.log("");
    console.log(kleur.dim("  No mtmux server is running here."));
    console.log(kleur.dim("  Start one with ") + kleur.bold("mtmux"));
    console.log("");
    return;
  }

  const rows: [string, string][] = [
    ["Status", kleur.green("running") + kleur.dim(`  pid ${state.pid}`)],
    ["Uptime", ago(state.startedAt)],
    ["Mode", state.mode === "tunnel" ? "tunnel + local" : "local only"],
    ["Local", state.localUrl],
  ];
  if (state.lanUrl) rows.push(["Network", state.lanUrl]);
  if (state.inviteUrl) rows.push(["Invite", state.inviteUrl]);
  rows.push(["Version", state.version]);

  const width = Math.max(...rows.map(([label]) => label.length));
  console.log("");
  for (const [label, value] of rows) {
    console.log(`  ${kleur.dim(label.padEnd(width))}  ${value}`);
  }
  console.log("");
  console.log(kleur.dim("  Stop it with ") + kleur.bold("mtmux stop"));
  console.log("");
}

export async function stop(): Promise<void> {
  const outcome = await serverState.stop();
  switch (outcome) {
    case "stopped":
      console.log(kleur.green("✓ Stopped."));
      return;
    case "not-running":
      console.log(kleur.dim("No mtmux server is running here."));
      return;
    case "denied":
      console.error(
        kleur.red("✗ That server belongs to another user — cannot stop it."),
      );
      process.exitCode = 1;
      return;
  }
}

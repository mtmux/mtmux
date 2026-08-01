import kleur from "kleur";
import * as serverState from "../server-state.js";
import { load as loadConfig } from "../config-store.js";
import { APPROVE_STATE_PATH } from "../approve-control.js";
import { DEVICES_PATH, type ConnectedDevice } from "../devices-control.js";

/**
 * Whether an `mtmux approve` window is open, or null.
 *
 * Null on **any** failure — a 404, a 401, a refused connection, a parse error.
 * A newer CLI is routinely pointed at an older daemon that has never heard of
 * this endpoint, and `status` losing a row is the right way for that to look.
 * An error message would make an upgrade seem broken.
 */
async function approvalWindow(port: number): Promise<string | null> {
  try {
    const cfg = await loadConfig();
    const res = await fetch(`http://127.0.0.1:${port}${APPROVE_STATE_PATH}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(1_500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      waiting?: boolean;
      expiresAt?: number | null;
    };
    if (!body.waiting || !body.expiresAt) return null;
    const left = Math.max(
      0,
      Math.round((body.expiresAt - Date.now()) / 60_000),
    );
    return kleur.green("open") + kleur.dim(`  ${left}m left`);
  } catch {
    return null;
  }
}

/**
 * Who is connected, or null.
 *
 * Null on any failure, for the same reason `approvalWindow` does it: a newer
 * CLI pointed at an older daemon has never heard of this endpoint, and losing
 * a row is how that should look. An error would make an upgrade seem broken.
 */
async function connectedDevices(port: number): Promise<string | null> {
  try {
    const cfg = await loadConfig();
    const res = await fetch(`http://127.0.0.1:${port}${DEVICES_PATH}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(1_500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      count?: number;
      devices?: ConnectedDevice[];
    };
    const devices = body.devices ?? [];
    if (devices.length === 0) return kleur.dim("none");
    const names = devices
      .map((d) =>
        d.readOnly ? `${d.label} ${kleur.dim("(read-only)")}` : d.label,
      )
      .join(", ");
    return `${kleur.green(String(devices.length))}  ${kleur.dim(names)}`;
  } catch {
    return null;
  }
}

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

  const devices = await connectedDevices(state.port);
  if (devices) rows.push(["Devices", devices]);

  const window = await approvalWindow(state.port);
  if (window) rows.push(["Approving", window]);

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

import kleur from "kleur";
import * as configStore from "../config-store.js";

/**
 * Browsers this machine has paired with.
 *
 * These are local records, not account records: a device is trusted by *this
 * server*, and revoking it here is what actually stops it reconnecting. The
 * dashboard shows the same list for signed-in users, but this command is the
 * one that works with no account and no network.
 */

function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export async function devicesList(): Promise<void> {
  const peers = await configStore.listPeers();
  if (peers.length === 0) {
    console.log("");
    console.log(kleur.dim("  No devices paired with this machine yet."));
    console.log(
      kleur.dim("  Run ") +
        kleur.bold("mtmux") +
        kleur.dim(" and scan the code."),
    );
    console.log("");
    return;
  }

  const labelWidth = Math.max(...peers.map((p) => p.label.length), 6);
  console.log("");
  for (const peer of peers) {
    const stale = configStore.isPeerExpired(peer);
    const dot = stale ? kleur.dim("○") : kleur.green("●");
    console.log(
      `  ${dot} ${peer.label.padEnd(labelWidth)}  ${kleur.dim(ago(peer.lastSeenAt))}` +
        `  ${kleur.dim(peer.deviceId)}` +
        (stale ? kleur.dim("  (stale)") : ""),
    );
  }
  console.log("");
  console.log(
    kleur.dim("  Revoke one with ") + kleur.bold("mtmux devices revoke <id>"),
  );
  console.log("");
}

export async function devicesRevoke(deviceId: string): Promise<void> {
  const removed = await configStore.removePeer(deviceId);
  if (!removed) {
    console.error(kleur.red(`✗ No device with id ${deviceId}.`));
    console.error(kleur.dim("  Run `mtmux devices` to see the list."));
    process.exitCode = 1;
    return;
  }
  console.log(kleur.green("✓ Revoked."));
  // Being honest about scope: forgetting the key stops future reconnects, but a
  // browser already attached keeps its live socket until the server restarts.
  console.log(
    kleur.dim("  It can no longer reconnect. Restart mtmux to drop it now."),
  );
}

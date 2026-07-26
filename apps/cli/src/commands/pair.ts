import os from "node:os";
import kleur from "kleur";
import { FrameSealer, utf8ToBytes, type SessionKeys } from "@repo/crypto";
import type { SealedDescriptor } from "@repo/protocol";
import * as configStore from "../config-store.js";
import { apiBase, discoverPublicIp } from "../api.js";
import { getLanAddresses } from "../lan.js";
import {
  pairWithCode,
  httpTransport,
  PairingError,
} from "../pairing-client.js";
import {
  createTunnelAgent,
  brokerConnector,
  localRelayConnector,
} from "../tunnel-agent.js";

export type PairOpts = {
  code?: string;
  port: number;
  api?: string;
  /**
   * Advertise no direct addresses, so the session can only ride the tunnel.
   *
   * Two uses. It keeps the machine's LAN topology out of the descriptor for
   * anyone who would rather the browser never learn it — the candidates are
   * sealed, but not sending them at all is stronger. And it makes the tunnel
   * path deterministically testable, which is otherwise awkward: whenever a
   * candidate happens to be reachable the direct path silently wins and the
   * tunnel goes unexercised.
   */
  tunnelOnly?: boolean;
};

/**
 * Candidate direct URLs, best first.
 *
 * These are sealed under the pairing key before they leave the machine, so the
 * broker never learns the user's LAN topology. The browser races them and
 * falls back to the tunnel, which is why an unreachable candidate costs a
 * timeout rather than a failure.
 */
export function buildCandidates(
  port: number,
  publicIp: string | null,
  interfaces = os.networkInterfaces(),
): string[] {
  const candidates = getLanAddresses(interfaces).map(
    ({ address }) => `http://${address}:${port}`,
  );
  if (publicIp) candidates.push(`http://${publicIp}:${port}`);
  return candidates.slice(0, 8);
}

export function deviceLabel(): string {
  const user = os.userInfo().username;
  return `${user}@${os.hostname()}`;
}

/**
 * Hand the derived direct-path token to the running relay.
 *
 * `mtmux pair` is a separate process from `mtmux start`, so the key it just
 * negotiated is not in the server's memory. This is the only channel between
 * them, and it is loopback-only and authenticated with the machine's own token.
 *
 * A failure here is not fatal: the tunnel path does not need it, so the session
 * still works — just always via the relay.
 */
export async function registerDirectToken(
  port: number,
  authToken: string,
  directToken: string,
): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_pair/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ token: directToken }),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function localServerIsUp(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Seal the descriptor for the browser using the CLI→browser frame key. */
export async function sealDescriptor(
  keys: SessionKeys,
  descriptor: SealedDescriptor,
): Promise<Uint8Array> {
  const sealer = new FrameSealer(keys.s2c, "s2c");
  return sealer.seal(utf8ToBytes(JSON.stringify(descriptor)));
}

export async function pair(opts: PairOpts): Promise<void> {
  const base = apiBase(opts.api);

  if (!opts.code) {
    console.log();
    console.log(`  ${kleur.bold("Pair a device")}`);
    console.log();
    console.log(`  1. Open ${kleur.red("https://app.mtmux.com/pair")}`);
    console.log("  2. Read the six digits it shows you");
    console.log(`  3. Run ${kleur.bold("mtmux pair <code>")} back here`);
    console.log();
    return;
  }

  if (!(await localServerIsUp(opts.port))) {
    console.error(
      kleur.red(`✗ Nothing is serving mtmux on port ${opts.port}.`),
    );
    console.error(
      kleur.dim(
        `  Start it first: ${kleur.bold("mtmux start")}` +
          (opts.port === 14100 ? "" : ` --port ${opts.port}`),
      ),
    );
    process.exitCode = 1;
    return;
  }

  const { config, key } = await configStore.ensureDeviceKey();
  const publicIp = opts.tunnelOnly ? null : await discoverPublicIp(base);

  // The tunnel has to be registered before the descriptor can name it, so the
  // agent starts first and pairing waits for its id.
  let onReady: (id: string) => void = () => {};
  const registered = new Promise<string>((resolve, reject) => {
    onReady = resolve;
    setTimeout(
      () => reject(new Error("Timed out registering with the pairing service")),
      15_000,
    ).unref?.();
  });

  const agent = createTunnelAgent({
    apiBase: base,
    deviceKey: key,
    connectBroker: brokerConnector(),
    connectLocal: localRelayConnector(opts.port, config.token),
    onTunnelReady: (id) => onReady(id),
    onStatus: (status, detail) => {
      if (status === "disconnected" && detail) {
        console.log(kleur.dim(`  tunnel: ${detail}`));
      }
    },
  });
  agent.start();

  let tunnelId: string;
  try {
    tunnelId = await registered;
  } catch (err) {
    agent.stop();
    console.error(
      kleur.red(`✗ ${err instanceof Error ? err.message : String(err)}`),
    );
    process.exitCode = 1;
    return;
  }

  console.log(kleur.dim("  Pairing…"));

  try {
    const result = await pairWithCode({
      code: opts.code,
      transport: httpTransport(base),
      buildDescriptor: (): SealedDescriptor => ({
        candidates: opts.tunnelOnly ? [] : buildCandidates(opts.port, publicIp),
        tunnelId,
        deviceId: key.deviceId,
        publicKey: Buffer.from(key.publicKey).toString("hex"),
        label: deviceLabel(),
      }),
      seal: sealDescriptor,
    });

    // The agent is the other end of the browser's seal, so it needs this
    // pairing's key schedule before the browser opens a stream. Registering it
    // here rather than passing it in at construction is what lets one agent
    // serve several paired browsers over the same tunnel.
    agent.addSessionKeys(result.keys);

    // Teach the local relay the direct-path token both sides derived, so a
    // browser that wins the candidate race can authenticate without ever being
    // sent the machine's 64-hex AUTH_TOKEN.
    await registerDirectToken(opts.port, config.token, result.keys.directToken);

    await configStore.addPeer({
      deviceId: result.peerDeviceId ?? `browser-${Date.now().toString(36)}`,
      publicKey: "",
      label: result.peerLabel,
      pairedAt: Date.now(),
      lastSeenAt: Date.now(),
    });

    console.log();
    console.log(kleur.green("  ✓ Paired."));
    console.log(
      kleur.dim(
        "    The device is connected. This process keeps the tunnel open —\n" +
          "    leave it running, or press Ctrl+C to stop remote access.",
      ),
    );
    console.log();
  } catch (err) {
    if (err instanceof PairingError) {
      console.error(kleur.red(`✗ ${err.message}`));
      if (err.hint) console.error(kleur.dim(`  ${err.hint}`));
    } else {
      console.error(
        kleur.red(`✗ ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    process.exitCode = 1;
    return;
  }

  const shutdown = () => {
    console.log("\n  Closing the tunnel…");
    agent.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

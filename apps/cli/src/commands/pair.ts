import os from "node:os";
import kleur from "kleur";
import { sealOnce, utf8ToBytes, type SessionKeys } from "@repo/crypto";
import type { GrantRecord, SealedDescriptor } from "@repo/protocol";
import { sanitizeLabel } from "@repo/protocol";
import * as configStore from "../config-store.js";
import { resolveApiBase, discoverPublicIp } from "../api.js";
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

/**
 * How this machine names itself to the browser it pairs with.
 *
 * Sanitised and bounded on the way *out*, not only on the way in. A username
 * or hostname is not attacker-controlled in the usual sense, but it is
 * unbounded, it is not ours to trust, and it lands in someone else's UI — and
 * the peer that receives it is entitled to the same guarantee we demand of the
 * labels we receive.
 */
export function deviceLabel(): string {
  const user = os.userInfo().username;
  return sanitizeLabel(`${user}@${os.hostname()}`);
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
  /**
   * Scope for the token, when there is one.
   *
   * Omitted by every ordinary pairing, which means the full grant — what a
   * token from `mtmux start` has always meant. Only `mtmux share` sends one.
   */
  grant?: GrantRecord,
  /**
   * Who just paired, and how, so already-connected browsers can be told.
   *
   * Optional because the relay defaults it: a caller that omits it still
   * produces a notice, just an anonymous one. Nothing security-relevant rides
   * on it — the token is what grants access, and this is only ever displayed.
   */
  notice?: { label: string; via: "code" | "request" },
  /**
   * How long the relay should keep honouring this token while it is in use.
   *
   * The relay's own default is a 24 h idle window, which is right for the
   * LAN-QR flow and wrong for a device paired by code: that device's trust
   * lives in the CLI's peer store and lasts 90 days, so leaving the relay on
   * its default is what cut a working phone off after a day. Pass the peer
   * record's remaining lifetime and the two views cannot diverge.
   */
  ttlMs?: number,
  /**
   * The peer record this token belongs to, when there is one.
   *
   * The relay hands it back through `onSessionTokenUsed` every time the device
   * authenticates, which is how `lastSeenAt` learns that a phone is still in
   * use. Omitted by `mtmux share`, whose tokens are not peers.
   */
  deviceId?: string,
): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/_pair/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        token: directToken,
        ...(grant ? { grant } : {}),
        ...(notice ?? {}),
        ...(ttlMs !== undefined ? { ttlMs } : {}),
        ...(deviceId ? { deviceId } : {}),
      }),
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

/**
 * Seal the descriptor for the browser under its own subkey.
 *
 * `sealOnce` rather than a bare `FrameSealer`: the descriptor gets both a
 * fresh salt and the `descriptor` purpose label, so it shares neither a key
 * nor a nonce with the tunnel frames that follow. It used to share both —
 * this function and `tunnel-agent.ts` each sealed under `s2c` at counter 0,
 * which handed the broker two ciphertexts under one nonce on every hosted
 * pairing, one of them a JSON object with a public schema.
 */
export async function sealDescriptor(
  keys: SessionKeys,
  descriptor: SealedDescriptor,
): Promise<Uint8Array> {
  return sealOnce(keys.s2c, "s2c", utf8ToBytes(JSON.stringify(descriptor)));
}

export async function pair(opts: PairOpts): Promise<void> {
  const base = await resolveApiBase(opts.api);

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
    connectLocal: localRelayConnector(opts.port),
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

    // Teach the local relay the direct-path token both sides derived, so a
    // browser that wins the candidate race can authenticate without ever being
    // sent the machine's 64-hex AUTH_TOKEN.
    //
    // This must happen BEFORE the agent will admit the keys. The tunnel agent
    // no longer authenticates the loopback socket with the machine's token, so
    // the browser's own `auth` frame is what the relay checks — and admitting
    // the keys first leaves a window where the browser can present a token the
    // relay has not yet been told about. A failure here therefore leaves the
    // keys unadmitted rather than half-paired.
    //
    // The lifetime handed over is the peer record's, not the relay's default:
    // trust for a device paired by code is owned by the CLI's peer store, and
    // a relay running a shorter clock of its own is what silently dropped a
    // working device a day later.
    const registered = await registerDirectToken(
      opts.port,
      config.token,
      result.keys.directToken,
      undefined,
      { label: result.peerLabel, via: "code" },
      configStore.PEER_EXPIRY_MS,
    );
    if (!registered) {
      agent.stop();
      console.error(
        kleur.red("✗ Paired, but the local server refused the session token."),
      );
      console.error(
        kleur.dim(
          `  Nothing was admitted. Check that ${kleur.bold("mtmux start")} is still` +
            ` running on port ${opts.port}, then pair again.`,
        ),
      );
      process.exitCode = 1;
      return;
    }

    // The agent is the other end of the browser's seal, so it needs this
    // pairing's key schedule before the browser opens a stream. Registering it
    // here rather than passing it in at construction is what lets one agent
    // serve several paired browsers over the same tunnel.
    agent.addSessionKeys(result.keys);

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

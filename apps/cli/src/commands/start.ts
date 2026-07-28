import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import kleur from "kleur";
import openBrowser from "open";
import * as configStore from "../config-store.js";
import * as serverState from "../server-state.js";
import { banner, renderBannerLines, type PairingInvite } from "../banner.js";
import { primaryLanAddress, type LanAddress } from "../lan.js";
import { checkTmux, checkNode } from "../preflight.js";
import { serve, type RelayRuntime } from "../serve.js";
import { apiBase } from "../api.js";
import {
  createTunnelAgent,
  brokerConnector,
  localRelayConnector,
  type TunnelAgent,
} from "../tunnel-agent.js";
import { hostPairing, type HostedPairing } from "../pairing-client.js";
import {
  buildCandidates,
  deviceLabel,
  registerDirectToken,
  sealDescriptor,
} from "./pair.js";
import * as account from "../account.js";

// The whole CLI is bundled into dist/bin.js, so this module's own directory IS
// dist/ at runtime — not dist/commands/, which is where tsc used to put it.
// The published layout puts the web standalone server at
// dist/web/apps/web/server.js and the relay bundle at dist/relay/runtime.js.
// See apps/cli/scripts/build.mjs.
const DIST_DIR = path.dirname(fileURLToPath(import.meta.url));

const WEB_DIR = path.resolve(DIST_DIR, "web/apps/web");
const RELAY_RUNTIME = path.resolve(DIST_DIR, "relay/runtime.js");

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const WILDCARD = new Set(["0.0.0.0", "::"]);

/** The QR code outlives the terminal scrollback; keep the nonce alive as long. */
const PAIRING_NONCE_TTL_MS = 24 * 60 * 60 * 1000;

/** How often a signed-in server tells the registry it is still here. */
const HEARTBEAT_MS = 30_000;

/** Long enough for a slow link, short enough that nobody stares at a blank screen. */
const TUNNEL_READY_TIMEOUT_MS = 15_000;

function cliVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.resolve(DIST_DIR, "../package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export type StartOpts = {
  port: number;
  /** Undefined means "decide for me" — see `resolveHost`. */
  host?: string;
  token?: string;
  open: boolean;
  allowedPaths?: string;
  /** LAN and loopback only. Never contacts a broker, by choice rather than by
   * accident — which is a different thing from the tunnel merely failing. */
  local: boolean;
  qr: boolean;
  name?: string;
  api?: string;
  json: boolean;
};

/**
 * Bind the LAN by default when there is one.
 *
 * The old default of 127.0.0.1 made the phone-on-the-couch case — the entire
 * point of the tool — require a restart with `--host 0.0.0.0`. The relay
 * refuses to serve a default/empty token on a non-loopback bind, and the CLI
 * always has a 32-byte random token, so opening up the bind does not open up
 * access.
 */
export function resolveHost(
  explicitHost: string | undefined,
  lan: LanAddress | null,
): string {
  if (explicitHost) return explicitHost;
  return lan ? "0.0.0.0" : "127.0.0.1";
}

/**
 * The address to actually show people, which is never the bind address:
 * "0.0.0.0" is not somewhere you can point a browser, and the old banner
 * rewrote it to "localhost", which is wrong on every device but this one.
 */
export function resolveLanUrl(
  host: string,
  port: number,
  lan: LanAddress | null,
): string | null {
  if (LOOPBACK.has(host)) return null;
  if (WILDCARD.has(host)) return lan ? `http://${lan.address}:${port}` : null;
  return `http://${host}:${port}`;
}

/**
 * Where the browser that scans the code should land.
 *
 * This is not the broker. The broker relays sealed frames; the *app* is what
 * renders the join page and the terminal, and on the hosted service they are
 * deliberately separate origins so a compromise of one is not a compromise of
 * the other.
 *
 * The `api.` → `app.` swap covers that hosted naming. It cannot cover a
 * self-hosted deployment, where the two origins are whatever the operator
 * chose — hence the override, which is the only way a self-hoster can print a
 * QR that points at their own app. Falling back to the broker origin is the
 * least-wrong default: a single-origin deployment serves both from there, and
 * anything else is unguessable.
 */
export function appOriginFor(base: string, env = process.env): string {
  const override = env.MTMUX_APP_URL;
  if (override) return override.replace(/\/+$/, "");
  if (base.includes("//api.")) return base.replace("//api.", "//app.");
  return base;
}

/** What the QR encodes. The code rides in the fragment, so it never reaches a server. */
export function joinUrl(appOrigin: string, code: string): string {
  return `${appOrigin}/j#${code}`;
}

type Hosted = {
  agent: TunnelAgent;
  invite: PairingInvite;
  stop: () => void;
};

/**
 * Bring up the tunnel and arm a pairing code.
 *
 * Ordering matters: the tunnel must be registered before a code is offered,
 * because the descriptor the CLI seals at the end of the handshake has to name
 * a tunnel that already exists. Arming the code first would produce a race in
 * which a very fast phone pairs against a tunnel id that is still undefined.
 */
async function startHosted(opts: {
  port: number;
  base: string;
  cfg: configStore.Config;
  tunnelOnly: boolean;
  onPaired: (label: string) => void;
  onRearm: (invite: PairingInvite) => void;
}): Promise<Hosted> {
  const { key } = await configStore.ensureDeviceKey();

  // The agent signals readiness through a callback rather than a promise, so
  // wrap it in one — nothing below can run until the tunnel has an id.
  let announce!: (tunnelId: string) => void;
  let abandon!: (err: Error) => void;
  const ready = new Promise<string>((resolve, reject) => {
    announce = resolve;
    abandon = reject;
  });

  const agent = createTunnelAgent({
    apiBase: opts.base,
    deviceKey: key,
    connectBroker: brokerConnector(),
    connectLocal: localRelayConnector(opts.port, opts.cfg.token),
    onTunnelReady: announce,
  });
  agent.start();

  const timer = setTimeout(
    () => abandon(new Error("the broker did not answer")),
    TUNNEL_READY_TIMEOUT_MS,
  );
  let tunnelId: string;
  try {
    tunnelId = await ready;
  } catch (err) {
    // Leave nothing retrying in the background once we have given up on it.
    agent.stop();
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const appOrigin = appOriginFor(opts.base);

  // One armed code at a time, re-minted after each successful pairing: a code
  // is single-use, and leaving a spent one on screen is worse than no code.
  const arm = async (): Promise<PairingInvite> => {
    const pairing: HostedPairing = await hostPairing({
      apiBase: opts.base,
      buildDescriptor: () => ({
        candidates: opts.tunnelOnly ? [] : buildCandidates(opts.port, null),
        tunnelId,
        deviceId: key.deviceId,
        publicKey: Buffer.from(key.publicKey).toString("hex"),
        label: deviceLabel(),
      }),
      seal: sealDescriptor,
    });

    void pairing.paired
      .then(async (result) => {
        agent.addSessionKeys(result.keys);
        await registerDirectToken(
          opts.port,
          opts.cfg.token,
          result.keys.directToken,
        );
        await configStore.addPeer({
          deviceId: result.peerDeviceId ?? `browser-${Date.now().toString(36)}`,
          publicKey: result.peerPublicKey ?? "",
          label: result.peerLabel,
          pairedAt: Date.now(),
          lastSeenAt: Date.now(),
          directToken: result.keys.directToken,
        });
        opts.onPaired(result.peerLabel);
        opts.onRearm(await arm());
      })
      .catch(() => {
        // A failed handshake burns the code by design. Offer a fresh one
        // rather than leaving the server unreachable to the next device.
        void arm()
          .then(opts.onRearm)
          .catch(() => {});
      });

    return {
      code: pairing.code,
      url: joinUrl(appOrigin, pairing.code),
      host: appOrigin.replace(/^https?:\/\//, ""),
    };
  };

  const invite = await arm();
  return { agent, invite, stop: () => agent.stop() };
}

/**
 * Re-admit every device that has paired with this machine before.
 *
 * The relay holds session tokens in memory, so without this a restart silently
 * un-pairs every phone that ever connected — and "restart" includes a deploy, a
 * crash and a reboot. Replaying the tokens we already negotiated turns a paired
 * device into what the word implies: trusted until revoked.
 *
 * Expired and revoked peers are skipped, and a failure is ignored — the device
 * simply pairs again, which is the pre-existing behaviour.
 */
async function restoreTrustedDevices(
  port: number,
  authToken: string,
): Promise<number> {
  const peers = await configStore.listPeers();
  let restored = 0;
  for (const peer of peers) {
    if (!peer.directToken || configStore.isPeerExpired(peer)) continue;
    if (await registerDirectToken(port, authToken, peer.directToken)) {
      restored += 1;
    }
  }
  return restored;
}

/**
 * Keep the registry's view of this machine fresh.
 *
 * Every failure is swallowed. A machine whose owner's card expired, or whose
 * network dropped, must keep serving its own terminal — the registry is a
 * convenience layered on top, never a licence check.
 */
function startHeartbeat(
  base: string,
  token: string,
  serverId: string,
): () => void {
  const timer = setInterval(() => {
    void account.heartbeat(base, token, serverId);
  }, HEARTBEAT_MS);
  timer.unref();
  return () => clearInterval(timer);
}

async function registerWithAccount(
  base: string,
  name: string,
  publicKey: string,
): Promise<(() => void) | null> {
  const signedIn = await configStore.getAccount(base);
  if (!signedIn) return null;

  try {
    const result = await account.registerServer(base, signedIn.token, {
      name,
      publicKey,
      hostname: os.hostname(),
      platform: `${process.platform}-${process.arch}`,
      cliVersion: cliVersion(),
    });
    if (!result.ok) {
      console.log(kleur.yellow(`  ! ${result.reason}`));
      if (result.upgradeUrl) {
        console.log(kleur.dim(`    ${result.upgradeUrl}`));
      }
      return null;
    }
    await configStore.setAccount({ ...signedIn, serverId: result.serverId });
    return startHeartbeat(base, signedIn.token, result.serverId);
  } catch {
    // Being signed in must never be worse than being anonymous.
    return null;
  }
}

export async function start(opts: StartOpts) {
  checkNode();
  await checkTmux();

  const version = cliVersion();
  const lan = primaryLanAddress();
  const host = resolveHost(opts.host, lan);
  const base = apiBase(opts.api);

  const cfg = opts.token ? { token: opts.token } : await configStore.load();
  // Relay reads these on first import. Set BEFORE we import relay modules.
  process.env.AUTH_TOKEN = cfg.token;
  process.env.ALLOWED_PATHS =
    opts.allowedPaths ??
    process.env.ALLOWED_PATHS ??
    process.env.HOME ??
    process.cwd();
  (process.env as Record<string, string>).NODE_ENV = "production";
  process.env.RELAY_HOST = host;
  process.env.RELAY_PORT = String(opts.port);
  // Single-origin in CLI mode — no cross-origin requests possible. Set the
  // CORS allow-list to empty so the relay's prod gate doesn't reject the
  // localhost default.
  if (process.env.CORS_ORIGINS === undefined) process.env.CORS_ORIGINS = "";

  const [relay, nextMod] = await Promise.all([
    import(RELAY_RUNTIME) as Promise<RelayRuntime>,
    import("next"),
  ]);

  const nextFactory = (
    nextMod as unknown as { default: typeof import("next").default }
  ).default;
  const app = nextFactory({ dev: false, dir: WEB_DIR });
  await app.prepare();

  const { shutdown: stopServing } = await serve({
    relay,
    requestHandler: app.getRequestHandler(),
    port: opts.port,
    host,
    portHintCommand: "mtmux start",
  });

  const localUrl = `http://localhost:${opts.port}`;
  const lanUrl = resolveLanUrl(host, opts.port, lan);

  const restored = await restoreTrustedDevices(opts.port, cfg.token);

  // Tokenless LAN sign-in only makes sense for a *different* device, so the
  // nonce is armed exactly when there is an address such a device could reach.
  const armLanNonce = () =>
    lanUrl
      ? `${lanUrl}/login#n=${relay.issuePairingNonce(PAIRING_NONCE_TTL_MS).nonce}`
      : null;

  let hosted: Hosted | null = null;
  let note: string | null = null;

  const lanInterface = WILDCARD.has(host) ? (lan?.iface ?? null) : null;

  const record = (inviteUrl: string | null): serverState.ServerState => ({
    pid: process.pid,
    port: opts.port,
    host,
    localUrl,
    lanUrl,
    mode: hosted ? "tunnel" : "local",
    inviteUrl,
    startedAt: Date.now(),
    version,
  });

  const reprint = (invite: PairingInvite) => {
    for (const line of renderBannerLines({
      version,
      localUrl,
      lanUrl,
      lanInterface,
      invite,
      showQr: opts.qr,
      token: cfg.token,
      note,
    })) {
      console.log(line);
    }
  };

  if (!opts.local) {
    try {
      hosted = await startHosted({
        port: opts.port,
        base,
        cfg,
        tunnelOnly: false,
        onPaired: (label) => {
          console.log(kleur.green(`  ✓ ${label} connected.`));
        },
        onRearm: (invite) => {
          console.log(
            kleur.dim("    Here's a fresh code for the next device:"),
          );
          reprint(invite);
          void serverState.write(record(invite.url)).catch(() => {});
        },
      });
    } catch (err) {
      // The tunnel is a convenience, not a dependency. An offline machine, a
      // blocked outbound connection or a broker outage must all land here and
      // leave a working LAN server behind — this is what keeps `mtmux start`
      // identical to its self-hosted behaviour when our servers are absent.
      note =
        `Tunnel unavailable (${(err as Error).message}). ` +
        `Serving locally — retry later or use --local to skip this.`;
    }
  }

  const lanQrPayload = hosted ? null : armLanNonce();

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          version,
          localUrl,
          lanUrl,
          mode: hosted ? "tunnel" : "local",
          code: hosted?.invite.code ?? null,
          joinUrl: hosted?.invite.url ?? null,
          trustedDevices: restored,
          token: cfg.token,
          note,
        },
        null,
        2,
      ),
    );
  } else {
    banner({
      version,
      localUrl,
      lanUrl,
      lanInterface,
      invite: hosted?.invite ?? null,
      lanQrPayload,
      showQr: opts.qr,
      token: cfg.token,
      note,
    });
  }

  if (restored > 0 && !opts.json) {
    console.log(
      kleur.dim(
        `  ${restored} device${restored === 1 ? "" : "s"} already trusted — ` +
          `${restored === 1 ? "it does" : "they do"} not need the code.`,
      ),
    );
    console.log("");
  }

  await serverState.write(record(hosted?.invite.url ?? null));

  // A LAN nonce is single-use, so once a phone has signed in the code on screen
  // is spent. Mint another and reprint rather than leaving a dead QR up.
  if (!hosted && lanUrl) {
    relay.onPairingRedeemed(() => {
      console.log(kleur.green("  ✓ Device signed in."));
      console.log(kleur.dim("    Here's a fresh code for the next one:"));
      for (const line of renderBannerLines({
        version,
        localUrl,
        lanUrl,
        lanInterface,
        lanQrPayload: armLanNonce(),
        showQr: opts.qr,
        token: cfg.token,
      })) {
        console.log(line);
      }
    });
  }

  const { key } = await configStore.ensureDeviceKey();
  const stopHeartbeat = await registerWithAccount(
    base,
    opts.name ?? cfg.serverName ?? os.hostname(),
    Buffer.from(key.publicKey).toString("hex"),
  );
  if (opts.name) await configStore.setServerName(opts.name);

  if (opts.open) {
    // Auto-open with the token in the URL *fragment* (never the query): the
    // fragment is never sent to the server or logged, and the login page reads
    // it on mount to auto-authenticate — no manual copy-paste.
    const openUrl = `${localUrl}/login#token=${encodeURIComponent(cfg.token)}`;
    await openBrowser(openUrl).catch(() => {});
  }

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    console.log("\n  Stopping…");
    stopHeartbeat?.();
    hosted?.stop();
    void serverState.clear();
    stopServing();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

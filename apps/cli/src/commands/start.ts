import path from "node:path";
import { fileURLToPath } from "node:url";
import kleur from "kleur";
import openBrowser from "open";
import * as configStore from "../config-store.js";
import { banner, renderBannerLines } from "../banner.js";
import { primaryLanAddress, type LanAddress } from "../lan.js";
import { checkTmux, checkNode } from "../preflight.js";
import { serve, type RelayRuntime } from "../serve.js";

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

export type StartOpts = {
  port: number;
  /** Undefined means "decide for me" — see `resolveHost`. */
  host?: string;
  token?: string;
  open: boolean;
  allowedPaths?: string;
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

export async function start(opts: StartOpts) {
  checkNode();
  await checkTmux();

  const lan = primaryLanAddress();
  const host = resolveHost(opts.host, lan);

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

  // Tokenless sign-in only makes sense for a *different* device, so the QR is
  // armed exactly when there is an address such a device could reach.
  const armPairing = () =>
    lanUrl
      ? `${lanUrl}/login#n=${relay.issuePairingNonce(PAIRING_NONCE_TTL_MS).nonce}`
      : null;

  banner({
    localUrl,
    lanUrl,
    lanInterface: WILDCARD.has(host) ? (lan?.iface ?? null) : null,
    qrPayload: armPairing(),
    token: cfg.token,
  });

  // A nonce is single-use, so once a phone has signed in the code on screen is
  // spent. Mint another and reprint, rather than leaving a dead QR up.
  if (lanUrl) {
    relay.onPairingRedeemed(() => {
      console.log(kleur.green("  ✓ Device signed in."));
      console.log(kleur.dim("    Here's a fresh code for the next one:"));
      for (const line of renderBannerLines({
        localUrl,
        lanUrl,
        lanInterface: WILDCARD.has(host) ? (lan?.iface ?? null) : null,
        qrPayload: armPairing(),
        token: cfg.token,
      })) {
        console.log(line);
      }
    });
  }

  if (opts.open) {
    // Auto-open with the token in the URL *fragment* (never the query): the
    // fragment is never sent to the server or logged, and the login page reads
    // it on mount to auto-authenticate — no manual copy-paste. The banner above
    // still prints the token for the --no-open / manual / mobile flow.
    const openUrl = `${localUrl}/login#token=${encodeURIComponent(cfg.token)}`;
    await openBrowser(openUrl).catch(() => {});
  }

  const shutdown = () => {
    console.log("\n  Stopping…");
    stopServing();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

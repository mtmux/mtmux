/**
 * Single-port dev server.
 *
 * Runs Next.js (dev + Turbopack, so HMR works) and the relay in ONE process on
 * ONE port — the same topology `mtmux start` ships. Both go through
 * `src/serve.ts`, so the single-port wiring is exercised every time anyone runs
 * `pnpm dev` instead of only at release.
 *
 * Run through tsx (see the `dev` script in package.json): it imports the CLI's
 * own TypeScript sources and the relay source directly, so there is no build
 * step and no bundle to fall out of date. The relay is imported by *relative
 * path* on purpose — its npm deps then resolve out of apps/relay/node_modules,
 * exactly as they do when the relay runs standalone.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import kleur from "kleur";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_DIR = path.resolve(__dirname, "..");
const REPO = path.resolve(CLI_DIR, "../..");
const WEB_DIR = path.join(REPO, "apps/web");

const PORT = Number(process.env.PORT ?? process.env.RELAY_PORT ?? 14100);
const HOST = process.env.HOST ?? process.env.RELAY_HOST ?? "127.0.0.1";

// The relay reads config on first import — set env BEFORE importing it.
//
// Dev deliberately does NOT use ~/.mtmux/config.json: rotating your real
// token because you ran `pnpm dev` would be surprising, and a fixed dev token
// keeps a browser session logged in across restarts. It never leaves loopback
// unless you set HOST yourself.
process.env.AUTH_TOKEN ??= "dev-token";
process.env.ALLOWED_PATHS ??= process.env.HOME ?? REPO;
process.env.RELAY_HOST = HOST;
process.env.RELAY_PORT = String(PORT);
// Single-origin, so there are no cross-origin requests to allow.
process.env.CORS_ORIGINS ??= "";
// CRITICAL: Next inlines NEXT_PUBLIC_* into the client bundle. A developer's
// .env pointing at the split deployment (ws://localhost:14300) would send the
// browser to a port nothing is listening on. Force same-origin.
process.env.NEXT_PUBLIC_RELAY_URL = "";

const [relay, nextMod, { serve }, { checkTmux, checkNode }] = await Promise.all(
  [
    import("../../relay/src/runtime.ts"),
    import("next"),
    import("../src/serve.ts"),
    import("../src/preflight.ts"),
  ],
);

checkNode();
await checkTmux();

const app = nextMod.default({
  dev: true,
  turbopack: true,
  dir: WEB_DIR,
  hostname: HOST,
  port: PORT,
});
await app.prepare();

// Dev only: Next serves HMR over a WebSocket upgrade, so non-/_relay upgrades
// have to reach it instead of being destroyed.
//
// Use `app.upgradeHandler`, NOT the public `getUpgradeHandler()`. In dev the
// latter returns NextNodeServer's handler, which knows nothing about
// /_next/webpack-hmr — that lives on the router server — so it accepts the
// socket and never answers. Chromium serialises WebSocket handshakes per host,
// so one permanently-pending HMR handshake also blocks /_relay from ever being
// attempted: the terminal sits on "Connecting…" forever. `upgradeHandler` is
// the same handler Next's own custom-server path installs.
const upgradeHandler = app.upgradeHandler;
if (typeof upgradeHandler !== "function") {
  throw new Error(
    "next: app.upgradeHandler is missing — Next's internals changed. " +
      "Without it HMR upgrades hang and block the relay socket.",
  );
}

const { shutdown } = await serve({
  relay,
  requestHandler: app.getRequestHandler(),
  upgradeHandler,
  port: PORT,
  host: HOST,
  portHintCommand: "PORT=<n> pnpm dev",
});

const visibleHost = HOST === "0.0.0.0" ? "localhost" : HOST;
const url = `http://${visibleHost}:${PORT}`;
console.log();
console.log(
  `  ${kleur.red().bold("›  mtmux dev")}${kleur.dim("  web + relay, one port")}`,
);
console.log();
console.log(`  ${kleur.bold("URL")}      ${kleur.red(url)}`);
console.log(
  `  ${kleur.bold("Login")}    ${kleur.dim(`${url}/login#token=${encodeURIComponent(process.env.AUTH_TOKEN)}`)}`,
);
console.log(`  ${kleur.bold("Token")}    ${kleur.dim(process.env.AUTH_TOKEN)}`);
console.log();

const stop = () => {
  console.log("\n  Stopping…");
  shutdown();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

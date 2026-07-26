import path from "node:path";
import { fileURLToPath } from "node:url";
import openBrowser from "open";
import * as configStore from "../config-store.js";
import { banner } from "../banner.js";
import { checkTmux, checkNode } from "../preflight.js";
import { serve, type RelayRuntime } from "../serve.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In the published package layout (dist/), the bundled web standalone server
// is at dist/web/apps/web/server.js, and the relay runtime is bundled into a
// single file at dist/relay/runtime.js. See apps/cli/scripts/build.mjs.
const WEB_DIR = path.resolve(__dirname, "../web/apps/web");
const RELAY_RUNTIME = path.resolve(__dirname, "../relay/runtime.js");

export type StartOpts = {
  port: number;
  host: string;
  token?: string;
  open: boolean;
  allowedPaths?: string;
};

export async function start(opts: StartOpts) {
  checkNode();
  await checkTmux();

  const cfg = opts.token ? { token: opts.token } : await configStore.load();
  // Relay reads these on first import. Set BEFORE we import relay modules.
  process.env.AUTH_TOKEN = cfg.token;
  process.env.ALLOWED_PATHS =
    opts.allowedPaths ??
    process.env.ALLOWED_PATHS ??
    process.env.HOME ??
    process.cwd();
  (process.env as Record<string, string>).NODE_ENV = "production";
  process.env.RELAY_HOST = opts.host;
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
    host: opts.host,
    portHintCommand: "mtmux start",
  });

  const visibleHost = opts.host === "0.0.0.0" ? "localhost" : opts.host;
  const url = `http://${visibleHost}:${opts.port}`;
  banner({ url, token: cfg.token, host: opts.host, port: opts.port });

  if (opts.open) {
    // Auto-open with the token in the URL *fragment* (never the query): the
    // fragment is never sent to the server or logged, and the login page reads
    // it on mount to auto-authenticate — no manual copy-paste. The banner above
    // still prints the token for the --no-open / manual / mobile flow.
    const openUrl = `${url}/login#token=${encodeURIComponent(cfg.token)}`;
    await openBrowser(openUrl).catch(() => {});
  }

  const shutdown = () => {
    console.log("\n  Stopping…");
    stopServing();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

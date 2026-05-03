import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import openBrowser from "open";
import * as configStore from "../config-store.js";
import { banner } from "../banner.js";
import { checkTmux, checkNode } from "../preflight.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In the published package layout (dist/), the bundled web standalone server
// is at dist/web/apps/web/server.js, and the relay's compiled sources are at
// dist/relay/. See apps/cli/scripts/build.mjs.
const WEB_DIR = path.resolve(__dirname, "../web/apps/web");
const RELAY_DIR = path.resolve(__dirname, "../relay");
const RELAY_PATH = "/_relay";

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
    opts.allowedPaths ?? process.env.ALLOWED_PATHS ?? process.env.HOME ?? process.cwd();
  (process.env as Record<string, string>).NODE_ENV = "production";
  process.env.RELAY_HOST = opts.host;
  process.env.RELAY_PORT = String(opts.port);

  type WsServerModule = {
    createWsServerNoBind: () => import("ws").WebSocketServer;
    attachUpgrade: (
      server: http.Server,
      wss: import("ws").WebSocketServer,
      path: string,
    ) => void;
  };
  type WireModule = {
    wireConnections: (wss: import("ws").WebSocketServer) => { shutdown: () => void };
  };
  type RelayHttpModule = {
    handleRelayRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
  };

  const [wsMod, wireMod, relayHttp, nextMod] = await Promise.all([
    import(path.join(RELAY_DIR, "ws-server.js")) as Promise<WsServerModule>,
    import(path.join(RELAY_DIR, "wire-connections.js")) as Promise<WireModule>,
    import(path.join(RELAY_DIR, "server.js")) as Promise<RelayHttpModule>,
    import("next"),
  ]);
  const { createWsServerNoBind, attachUpgrade } = wsMod;
  const { wireConnections } = wireMod;
  const { handleRelayRequest } = relayHttp;

  const nextFactory = (nextMod as unknown as { default: typeof import("next").default }).default;
  const app = nextFactory({ dev: false, dir: WEB_DIR });
  await app.prepare();
  const handler = app.getRequestHandler();

  const server = http.createServer(async (req, res) => {
    // Relay HTTP endpoints take priority (/health, /file?...)
    const handled = await handleRelayRequest(req, res);
    if (handled) return;
    await handler(req, res);
  });

  const wss = createWsServerNoBind();
  wireConnections(wss);
  attachUpgrade(server, wss, RELAY_PATH);

  await new Promise<void>((resolve) => server.listen(opts.port, opts.host, resolve));

  const visibleHost = opts.host === "0.0.0.0" ? "localhost" : opts.host;
  const url = `http://${visibleHost}:${opts.port}`;
  banner({ url, token: cfg.token, host: opts.host, port: opts.port });

  if (opts.open) await openBrowser(url).catch(() => {});

  const shutdown = () => {
    console.log("\n  Stopping…");
    server.close(() => process.exit(0));
    wss.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

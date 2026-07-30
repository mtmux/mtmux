import http from "node:http";
import type { Duplex } from "node:stream";
import kleur from "kleur";

export const RELAY_PATH = "/_relay";

/**
 * The subset of `apps/relay/src/runtime.ts` this module needs. Passed in rather
 * than imported so the same assembly works against the esbuild bundle (`start`)
 * and the raw TypeScript source (`scripts/dev.mjs`, via tsx).
 */
export type RelayRuntime = {
  createWsServerNoBind: () => import("ws").WebSocketServer;
  attachUpgrade: (
    server: http.Server,
    wss: import("ws").WebSocketServer,
    path: string,
    fallback?: (
      req: http.IncomingMessage,
      socket: Duplex,
      head: Buffer,
    ) => void,
  ) => void;
  wireConnections: (wss: import("ws").WebSocketServer) => {
    shutdown: () => void;
  };
  handleRelayRequest: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<boolean>;
  /** Arms tokenless local pairing and returns the nonce for the QR. */
  issuePairingNonce: (ttlMs?: number) => { nonce: string; expiresAt: number };
  /** Fires when a device redeems the nonce, so the CLI can reprint a code. */
  onPairingRedeemed: (listener: () => void) => () => void;
};

export type ServeOptions = {
  relay: RelayRuntime;
  /** Next's request handler, from an already-prepared app. */
  requestHandler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<void> | void;
  /**
   * Next's upgrade handler. Required in dev — HMR runs over a WebSocket — and
   * deliberately omitted in production, where the relay is the only upgrade.
   */
  upgradeHandler?: (
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => void;
  port: number;
  host: string;
  /** Command to suggest in the "port in use" hint, e.g. "mtmux start". */
  portHintCommand: string;
  /**
   * CLI-owned HTTP endpoints, tried before the relay's.
   *
   * This exists for `mtmux approve`, which is a second process and therefore
   * cannot reach the daemon's memory any other way — the same problem
   * `registerDirectToken` solves by POSTing to `/_pair/session`. Putting the
   * hook here rather than in the relay keeps a CLI-only feature out of the
   * relay package, which is also shipped standalone.
   *
   * Returns true when it handled the request.
   */
  controlHandler?: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<boolean>;
};

export type Serving = {
  server: http.Server;
  shutdown: () => void;
};

/**
 * Bind web + relay to a single port.
 *
 * This is the whole point of the CLI, and dev goes through it too, so a bug in
 * the single-port wiring can't hide until release.
 */
export async function serve(opts: ServeOptions): Promise<Serving> {
  const { relay } = opts;

  const server = http.createServer(async (req, res) => {
    // CLI control endpoints first — they are loopback-and-token guarded and
    // must not be shadowed by anything the relay or Next might claim.
    if (opts.controlHandler && (await opts.controlHandler(req, res))) return;
    // Relay HTTP endpoints take priority (/health, /file?...)
    const handled = await relay.handleRelayRequest(req, res);
    if (handled) return;
    await opts.requestHandler(req, res);
  });

  const wss = relay.createWsServerNoBind();
  const { shutdown: shutdownConnections } = relay.wireConnections(wss);
  relay.attachUpgrade(server, wss, RELAY_PATH, opts.upgradeHandler);

  // Next.js's NextServer lazily registers its own `upgrade` listener on the
  // first request (it routes to its internal upgradeHandler, used for HMR in
  // dev). In our embedded setup that listener fires alongside ours on every
  // /_relay upgrade and destroys the socket because the path is unknown to
  // Next — clients see a successful WS open immediately followed by close
  // code 1006. Block any subsequent `upgrade` listener registration so only
  // attachUpgrade above ever runs; in dev we invoke Next's handler ourselves
  // via `upgradeHandler`, so HMR still works.
  const origOn = server.on.bind(server);
  const origAddListener = server.addListener.bind(server);
  const origPrepend = server.prependListener.bind(server);
  function guard<T extends (...a: never[]) => unknown>(method: T): T {
    return ((event: string, listener: (...args: unknown[]) => void) => {
      if (event === "upgrade") return server;
      return (method as unknown as (e: string, l: unknown) => unknown)(
        event,
        listener,
      );
    }) as unknown as T;
  }
  server.on = guard(origOn);
  server.addListener = guard(origAddListener);
  server.prependListener = guard(origPrepend);

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(opts.port, opts.host);
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      console.error(
        kleur.red(`✗ Port ${opts.port} is already in use on ${opts.host}.`),
      );
      console.error(
        kleur.dim(
          `  Try another port: ${kleur.bold(`${opts.portHintCommand} --port ${opts.port + 1}`)}`,
        ),
      );
      console.error(
        kleur.dim(
          `  Or stop whatever is on it: ${kleur.bold(`lsof -i :${opts.port}`)} (macOS/Linux)`,
        ),
      );
    } else if (e.code === "EACCES") {
      console.error(
        kleur.red(`✗ Permission denied binding to ${opts.host}:${opts.port}.`),
      );
      console.error(
        kleur.dim(
          "  Ports < 1024 require elevated privileges. Pick a higher port.",
        ),
      );
    } else {
      console.error(kleur.red(`✗ ${e.message}`));
    }
    wss.close();
    process.exit(1);
  }

  return {
    server,
    shutdown: () => {
      shutdownConnections();
      server.close(() => process.exit(0));
      wss.close();
    },
  };
}

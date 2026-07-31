#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { start, type StartOpts } from "./commands/start.js";
import { pair } from "./commands/pair.js";
import { share, shareList, shareRevoke } from "./commands/share.js";
import { parseFiles } from "./share-grants.js";
import { tokenPrint, tokenRotate, tokenSet } from "./commands/token.js";
import { version } from "./commands/version.js";
import { doctor } from "./commands/doctor.js";
import { status, stop } from "./commands/status.js";
import { approve } from "./commands/approve.js";
import { devicesList, devicesRevoke } from "./commands/devices.js";
import { login, logout, servers, upgrade, whoami } from "./commands/account.js";
import { logs } from "./commands/logs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
) as { version: string };

const program = new Command();

program
  .name("mtmux")
  .description("tmux in your browser. One command, any device.")
  .version(pkg.version)
  // Global, because the relay's log level is a property of the process rather
  // than of any one command. Both write to stderr, never stdout, so `--json`
  // stays a parseable document.
  .option("--verbose", "mirror the relay log to stderr while running")
  .option(
    "--log-level <level>",
    "trace | debug | info | warn | error | fatal (default: info)",
  );

/** Flags that belong to the program rather than to a command. */
type GlobalFlags = { verbose?: boolean; logLevel?: string };

type StartFlags = {
  port: number;
  host?: string;
  token?: string;
  open: boolean;
  allowedPaths?: string;
  local?: boolean;
  qr: boolean;
  name?: string;
  api?: string;
  json?: boolean;
  share?: string;
  readOnly?: boolean;
  files?: string;
};

const toStartOpts = (opts: StartFlags, local: boolean): StartOpts => ({
  port: opts.port,
  host: opts.host,
  token: opts.token,
  open: opts.open,
  allowedPaths: opts.allowedPaths,
  local: local || opts.local === true,
  qr: opts.qr,
  name: opts.name,
  api: opts.api,
  json: opts.json === true,
  share: opts.share,
  shareReadOnly: opts.readOnly === true,
  shareFiles: parseFiles(opts.files) ?? "none",
  ...(program.opts<GlobalFlags>() as GlobalFlags),
});

/**
 * `start` is the default command, so `mtmux` on its own does the useful thing.
 *
 * It serves the terminal *and* opens a sealed tunnel, because the common case
 * is a phone that is not on the same network as the machine. `--local` opts out
 * of the tunnel entirely for people who would rather no traffic left the
 * building — and when the broker simply cannot be reached, `start` degrades to
 * exactly that rather than failing.
 */
program
  .command("start", { isDefault: true })
  .description("Serve this machine's tmux and print a code to open it")
  .option("-p, --port <number>", "port", (v) => parseInt(v, 10), 14100)
  // No default: `start` picks 0.0.0.0 when there is a real LAN to serve and
  // 127.0.0.1 otherwise. An explicit --host always wins.
  .option(
    "-h, --host <address>",
    "bind address (default: 0.0.0.0 on a LAN, else 127.0.0.1)",
  )
  .option("--local", "LAN and loopback only — never contact a broker")
  .option("--no-qr", "print the code without the QR block")
  .option("-n, --name <label>", "what to call this machine")
  .option("-t, --token <value>", "override the auth token for this run")
  .option("--allowed-paths <paths>", "comma-separated path allow-list")
  .option("--no-open", "don't open the browser on this machine")
  .option("--api <url>", "pairing service base URL")
  .option("--json", "print a machine-readable startup record")
  .option(
    "--share <sessions>",
    "scope the printed code to these tmux sessions (comma-separated)",
  )
  .option("--read-only", "with --share: they can watch, and cannot type")
  .option("--files <level>", "with --share: none | ro | rw (default: none)")
  .action((opts: StartFlags) => start(toStartOpts(opts, false)));

program
  .command("local")
  .description("Serve on this network only, with no tunnel")
  .option("-p, --port <number>", "port", (v) => parseInt(v, 10), 14100)
  .option("-h, --host <address>", "bind address")
  .option("--no-qr", "print without the QR block")
  .option("-t, --token <value>", "override the auth token for this run")
  .option("--allowed-paths <paths>", "comma-separated path allow-list")
  .option("--no-open", "don't open the browser on this machine")
  .option("--json", "print a machine-readable startup record")
  .action((opts: StartFlags) => start(toStartOpts(opts, true)));

/**
 * `mtmux logs` — where the relay's output went.
 *
 * It used to print over the banner, because the relay runs in this process and
 * its logger writes to fd 1. Moving it to `~/.mtmux/logs/mtmux.log` is only
 * defensible if there is a way to read it back.
 */
program
  .command("logs")
  .description("Show the relay log")
  .option("-n, --lines <count>", "how many lines", (v) => parseInt(v, 10), 200)
  .option("-f, --follow", "keep printing new lines until Ctrl+C")
  .option("--json", "print the raw NDJSON instead of formatting it")
  .action((opts: { lines: number; follow?: boolean; json?: boolean }) =>
    logs({
      lines: opts.lines,
      follow: opts.follow === true,
      json: opts.json === true,
    }),
  );

program
  .command("pair")
  .argument("[code]", "the code shown in the browser")
  .description("Join a pairing that a browser started")
  .option(
    "-p, --port <number>",
    "port mtmux is serving on",
    (v) => parseInt(v, 10),
    14100,
  )
  .option("--api <url>", "pairing service base URL")
  .option(
    "--tunnel-only",
    "never advertise a direct address; always relay through the tunnel",
  )
  .action(
    (
      code: string | undefined,
      opts: { port: number; api?: string; tunnelOnly?: boolean },
    ) =>
      pair({
        code,
        port: opts.port,
        api: opts.api,
        tunnelOnly: opts.tunnelOnly,
      }),
  );

/**
 * `mtmux share` — one session, one code, not the whole machine.
 *
 * Defaults to read-write, which is what people mean when they say "share my
 * terminal" and is *not* a security boundary. The banner printed before the
 * code says so in as many words; see `shareBanner`. `--read-only` is the mode
 * that is a boundary.
 */
const shareCmd = program
  .command("share")
  .description(
    "Share one tmux session with someone, without sharing the machine",
  );

shareCmd
  .command("list", { isDefault: false })
  .description("Show every share created on this machine")
  .action(() => shareList());

shareCmd
  .command("revoke")
  .argument("<grantId>", "the grn_… id from `mtmux share list`")
  .description("End a share immediately")
  .option(
    "-p, --port <number>",
    "port mtmux is serving on",
    (v) => parseInt(v, 10),
    14100,
  )
  .action((grantId: string, opts: { port: number }) =>
    shareRevoke(grantId, opts.port),
  );

shareCmd
  .argument(
    "[session]",
    "the tmux session to share (comma-separate for several)",
  )
  .option(
    "-p, --port <number>",
    "port mtmux is serving on",
    (v) => parseInt(v, 10),
    14100,
  )
  .option("--api <url>", "pairing service base URL")
  .option("--read-only", "they can watch, and cannot type — a real boundary")
  .option("--files <level>", "none | ro | rw (default: none)", "none")
  .option("--expires <duration>", "24h, 7d, or never", "7d")
  .option("--label <text>", "what to call this share in `mtmux share list`")
  .option("--no-qr", "print only the code, without the QR")
  .action(
    (
      session: string | undefined,
      opts: {
        port: number;
        api?: string;
        readOnly?: boolean;
        files: string;
        expires: string;
        label?: string;
        qr: boolean;
      },
    ) => {
      if (!session) {
        shareCmd.help();
        return;
      }
      const files = parseFiles(opts.files);
      if (!files) {
        console.error(
          `Could not read --files "${opts.files}". Try none, ro, or rw.`,
        );
        process.exitCode = 1;
        return;
      }
      return share({
        session,
        port: opts.port,
        api: opts.api,
        readOnly: opts.readOnly === true,
        files,
        expires: opts.expires,
        label: opts.label,
        qr: opts.qr,
      });
    },
  );

/**
 * The way in for a machine nobody is sitting at.
 *
 * A dashboard access request needs a human to compare six digits, and a box
 * running as a service has none — so it denies, correctly. This opens a window
 * during which the request is shown *here* instead. Purely additive: without
 * it, everything behaves exactly as it did.
 */
program
  .command("approve")
  .description("Wait for a browser's access request and approve it here")
  .option(
    "-t, --timeout <minutes>",
    "how long to stay available",
    (v) => parseInt(v, 10),
    5,
  )
  .option(
    "-p, --port <number>",
    "port the server is on (default: whatever is running)",
    (v) => parseInt(v, 10),
    0,
  )
  .option("--keep", "stay open after the first decision", false)
  .action((opts: { timeout: number; port: number; keep: boolean }) =>
    approve({ timeout: opts.timeout, port: opts.port, keep: opts.keep }),
  );

program
  .command("status")
  .description("Show the server running on this machine")
  .action(status);

program
  .command("stop")
  .description("Stop the server running on this machine")
  .action(stop);

program
  .command("doctor")
  .description("Check everything mtmux needs")
  .option("-p, --port <number>", "port to check", (v) => parseInt(v, 10), 14100)
  .option("--api <url>", "pairing service base URL")
  .action((opts: { port: number; api?: string }) => doctor(opts));

program
  .command("login")
  .description("Sign in — optional, adds the dashboard and more servers")
  .option("--api <url>", "pairing service base URL")
  .option("--no-open", "don't open the browser")
  .action((opts: { api?: string; open: boolean }) =>
    login({ api: opts.api, open: opts.open }),
  );

program
  .command("logout")
  .description("Sign out on this machine")
  .option("--api <url>", "pairing service base URL")
  .action((opts: { api?: string }) => logout(opts));

program
  .command("whoami")
  .description("Show the signed-in account")
  .option("--api <url>", "pairing service base URL")
  .action((opts: { api?: string }) => whoami(opts));

program
  .command("servers")
  .description("List the machines on your account")
  .option("--api <url>", "pairing service base URL")
  .action((opts: { api?: string }) => servers(opts));

program
  .command("upgrade")
  .description("Open checkout for mtmux Pro")
  .option("--api <url>", "pairing service base URL")
  .option("--no-open", "don't open the browser")
  .action((opts: { api?: string; open: boolean }) =>
    upgrade({ api: opts.api, open: opts.open }),
  );

const devices = program
  .command("devices")
  .description("Browsers paired with this machine")
  .action(devicesList);
devices
  .command("list", { isDefault: true })
  .description("List paired devices")
  .action(devicesList);
devices
  .command("revoke <deviceId>")
  .description("Forget a device so it cannot reconnect")
  .action(devicesRevoke);

const token = program.command("token").description("Manage the auth token");
token.command("print").description("Show the current token").action(tokenPrint);
token.command("rotate").description("Generate a new token").action(tokenRotate);
token
  .command("set <value>")
  .description("Set the token to a specific value")
  .action(tokenSet);

program
  .command("version")
  .alias("v")
  .description("Print version info")
  .action(version);

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});

#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { start } from "./commands/start.js";
import { tokenPrint, tokenRotate, tokenSet } from "./commands/token.js";
import { version } from "./commands/version.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
) as { version: string };

const program = new Command();

program
  .name("tmuxremote")
  .description("Self-hosted browser terminal for tmux")
  .version(pkg.version);

program
  .command("start")
  .description("Start the tmuxremote server")
  .option("-p, --port <number>", "port", (v) => parseInt(v, 10), 14100)
  .option("-h, --host <address>", "bind address", "127.0.0.1")
  .option("-t, --token <value>", "override the auth token for this run")
  .option("--allowed-paths <paths>", "comma-separated path allow-list")
  .option("--no-open", "don't open the browser")
  .action((opts) =>
    start({
      port: opts.port,
      host: opts.host,
      token: opts.token,
      open: opts.open,
      allowedPaths: opts.allowedPaths,
    }),
  );

const token = program.command("token").description("Manage the auth token");
token.command("print").description("Show the current token").action(tokenPrint);
token.command("rotate").description("Generate a new token").action(tokenRotate);
token.command("set <value>").description("Set the token to a specific value").action(tokenSet);

program.command("version").alias("v").description("Print version info").action(version);

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});

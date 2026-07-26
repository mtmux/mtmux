import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function version() {
  const pkg = JSON.parse(
    await readFile(path.resolve(__dirname, "../../package.json"), "utf8"),
  ) as { version: string };
  let tmux = "not found";
  try {
    tmux = (await exec("tmux", ["-V"])).stdout.trim();
  } catch {
    // tmux not installed
  }
  console.log(`mtmux     ${pkg.version}`);
  console.log(`node      ${process.versions.node}`);
  console.log(`tmux      ${tmux}`);
  console.log(`platform  ${process.platform}/${process.arch}`);
}

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const DIR = join(homedir(), ".mtmux");
const FILE = join(DIR, "config.json");

// This CLI shipped as `tmuxremote` before it was renamed to `mtmux`. Adopt the
// old token rather than silently issuing a new one — otherwise upgrading
// invalidates every bookmarked login URL the user has.
const LEGACY_FILE = join(homedir(), ".tmuxremote", "config.json");

export type Config = { token: string };

export async function load(): Promise<Config> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as Config;
  } catch {
    // Fall through to the legacy location, then to a fresh token.
  }
  try {
    const legacy = JSON.parse(await readFile(LEGACY_FILE, "utf8")) as Config;
    if (legacy?.token) return set(legacy.token);
  } catch {
    // No legacy config either.
  }
  return regenerate();
}

export async function regenerate(): Promise<Config> {
  await mkdir(DIR, { recursive: true });
  const cfg: Config = { token: randomBytes(32).toString("hex") };
  await writeFile(FILE, JSON.stringify(cfg, null, 2));
  await chmod(FILE, 0o600);
  return cfg;
}

export async function set(token: string): Promise<Config> {
  await mkdir(DIR, { recursive: true });
  const cfg: Config = { token };
  await writeFile(FILE, JSON.stringify(cfg, null, 2));
  await chmod(FILE, 0o600);
  return cfg;
}

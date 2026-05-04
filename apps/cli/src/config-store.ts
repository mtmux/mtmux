import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const DIR = join(homedir(), ".tmuxremote");
const FILE = join(DIR, "config.json");

export type Config = { token: string };

export async function load(): Promise<Config> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as Config;
  } catch {
    return regenerate();
  }
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

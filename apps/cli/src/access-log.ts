import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

/**
 * Read side of the relay's access log.
 *
 * The writer lives in `apps/relay/src/access-log.ts`, because the relay is the
 * only part of the process that sees a device authenticate. The reader lives
 * here because `mtmux devices --history` must work with no server running,
 * and the CLI does not import the relay's modules directly — it bundles a
 * single runtime entry point. The two share a path, not a module; that path is
 * the contract, and it is the same `~/.mtmux` every other CLI store uses.
 */

const DIR = process.env.MTMUX_CONFIG_DIR ?? join(homedir(), ".mtmux");

export const ACCESS_LOG_PATH = join(DIR, "access.log");

export type AccessEvent = {
  at: string;
  event: "connected" | "disconnected";
  grantId: string | null;
  scope: string;
  readOnly: boolean;
  files: string;
  label: string | null;
  transport: "loopback" | "lan" | "tunnel";
  seconds?: number;
};

/** Oldest first. A truncated final line is skipped, not fatal. */
export async function readAccessLog(
  path: string = ACCESS_LOG_PATH,
): Promise<AccessEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const events: AccessEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as AccessEvent);
    } catch {
      // What a `kill -9` mid-append leaves. Show the intact lines.
    }
  }
  return events;
}

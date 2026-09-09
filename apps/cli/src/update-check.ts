import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_PAIR_CLI_VERSION, semverGte } from "@repo/protocol";

/**
 * The read side of the kill switch.
 *
 * A broker can refuse an old client (the protocol floor), but refusing is the
 * blunt half: it arrives as a failure at the worst moment, when someone is
 * standing there trying to pair. This is the other half — asking, ahead of
 * time, whether the CLI is still one the broker wants to talk to, and saying
 * so in one line.
 *
 * Three rules hold throughout, and all three are about not crying wolf:
 *
 * 1. **Never block.** Nothing here can stop `mtmux start`. A broker that is
 *    down, slow, or self-hosted-and-silent must cost nothing. `--local` in
 *    particular never needs the broker at all (invariant #4).
 * 2. **Unknown is not "too old".** `semverGte` returns null for anything it
 *    cannot parse, and null is treated as "say nothing". Telling someone to
 *    upgrade a CLI that is already current is the worse failure: the upgrade
 *    changes nothing and there is nowhere else for them to look.
 * 3. **Silence is the default.** A broker that sets no `latest` and no
 *    advisory produces no line. An advisory that printed every run would stop
 *    being read, which would cost us the one channel we have.
 */

/** What `GET /v1/version` reports. Every field but `protocol` is optional. */
export type BrokerVersion = {
  protocol: number;
  floor: number;
  minCli?: string;
  latest?: string;
  advisory?: string;
};

/**
 * Read `/v1/version`, or null.
 *
 * Null for every failure — offline, 404 on an older broker, a self-hosted one
 * that never implemented it, a body that is not what we expect. The caller
 * cannot tell those apart and does not need to: all of them mean "no opinion
 * available", and the answer to that is silence.
 */
export async function fetchBrokerVersion(
  base: string,
  timeoutMs = 3000,
): Promise<BrokerVersion | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/v1/version`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return null;
    const raw = body as Record<string, unknown>;
    if (typeof raw.protocol !== "number" || typeof raw.floor !== "number") {
      return null;
    }
    return {
      protocol: raw.protocol,
      floor: raw.floor,
      ...(typeof raw.minCli === "string" ? { minCli: raw.minCli } : {}),
      ...(typeof raw.latest === "string" ? { latest: raw.latest } : {}),
      ...(typeof raw.advisory === "string" ? { advisory: raw.advisory } : {}),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** This CLI's own version, from its published `package.json`. */
export async function cliVersion(): Promise<string> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(
    await readFile(path.resolve(dir, "../package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}

export type UpdateNotice = {
  /** `outdated` means the broker will refuse to pair; `stale` is advice. */
  kind: "current" | "stale" | "outdated";
  /** One line, already phrased for a reader. */
  detail: string;
  /** What to run, when there is something to run. */
  fix?: string;
  /** The operator's own line, passed through untouched. */
  advisory?: string;
};

/**
 * Compare this CLI against what a broker says, without ever guessing.
 *
 * `minCli` is the hard line — below it, pairing against this broker fails —
 * and it falls back to the constant compiled into `@repo/protocol` only when
 * the broker names none, so a self-hoster who deliberately says nothing does
 * not inherit our opinion twice over.
 */
export function describeUpdate(
  current: string,
  info: BrokerVersion | null,
): UpdateNotice {
  if (!info) return { kind: "current", detail: "no version service" };

  const advisory = info.advisory?.trim()
    ? { advisory: info.advisory.trim() }
    : {};
  const minCli = info.minCli ?? MIN_PAIR_CLI_VERSION;

  if (semverGte(current, minCli) === false) {
    return {
      kind: "outdated",
      detail: `${current} is below ${minCli}, which this broker requires`,
      fix: "npm i -g mtmux@latest",
      ...advisory,
    };
  }

  if (info.latest && semverGte(current, info.latest) === false) {
    return {
      kind: "stale",
      detail: `${current} — ${info.latest} is available`,
      fix: "npm i -g mtmux@latest",
      ...advisory,
    };
  }

  return { kind: "current", detail: current, ...advisory };
}

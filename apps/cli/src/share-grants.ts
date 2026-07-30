import kleur from "kleur";
import type { GrantFiles, GrantRecord, GrantSession } from "@repo/protocol";

/**
 * The pieces of sharing that both `mtmux share` and `mtmux start --share`
 * need.
 *
 * In their own module rather than in either command, because each command
 * already imports from the other — `share` needs `appOriginFor`/`joinUrl` from
 * `start`, and `start --share` needs the banner and the session resolver from
 * `share`. Leaving them in place would make that a genuine import cycle.
 */

/**
 * Turn `24h` / `7d` / `30m` / `never` into an absolute deadline.
 *
 * `undefined` means "could not read it", which callers turn into an error
 * rather than a default. Silently sharing forever because somebody typed
 * `7days` is the wrong way to fail.
 */
export function parseDuration(
  input: string,
  now = Date.now(),
): number | null | undefined {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "never") return null;
  const match = /^(\d+)\s*(m|h|d|w)$/.exec(trimmed);
  if (!match) return undefined;
  const amount = parseInt(match[1]!, 10);
  const unit = match[2]!;
  const ms =
    unit === "m"
      ? 60_000
      : unit === "h"
        ? 3_600_000
        : unit === "d"
          ? 86_400_000
          : 604_800_000;
  return now + amount * ms;
}

/** Normalise the `--files` spellings people actually type. */
export function parseFiles(input: string | undefined): GrantFiles | undefined {
  if (input === undefined) return "none";
  switch (input.trim().toLowerCase()) {
    case "none":
    case "off":
      return "none";
    case "read":
    case "ro":
      return "read";
    case "write":
    case "rw":
      return "write";
    default:
      return undefined;
  }
}

function formatRelative(at: number, now = Date.now()): string {
  const ms = at - now;
  if (ms <= 0) return "now";
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The paragraph that has to appear before the code does.
 *
 * Sharing defaults to read-write, which is the useful default and is *not* a
 * security boundary: the relay keeps the holder inside one session, but the
 * shell inside that session does not. Somebody typing into it can run
 * `tmux switch-client`, read `~/.ssh`, or do anything else the account can.
 *
 * Printing a code without saying so would be selling a boundary that does not
 * exist. Read-only *is* one — the grouped clone accepts no input at all — and
 * this is where the difference gets stated rather than implied.
 */
export function shareBanner(grant: GrantRecord, now = Date.now()): string[] {
  const names =
    grant.scope.kind === "all"
      ? "this whole machine"
      : grant.scope.sessions.map((s) => s.name).join(", ");
  const count = grant.scope.kind === "all" ? 0 : grant.scope.sessions.length;

  const mode = grant.readOnly ? "read-only" : "read-write";
  const files =
    grant.files === "none"
      ? "no file access"
      : grant.files === "read"
        ? "read-only file access"
        : "read-write file access";
  const expiry =
    grant.expiresAt === null
      ? "never expires"
      : `expires ${formatRelative(grant.expiresAt, now)}`;

  const subject =
    count === 0
      ? names
      : `${count} session${count === 1 ? "" : "s"} (${names})`;

  const lines = [
    "",
    kleur.bold(`  Sharing ${subject} · ${mode} · ${files} · ${expiry}`),
    "",
  ];

  if (!grant.readOnly) {
    lines.push(
      kleur.yellow(
        "  Read-write means they are typing into a shell on this machine. The relay",
      ),
      kleur.yellow(
        "  keeps them in this session, but the shell does not — they can run",
      ),
      kleur.yellow(
        "  `tmux switch-client`, read ~/.ssh, or anything your user account can do.",
      ),
      kleur.yellow(
        "  Use --read-only for a share that is actually a boundary.",
      ),
      "",
    );
  }

  return lines;
}

/**
 * Ask the running relay which sessions exist, so ids can be pinned.
 *
 * A grant names sessions by tmux `session_id`, and neither `mtmux share` nor
 * the arming loop holds the tmux connection — the relay does. Loopback,
 * authenticated with the machine's own token.
 */
export async function resolveShareSessions(
  port: number,
  authToken: string,
  spec: string,
): Promise<GrantSession[]> {
  const wanted = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (wanted.length === 0) {
    throw new Error("Name at least one tmux session to share.");
  }

  const res = await fetch(`http://127.0.0.1:${port}/_sessions`, {
    headers: { Authorization: `Bearer ${authToken}` },
    signal: AbortSignal.timeout(3000),
  }).catch(() => null);

  if (!res || !res.ok) {
    throw new Error(
      "Could not reach the mtmux server on this machine. Is `mtmux` running?",
    );
  }

  const body = (await res.json()) as { sessions?: GrantSession[] };
  const live = body.sessions ?? [];
  const resolved: GrantSession[] = [];
  for (const name of wanted) {
    const found = live.find((s) => s.name === name);
    if (!found) {
      throw new Error(
        `No tmux session called "${name}". Run \`mtmux status\` to see what is running.`,
      );
    }
    resolved.push({ id: found.id, name: found.name });
  }
  return resolved;
}

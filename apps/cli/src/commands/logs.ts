import kleur from "kleur";
import { LOG_PATH, followLog, tailLines } from "../log-file.js";

/**
 * `mtmux logs` — what used to be printed over the QR code.
 *
 * `mtmux start` runs the relay in-process, and its logger writes to fd 1, so
 * every pane click, split and resize landed on top of the banner as raw NDJSON.
 * Sending that to a file makes the terminal readable; this command is what
 * stops that being a straight loss of information.
 *
 * Lines are pretty-printed on the way out rather than at write time, because
 * the file is the durable artefact and JSON is the format worth durably having
 * — `mtmux logs --json | jq` stays possible, and the default stays readable.
 */

export type LogsOpts = {
  lines: number;
  follow: boolean;
  json: boolean;
};

const LEVELS: Record<number, { label: string; paint: (s: string) => string }> =
  {
    10: { label: "trace", paint: kleur.dim },
    20: { label: "debug", paint: kleur.dim },
    30: { label: "info ", paint: kleur.cyan },
    40: { label: "warn ", paint: kleur.yellow },
    50: { label: "error", paint: kleur.red },
    60: { label: "fatal", paint: kleur.red },
  };

/**
 * One NDJSON line as something a human can scan.
 *
 * Anything that does not parse is passed through untouched: a truncated last
 * line during a rotation, or a stray `console.log` from a dependency, is still
 * worth seeing and is not worth crashing over.
 */
export function formatLogLine(raw: string): string {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return raw;
  }
  if (typeof record.level !== "number" || typeof record.msg !== "string") {
    return raw;
  }

  const level = LEVELS[record.level] ?? { label: "?????", paint: kleur.dim };
  const time =
    typeof record.time === "number"
      ? new Date(record.time).toISOString().slice(11, 19)
      : "--:--:--";
  const name = typeof record.name === "string" ? record.name : "";

  // Everything pino puts on every line, plus what is already in the prefix.
  const skip = new Set([
    "level",
    "time",
    "msg",
    "name",
    "pid",
    "hostname",
    "v",
  ]);
  const rest = Object.entries(record)
    .filter(([key]) => !skip.has(key))
    .map(([key, value]) => `${key}=${format(value)}`)
    .join(" ");

  return [
    kleur.dim(time),
    level.paint(level.label),
    name ? kleur.dim(name) : "",
    record.msg,
    rest ? kleur.dim(rest) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function format(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export async function logs(opts: LogsOpts): Promise<void> {
  const render = (line: string) => {
    console.log(opts.json ? line : formatLogLine(line));
  };

  const existing = await tailLines(opts.lines);
  if (existing.length === 0 && !opts.follow) {
    console.log(kleur.dim(`  No logs yet at ${LOG_PATH}.`));
    console.log(
      kleur.dim("  They appear once mtmux start has served something."),
    );
    return;
  }
  for (const line of existing) render(line);

  if (!opts.follow) return;

  const stop = followLog(render);
  // Resolves only on Ctrl+C, which is what `-f` means.
  await new Promise<void>((resolve) => {
    const done = () => {
      stop();
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

/**
 * The first CLI that speaks the current pairing code length.
 *
 * `mtmux pair` on anything older parses six digits and refuses the eight this
 * app now shows — with a message that says the code is not a pairing code,
 * which is both wrong and unfixable after the fact. Everything that can warn
 * about that ahead of time keys off this constant: the `/pair` page, and the
 * dashboard row that already knows each machine's version.
 *
 * It is also the first CLI with `mtmux approve`, which is what a parked
 * access request on a machine with no TTY tells the reader to run.
 */
export const MIN_PAIR_CLI_VERSION = "0.6.0";

/**
 * Whether `version` is at least `minimum`, by semver ordering.
 *
 * Returns null — *not* false — for anything it cannot parse. `cliVersion` is
 * free text the broker stores on behalf of a machine, so an unrecognised value
 * has to read as "unknown", never as "too old": telling someone to upgrade a
 * CLI that is already current is a worse failure than saying nothing, because
 * the upgrade will not change what they see and there is nowhere else to look.
 *
 * Pre-release suffixes are compared as absent, so "0.6.0-rc.1" counts as 0.6.0.
 * That is deliberate: someone running a release candidate has the feature.
 */
export function semverGte(
  version: string | null | undefined,
  minimum: string,
): boolean | null {
  const left = parseSemver(version);
  const right = parseSemver(minimum);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left[i]! !== right[i]!) return left[i]! > right[i]!;
  }
  return true;
}

function parseSemver(input: string | null | undefined): number[] | null {
  if (typeof input !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(input.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

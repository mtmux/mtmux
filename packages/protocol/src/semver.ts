/**
 * Version comparison, shared.
 *
 * It lives beside the wire protocol rather than in either client because both
 * ends now need it: the browser decides whether a registered machine's CLI can
 * read the code it is about to show, and `mtmux doctor` decides whether to tell
 * its user to update. Two copies of a comparison that gates an upgrade prompt
 * is exactly the sort of drift that ends with one side nagging about a version
 * the other considers current.
 */
/**
 * The first CLI that speaks the current pairing code length.
 *
 * `mtmux pair` on anything older parses six or eight digits and refuses the
 * nine this app now shows — with a message that says it is not a pairing code,
 * which is both wrong and unfixable after the fact. Everything that can warn
 * about that ahead of time keys off this constant: the `/pair` page, the
 * dashboard row that already knows each machine's version, and `mtmux doctor`,
 * which compares the CLI it is running against the broker's `/v1/version`.
 *
 * It is also the first CLI with `mtmux approve`, which is what a parked
 * access request on a machine with no TTY tells the reader to run.
 */
export const MIN_PAIR_CLI_VERSION = "0.7.0";

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

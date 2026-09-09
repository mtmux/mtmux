/**
 * Which commit this binary was built from.
 *
 * A published CLI has no `.git`, and its version number only says which
 * release it claims to be — two builds of "0.7.0" from different trees are
 * indistinguishable to the person running them, and to us reading their bug
 * report. `apps/cli/scripts/build.mjs` stamps the real thing in with an
 * esbuild `define:`, the same technique and for the same reason as
 * `apps/site/next.config.ts`.
 *
 * The `typeof` guard is load-bearing: run through `tsx` in development there
 * is no bundler and no define, so the identifier does not exist at all and a
 * bare reference would throw at import time.
 */
declare const __MTMUX_BUILD__: { sha: string; builtAt: string } | undefined;

export type BuildInfo = { sha: string; builtAt: string };

/** The stamped build, or nulls when running from source. */
export function buildInfo(): BuildInfo {
  if (typeof __MTMUX_BUILD__ === "undefined" || !__MTMUX_BUILD__) {
    return { sha: "source", builtAt: "" };
  }
  return __MTMUX_BUILD__;
}

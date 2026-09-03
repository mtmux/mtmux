/**
 * `@repo/cast` — asciinema v2 recordings.
 *
 * This entry point is browser-safe: pure format and playback maths, no
 * `node:` imports. The writer lives behind `@repo/cast/writer` because it
 * needs `node:fs`, and the web player imports this module.
 */
export * from "./format";
export * from "./timeline";

/**
 * Deploy the hosted stack: api.mtmux.com + app.mtmux.com.
 *
 * This exists because the three steps below are order-dependent and each one
 * fails in a way that looks like something else:
 *
 *  1. A plain `pnpm build` bakes NO NEXT_PUBLIC_API_URL into apps/web — Next
 *     inlines those at build time — so the pair page renders "not configured"
 *     and the CSP blocks the broker. It also picks up NEXT_PUBLIC_RELAY_URL
 *     from .env, pointing every visitor at ws://localhost:14300 on their own
 *     machine. So the build must carry explicit env.
 *  2. `output: "standalone"` omits .next/static and public/, so a build that is
 *     not followed by prepare-standalone serves HTML that 404s its own chunks.
 *  3. Rebuilding changes chunk hashes, so the running process must be reloaded
 *     or it serves a tree that no longer matches what it hands out.
 *
 * Between steps 1 and 2 the bundle is checked for the API origin. That guard is
 * the point: every one of these failures produces a page that loads and looks
 * fine until someone tries to pair.
 */
import { execSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const API_ORIGIN = process.env.API_ORIGIN || "https://api.mtmux.com";
const STATIC_DIR = path.join(REPO, "apps/web/.next/static/chunks");

function run(cmd, env = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, {
    stdio: "inherit",
    cwd: REPO,
    env: { ...process.env, ...env },
  });
}

console.log(`→ build (API_ORIGIN=${API_ORIGIN})`);
run("pnpm build:hosted", { API_ORIGIN });

console.log("→ verify the broker origin was baked in");
let found = false;
for (const entry of await readdir(STATIC_DIR, { recursive: true })) {
  if (!entry.endsWith(".js")) continue;
  const body = await readFile(path.join(STATIC_DIR, entry), "utf8");
  if (body.includes(API_ORIGIN)) {
    found = true;
    break;
  }
}
if (!found) {
  console.error(
    `✗ ${API_ORIGIN} is not in the client bundle.\n` +
      `  The pair page would render "not configured" and the CSP would block\n` +
      `  the broker. Refusing to deploy a bundle that cannot pair.`,
  );
  process.exit(1);
}
console.log("  ✓ present");

console.log("→ stage the standalone tree");
run("pnpm prepare:standalone");

console.log("→ reload");
run("pm2 reload mtmux-api mtmux-app --update-env");

console.log(`\n✓ deployed. Verify:  curl -s ${API_ORIGIN}/health`);

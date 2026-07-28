/**
 * Finish a Next `output: "standalone"` build so it can actually be served.
 *
 * `next build` writes a self-contained server tree under
 * `.next/standalone/`, but deliberately leaves out two things it expects the
 * deployer to place: the client bundles in `.next/static` and everything in
 * `public/`. Without them the server boots and answers, but every page loads
 * without its JavaScript or assets.
 *
 * Running `next start` against a standalone build is the other trap — Next
 * warns "next start does not work with output: standalone" and the process
 * still serves, which is exactly the kind of half-working that survives a
 * smoke test and fails in a browser. PM2 runs `server.js` from here instead.
 */
import { cp, access } from "node:fs/promises";
import path from "node:path";

const app = process.argv[2];
if (!app) {
  console.error(
    "usage: node scripts/prepare-standalone.mjs <apps/web|apps/docs>",
  );
  process.exit(2);
}

const REPO = path.resolve(import.meta.dirname, "..");
const APP_DIR = path.join(REPO, app);
const STANDALONE = path.join(APP_DIR, ".next/standalone", app);

try {
  await access(path.join(STANDALONE, "server.js"));
} catch {
  console.error(
    `✗ No standalone server at ${STANDALONE}/server.js.\n` +
      `  Build first, and check next.config has output: "standalone".`,
  );
  process.exit(1);
}

await cp(
  path.join(APP_DIR, ".next/static"),
  path.join(STANDALONE, ".next/static"),
  { recursive: true },
);

try {
  await cp(path.join(APP_DIR, "public"), path.join(STANDALONE, "public"), {
    recursive: true,
  });
} catch {
  // Not every app has a public/ directory.
}

console.log(`✓ standalone ready: ${STANDALONE}/server.js`);

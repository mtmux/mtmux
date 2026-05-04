import { execSync } from "node:child_process";
import { cp, rm, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(ROOT, "../..");

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

await rm(path.join(ROOT, "dist"), { recursive: true, force: true });
// tsc's incremental cache assumes the dist tree it remembers is still on disk.
// We just wiped it, so the cache must go too — otherwise tsc skips emit.
await rm(path.join(ROOT, "tsconfig.tsbuildinfo"), { force: true });
await mkdir(path.join(ROOT, "dist"), { recursive: true });

console.log("→ bundle relay runtime (esbuild)");
const { build } = await import("esbuild");
await build({
  entryPoints: [path.join(REPO, "apps/relay/src/runtime.ts")],
  outfile: path.join(ROOT, "dist/relay/runtime.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Externalize all real npm deps; the CLI's package.json declares them so
  // npm/pnpm install resolves them at the consumer site. Workspace
  // packages (@repo/*) are bundled inline.
  external: [
    "node-pty",
    "ws",
    "pino",
    "pino-pretty",
    "chokidar",
    "zod",
  ],
  banner: {
    // Recreate require for ESM bundles that pull in CJS deps via shims.
    js: "import { createRequire as _ccrCreateRequire } from 'module'; const require = _ccrCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});

console.log("→ build web (standalone)");
// CRITICAL: Next.js inlines NEXT_PUBLIC_* into the client bundle at build
// time. If the developer's .env has NEXT_PUBLIC_RELAY_URL set (for the
// dev/Docker split deployment), that value would be baked into the CLI
// bundle and the browser would try to connect to e.g. ws://localhost:14300
// instead of the same-origin /_relay path the CLI serves. Strip it before
// building, plus pass NODE_ENV=production explicitly so the env validation
// is happy.
run("pnpm --filter @app/web build", {
  cwd: REPO,
  env: {
    ...process.env,
    NEXT_PUBLIC_RELAY_URL: "",
    NODE_ENV: "production",
  },
});

console.log("→ compile cli sources");
run("tsc", { cwd: ROOT });

console.log("→ copy web standalone");
const std = path.join(REPO, "apps/web/.next/standalone");
if (!existsSync(std)) {
  throw new Error(
    `Next.js standalone output missing at ${std}. Ensure apps/web/next.config.ts has output: "standalone".`,
  );
}
await cp(std, path.join(ROOT, "dist/web"), { recursive: true });

await cp(
  path.join(REPO, "apps/web/.next/static"),
  path.join(ROOT, "dist/web/apps/web/.next/static"),
  { recursive: true },
);
await cp(
  path.join(REPO, "apps/web/public"),
  path.join(ROOT, "dist/web/apps/web/public"),
  { recursive: true },
);

console.log("→ prune build-only deps from dist/web/node_modules");
// Next standalone copies its full build graph; trim what's not needed at runtime.
// Each entry is a prefix matched against `.pnpm/<dirname>` entries.
const PNPM_PRUNE_PREFIXES = [
  "typescript@",         // ~8.8 MB compiler, not needed at runtime
  "caniuse-lite@",       // ~2.5 MB build-time data
  "@swc+",               // build-time transpiler
  "postcss@",            // build-time
  "source-map-support@", // dev-only stack mapping
];
const pnpmDir = path.join(ROOT, "dist/web/node_modules/.pnpm");
if (existsSync(pnpmDir)) {
  const entries = await readdir(pnpmDir);
  for (const entry of entries) {
    if (PNPM_PRUNE_PREFIXES.some((p) => entry.startsWith(p))) {
      await rm(path.join(pnpmDir, entry), { recursive: true, force: true });
    }
  }
}

console.log("✓ build complete");

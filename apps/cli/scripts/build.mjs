import { execSync } from "node:child_process";
import { cp, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(ROOT, "../..");

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

await rm(path.join(ROOT, "dist"), { recursive: true, force: true });
await mkdir(path.join(ROOT, "dist"), { recursive: true });

console.log("→ build relay");
run("pnpm --filter @app/relay build", { cwd: REPO });

console.log("→ build web (standalone)");
run("pnpm --filter @app/web build", { cwd: REPO });

console.log("→ compile cli sources");
run("tsc", { cwd: ROOT });

console.log("→ copy relay dist");
await cp(path.join(REPO, "apps/relay/dist"), path.join(ROOT, "dist/relay"), {
  recursive: true,
});

console.log("→ copy web standalone");
const std = path.join(REPO, "apps/web/.next/standalone");
if (!existsSync(std)) {
  throw new Error(
    `Next.js standalone output missing at ${std}. Ensure apps/web/next.config.ts has output: "standalone".`,
  );
}
await cp(std, path.join(ROOT, "dist/web"), { recursive: true });

// Next standalone needs static + public alongside
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

console.log("✓ build complete");

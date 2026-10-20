import { execSync } from "node:child_process";
import { cp, rm, mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(ROOT, "../..");

/**
 * The commit this build came from, stamped into the bundle.
 *
 * A published CLI ships no `.git`, so without this the only provenance a
 * binary carries is a version number it asserts about itself — and the one
 * time that matters is when we are trying to work out which tree a report
 * came from. `GITHUB_SHA` first so a CI build records what CI checked out;
 * `-dirty` because a build from uncommitted work must never claim a commit.
 */
function buildStamp() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try {
    const sha = execSync("git rev-parse --short=12 HEAD", {
      cwd: REPO,
      encoding: "utf8",
    }).trim();
    const dirty = execSync("git status --porcelain", {
      cwd: REPO,
      encoding: "utf8",
    }).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    // A tarball, or git is not installed. Unknown is honest; a guess is not.
    return "unknown";
  }
}

const BUILD = { sha: buildStamp(), builtAt: new Date().toISOString() };

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

// First, and deliberately: it reads nothing but the installed versions, so a
// skew is caught in milliseconds instead of after a two-minute Next build.
console.log("→ check framework pins");
assertFrameworkPins();

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
  external: ["node-pty", "ws", "pino", "pino-pretty", "chokidar", "zod"],
  banner: {
    // Recreate require for ESM bundles that pull in CJS deps via shims.
    js: "import { createRequire as _ccrCreateRequire } from 'module'; const require = _ccrCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});

/**
 * The framework versions must be pinned to the ones that built the bundle.
 *
 * ## What happened without this
 *
 * `apps/cli/package.json` declared `"next": "^16.2.12"`, and `dist/web` is a
 * Next *build output* — a tree of manifests whose shape belongs to the exact
 * Next that emitted it. So a user's `npm i -g mtmux` resolved the caret to
 * 16.4.2, hoisted it to `node_modules/next`, and `start.ts`'s `import("next")`
 * found that instead of anything we shipped. 16.4's `setupFsCheck` reads
 * `.next/server/preview-props.json`, which 16.2 never writes, and `mtmux
 * start` died on `app.prepare()` for everyone:
 *
 *     ENOENT: no such file or directory, open
 *     '…/mtmux/dist/web/apps/web/.next/server/preview-props.json'
 *
 * That shipped in 0.13.0. Nothing caught it, and the reason is worth stating:
 * `pnpm cli:smoke` boots the built CLI *inside this repo*, where
 * `node_modules/next` is the lockfile's copy and therefore always matches the
 * build. The skew only exists after a real install from the registry, which no
 * test does. A caret on a framework whose compiled output you ship is not a
 * compatible range — it is a promise that a stranger's `npm install` will pick
 * the version your artifacts were made for.
 *
 * Hence the gate rather than a comment next to the pin. A pin can be bumped to
 * a caret by a dependabot PR, or drift when `apps/web` moves and `apps/cli`
 * does not, and either way the result is a published tarball that cannot boot.
 * This fails the build instead, which is the only place that sees both numbers.
 */
function assertFrameworkPins() {
  const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
  const pkg = readJson(path.join(ROOT, "package.json"));
  // Resolved from `apps/web`, because that is the workspace whose install
  // produced `dist/web`.
  const fromWeb = createRequire(path.join(REPO, "apps/web/package.json"));
  const problems = [];

  for (const name of ["next", "react", "react-dom"]) {
    const declared = pkg.dependencies?.[name];
    const built = readJson(fromWeb.resolve(`${name}/package.json`)).version;

    if (declared !== built) {
      problems.push(
        `  ${name}: apps/cli declares ${JSON.stringify(declared)}, but ` +
          `dist/web was built by ${built}`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      "framework versions are not pinned to the build:\n" +
        problems.join("\n") +
        "\n\nThese ship as a prebuilt Next output, so the declared version " +
        "must be the exact version that emitted it — a range lets a user's " +
        "install pick a Next that cannot read our manifests. Set the exact " +
        "version in apps/cli/package.json. See the note on this function.",
    );
  }
}

console.log("→ build web (standalone)");
// CRITICAL: Next.js inlines NEXT_PUBLIC_* into the client bundle at build
// time. If the developer's .env has NEXT_PUBLIC_RELAY_URL set (for the
// dev/Docker split deployment), that value would be baked into the CLI
// bundle and the browser would try to connect to e.g. ws://localhost:14300
// instead of the same-origin /_relay path the CLI serves. Strip it before
// building, plus pass NODE_ENV=production explicitly so the env validation
// is happy.
//
// NEXT_PUBLIC_API_URL is the mirror image: it must be *present*, because the
// bundled /pair page reads it to reach the broker and to build the tunnel URL.
// Left unset, hosted pairing is dead in the shipped CLI — the page renders "not
// configured" and no tunnel URL can be formed. It is overridable so a
// self-hoster can point the bundled client at their own broker.
const WEB_DIST = ".next-cli";
run("pnpm --filter @app/web build", {
  cwd: REPO,
  env: {
    ...process.env,
    NEXT_PUBLIC_RELAY_URL: "",
    NEXT_PUBLIC_API_URL:
      process.env.MTMUX_BUILD_API_URL || "https://api.mtmux.com",
    NODE_ENV: "production",
    NEXT_DIST_DIR: WEB_DIST,
  },
});

console.log("→ typecheck cli sources");
run("tsc --noEmit", { cwd: ROOT });

console.log("→ bundle cli (esbuild)");
// esbuild rather than tsc, because the CLI's own sources now import workspace
// packages (@repo/crypto, @repo/protocol) that are published as raw TypeScript
// and would not resolve from the installed package. Same rule as the relay
// bundle above: @repo/* inlined, real npm deps left external and declared in
// package.json. `import(RELAY_RUNTIME)` is a computed specifier, so esbuild
// leaves it as a runtime dynamic import.
await build({
  entryPoints: [path.join(ROOT, "src/bin.ts")],
  outfile: path.join(ROOT, "dist/bin.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: [
    "next",
    "node-pty",
    "ws",
    "pino",
    "pino-pretty",
    "chokidar",
    "zod",
    "commander",
    "kleur",
    "open",
    "qrcode-terminal",
  ],
  define: {
    __MTMUX_BUILD__: JSON.stringify(BUILD),
  },
  banner: {
    js: "import { createRequire as _mtmuxCreateRequire } from 'module'; const require = _mtmuxCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});

console.log("→ copy web standalone");
const std = path.join(REPO, `apps/web/${WEB_DIST}/standalone`);
if (!existsSync(std)) {
  throw new Error(
    `Next.js standalone output missing at ${std}. Ensure apps/web/next.config.ts has output: "standalone".`,
  );
}
await cp(std, path.join(ROOT, "dist/web"), { recursive: true });

// The standalone tree carries the build-time distDir name. `start` boots Next
// with `next({ dir })` and no config file, so Next looks for the default
// `.next` — rename it rather than teaching the runtime about a build detail.
const shippedDist = path.join(ROOT, "dist/web/apps/web/.next");
await rm(shippedDist, { recursive: true, force: true });
await rename(path.join(ROOT, `dist/web/apps/web/${WEB_DIST}`), shippedDist);

await cp(
  path.join(REPO, `apps/web/${WEB_DIST}/static`),
  path.join(shippedDist, "static"),
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
  "typescript@", // ~8.8 MB compiler, not needed at runtime
  "caniuse-lite@", // ~2.5 MB build-time data
  "@swc+", // build-time transpiler
  "postcss@", // build-time
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

#!/usr/bin/env node
/**
 * Boot the CLI the way a stranger does: `npm pack`, `npm install`, run it.
 *
 * ## Why this exists, and why `smoke.mjs` was not enough
 *
 * 0.13.0 shipped unable to start. Every gate was green — lint, typecheck,
 * build, the whole unit suite, and `smoke.mjs` booting the built CLI and
 * probing `/health`, `/` and `/_relay` on two operating systems — and the
 * first thing a user saw was:
 *
 *     ENOENT: no such file or directory, open
 *     '…/mtmux/dist/web/apps/web/.next/server/preview-props.json'
 *
 * The cause was a caret on `next` in `apps/cli/package.json` against a shipped
 * Next *build output*: the user's install resolved 16.4.2, hoisted it, and
 * `import("next")` found that rather than the 16.2.12 the manifests were
 * emitted by. `assertFrameworkPins` in `build.mjs` now makes that exact skew a
 * build error.
 *
 * But the reason it *escaped* is more general than the bug, and a pin does not
 * fix it: `smoke.mjs` runs `dist/bin.js` **from inside this repo**, where
 * `node_modules` is the lockfile's own tree and therefore always agrees with
 * whatever just built the bundle. Nothing anywhere resolved a dependency the
 * way a registry install does, so a whole class of packaging faults — a
 * dependency range that picks the wrong version, a file missing from `files`,
 * a path that only works relative to the repo — could not be caught by any
 * test we had.
 *
 * So this one is deliberately slow and deliberately external. It packs the
 * real tarball, installs it into a throwaway directory with npm resolving
 * dependencies from the registry, and boots *that* copy from a working
 * directory outside the repo. It is the only test here whose failure means
 * "the published artifact does not work", and that is the failure that
 * matters most, because it is the one the user meets first.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** A port the kernel hands us, rather than one we guess. See `smoke.mjs`. */
async function pickPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function get(port, route) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: route, method: "GET", timeout: 5000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

const work = await mkdtemp(path.join(tmpdir(), "mtmux-pack-smoke-"));
let child = null;
let failed = null;

try {
  console.log(`→ pack (into ${work})`);
  const packed = execFileSync(
    "npm",
    ["pack", "--pack-destination", work, "--silent"],
    { cwd: ROOT, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .pop();
  const tarball = path.join(work, packed);
  console.log(`  ${packed}`);

  /*
   * A bare `package.json`, so npm installs here rather than walking up and
   * finding the monorepo — which would defeat the entire point by resolving
   * against the workspace instead of the registry.
   */
  await writeFile(
    path.join(work, "package.json"),
    JSON.stringify({ name: "pack-smoke", private: true }, null, 2),
  );

  /*
   * And a separate directory to *run* from, holding a stray `pnpm-lock.yaml`.
   *
   * Not decoration. The user who reported this was in their home directory,
   * which had one, and Next's root inference walks up looking for exactly that
   * file — their report led with a warning about it. Booting from a directory
   * that has one keeps that path under test rather than assumed harmless.
   */
  const home = path.join(work, "home");
  await mkdir(home, { recursive: true });
  await writeFile(
    path.join(home, "pnpm-lock.yaml"),
    "lockfileVersion: '9.0'\n",
  );

  console.log("→ install from the tarball (registry resolution)");
  execFileSync("npm", ["install", tarball, "--no-audit", "--no-fund"], {
    cwd: work,
    encoding: "utf8",
    stdio: "inherit",
  });

  /*
   * The version the *consumer* ended up with, which is the number the bug was
   * about. Asserted rather than merely printed: if a future range lets this
   * drift again, the failure should name the two versions rather than show an
   * ENOENT and leave the next person to work out why.
   */
  const built = JSON.parse(
    await readFile(path.join(work, "node_modules/mtmux/package.json"), "utf8"),
  ).dependencies.next;
  const installed = JSON.parse(
    await readFile(path.join(work, "node_modules/next/package.json"), "utf8"),
  ).version;
  if (installed !== built) {
    throw new Error(
      `the consumer install resolved next@${installed}, but the package ` +
        `declares ${built} — a shipped Next build output cannot be served by ` +
        `a different Next. See assertFrameworkPins in scripts/build.mjs.`,
    );
  }
  console.log(`  consumer resolved next@${installed} ✓`);

  const port = await pickPort();
  const bin = path.join(work, "node_modules/mtmux/dist/bin.js");

  console.log(`→ boot it from ${home} on :${port}`);
  child = spawn(
    process.execPath,
    [bin, "start", "--local", "--port", String(port)],
    {
      cwd: home,
      // A throwaway HOME, so the run cannot read or write the real
      // `~/.mtmux` — this boots a server, and it must not adopt the
      // developer's token, device list or recordings.
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));

  // `start` is a long boot: Next's `prepare()` plus a tmux attach.
  let up = false;
  for (let attempt = 0; attempt < 45; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const res = await get(port, "/health");
      if (res.status === 200) {
        up = true;
        break;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(1000);
  }

  if (!up) {
    throw new Error(
      `the installed CLI never served /health` +
        (child.exitCode !== null ? ` (exited ${child.exitCode})` : "") +
        `\n--- its output ---\n${output}`,
    );
  }
  console.log("  /health 200 ✓");

  /*
   * And the page itself, not only the health endpoint. `/health` is served by
   * the relay and would have answered 200 throughout the 0.13.0 failure; it is
   * `/` that goes through Next, and `/` that was broken.
   */
  const page = await get(port, "/");
  if (page.status !== 200) {
    throw new Error(
      `GET / returned ${page.status}\n--- its output ---\n${output}`,
    );
  }
  console.log("  / 200 ✓");

  if (/ENOENT|Cannot find module|MODULE_NOT_FOUND/.test(output)) {
    throw new Error(`the CLI logged a resolution failure:\n${output}`);
  }

  console.log("✓ the published artifact boots and serves");
} catch (err) {
  failed = err;
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  await sleep(300);
  if (child && child.exitCode === null) child.kill("SIGKILL");
  await rm(work, { recursive: true, force: true });
}

if (failed) {
  console.error(`✗ ${failed.message}`);
  process.exit(1);
}

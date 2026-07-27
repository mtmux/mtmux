/**
 * Dev with hosted pairing wired up locally.
 *
 * `pnpm dev` runs the self-hosted topology: web + relay on one port, no broker.
 * That is the right default, because it is what most people run and what the
 * shipped CLI does. But it cannot exercise `/pair`, `mtmux pair`, or the sealed
 * tunnel at all — those need a broker, and pointing the two at each other means
 * getting four environment variables right across two processes:
 *
 *   - the broker must allow the web origin through CORS,
 *   - the *browser* bundle needs NEXT_PUBLIC_API_URL (inlined by Next),
 *   - the CSP in proxy.ts reads the same variable to allow the origin,
 *   - and the CLI needs MTMUX_API_URL, or it dials api.mtmux.com.
 *
 * Miss any one and the failure is indirect — a CSP violation, a 404, or a page
 * that says pairing is not configured. So this script owns the wiring.
 *
 * Pair against it with:
 *   MTMUX_API_URL=http://127.0.0.1:14400 pnpm --filter mtmux exec tsx src/bin.ts pair <code>
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";

const REPO = path.resolve(import.meta.dirname, "..");

const API_PORT = process.env.API_PORT ?? "14400";
const WEB_PORT = process.env.PORT ?? "14100";
const API_URL = `http://127.0.0.1:${API_PORT}`;

const apiEntry = path.join(REPO, "apps/api/dist/index.js");
if (!existsSync(apiEntry)) {
  console.error(
    `✗ The broker is not built.\n  Run: pnpm --filter @app/api build`,
  );
  process.exit(1);
}

const children = [];

function start(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: REPO,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...env },
  });
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`\n✗ ${name} exited (${signal ?? code}). Shutting down.`);
    shutdown();
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 300).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start("broker", process.execPath, [apiEntry], {
  API_PORT,
  API_HOST: "127.0.0.1",
  // Both spellings: the browser's origin depends on which one you typed.
  API_CORS_ORIGINS: `http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}`,
});

start("web+relay", "pnpm", ["dev"], {
  NEXT_PUBLIC_API_URL: API_URL,
  MTMUX_API_URL: API_URL,
});

console.log(`
  ›  mtmux dev + pairing

  App     http://127.0.0.1:${WEB_PORT}
  Pair    http://127.0.0.1:${WEB_PORT}/pair
  Broker  ${API_URL}/health

  Read the six digits off /pair, then in another terminal:

    MTMUX_API_URL=${API_URL} \\
      pnpm --filter mtmux exec tsx src/bin.ts pair <code>

  Add --tunnel-only to force the sealed tunnel instead of the direct path.
`);

// Smoke test the built CLI:
//   1. boot `node dist/bin.js start --port <free> --no-open`
//   2. probe /health, /, /_relay (websocket upgrade)
//   3. kill the process; exit non-zero on any failure
//
// Used by `pnpm --filter mtmux test` and the cli-smoke CI job.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import http from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BIN = path.join(ROOT, "dist/bin.js");
const PORT = Number(process.env.SMOKE_PORT ?? 0) || pickPort();

if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — run \`pnpm --filter mtmux build\` first.`);
  process.exit(1);
}

function pickPort() {
  return 39000 + Math.floor(Math.random() * 500);
}

function fetch(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path, method: "GET", timeout: 3000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path,
        method,
        timeout: 3000,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": payload.length,
            }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Open a socket, send one auth frame, resolve with the server's reply. */
function tryAuth(token) {
  return new Promise((resolve, reject) => {
    import("ws").then(({ default: WS }) => {
      const ws = new WS(`ws://127.0.0.1:${PORT}/_relay`, {
        headers: {
          Origin: `http://127.0.0.1:${PORT}`,
          "User-Agent": "Mozilla/5.0 SmokeTest",
        },
      });
      const t = setTimeout(() => {
        ws.close();
        reject(new Error("no auth reply within 4s"));
      }, 4000);
      ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
      ws.on("message", (d) => {
        clearTimeout(t);
        const msg = JSON.parse(d.toString());
        ws.close();
        resolve(msg);
      });
      ws.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    }, reject);
  });
}

function probeUpgrade(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: PORT,
      path,
      method: "GET",
      timeout: 3000,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode });
    });
    req.on("response", (res) => resolve({ status: res.statusCode }));
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

console.log(`→ booting CLI on port ${PORT}`);
const child = spawn(
  "node",
  [BIN, "start", "--port", String(PORT), "--no-open"],
  {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "production" },
  },
);

const stderr = [];
child.stdout.on("data", (b) => process.stdout.write(b));
child.stderr.on("data", (b) => {
  stderr.push(b);
  process.stderr.write(b);
});

let exited = false;
child.on("exit", (code) => {
  exited = true;
  if (code !== 0 && code !== null) {
    console.error(`✗ CLI exited with code ${code} during smoke test`);
    process.exit(1);
  }
});

// Give the server time to listen + Next prepare
await sleep(7000);

if (exited) {
  console.error("✗ CLI exited before smoke probes ran");
  process.exit(1);
}

let failed = false;
async function check(name, fn) {
  try {
    const result = await fn();
    console.log(`  ✓ ${name}: ${JSON.stringify(result)}`);
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed = true;
  }
}

await check("/health returns 200", async () => {
  const r = await fetch("/health");
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (!r.body.includes('"status":"ok"'))
    throw new Error(`unexpected body: ${r.body}`);
  return r.status;
});

await check("/ returns Next.js HTML", async () => {
  const r = await fetch("/");
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (!r.body.includes("<!DOCTYPE html>"))
    throw new Error("no <!DOCTYPE html> in body");
  return { status: r.status, bytes: r.body.length };
});

await check("/_relay accepts WS upgrade", async () => {
  const r = await probeUpgrade("/_relay");
  if (r.status !== 101) throw new Error(`expected 101, got ${r.status}`);
  return r.status;
});

// Regression guard: in our embedded setup Next.js's NextServer used to
// register its own `upgrade` listener on first request, which would
// destroy /_relay sockets after handshake. Ensure a real WS auth flow
// still works after Next has handled an HTTP request.
await check("WS auth survives a prior Next request", async () => {
  const { default: WS } = await import("ws");
  const { readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const cfg = JSON.parse(
    await readFile(join(homedir(), ".mtmux/config.json"), "utf8"),
  );
  return await new Promise((resolve, reject) => {
    const ws = new WS(`ws://127.0.0.1:${PORT}/_relay`, {
      headers: {
        Origin: `http://127.0.0.1:${PORT}`,
        "User-Agent": "Mozilla/5.0 SmokeTest",
      },
    });
    const t = setTimeout(() => {
      ws.close();
      reject(new Error("no auth:success within 4s"));
    }, 4000);
    ws.on("open", () =>
      ws.send(JSON.stringify({ type: "auth", token: cfg.token })),
    );
    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === "auth:success") {
        clearTimeout(t);
        ws.close();
        resolve("auth:success");
      } else if (msg.type === "auth:failure") {
        clearTimeout(t);
        ws.close();
        reject(new Error(`auth:failure ${msg.reason}`));
      }
    });
    ws.on("close", (code) => {
      clearTimeout(t);
      reject(new Error(`closed ${code} before auth:success`));
    });
    ws.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
});

await check("/_pair/local rejects an unknown nonce", async () => {
  const r = await request(
    "POST",
    "/_pair/local",
    JSON.stringify({ nonce: "definitely-not-a-real-nonce" }),
  );
  if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
  return r.status;
});

await check("/_pair/local rejects GET", async () => {
  const r = await request("GET", "/_pair/local");
  if (r.status !== 405) throw new Error(`expected 405, got ${r.status}`);
  return r.status;
});

await check("/_pair/local rejects a malformed body", async () => {
  const r = await request("POST", "/_pair/local", "{ not json");
  if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
  return r.status;
});

// Runs last: it deliberately locks 127.0.0.1 out, so anything needing a
// successful auth must already have happened.
await check("failed auth locks the address out after five tries", async () => {
  for (let i = 0; i < 5; i++) {
    const reply = await tryAuth(`wrong-token-${i}`);
    if (reply.type !== "auth:failure")
      throw new Error(`attempt ${i}: expected auth:failure, got ${reply.type}`);
  }
  const sixth = await tryAuth("wrong-token-5");
  if (sixth.type !== "auth:failure")
    throw new Error(`expected auth:failure, got ${sixth.type}`);
  if (!/Too many failed attempts/.test(sixth.reason ?? ""))
    throw new Error(`expected a backoff message, got: ${sixth.reason}`);
  return sixth.reason;
});

console.log("→ shutting down");
child.kill("SIGTERM");
await sleep(500);
if (!exited) child.kill("SIGKILL");

if (failed) {
  console.error("✗ smoke test failed");
  process.exit(1);
}
console.log("✓ smoke test passed");

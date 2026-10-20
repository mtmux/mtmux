/**
 * Does a device that never went away get asked about again?
 *
 * The one claim in `makeConnectionGate` that no unit test can make: that the
 * device ids the gate keys its answers by are the ids the relay reports as
 * connected, and that sampling those actually holds an approval open. Both
 * halves are injected in the unit tests — which is why 0.13.1 shipped a gate
 * whose cover expired under a phone sitting in the owner's hand.
 *
 * So this drives the real thing. A real `mtmux start` under a pty, a real LAN
 * pairing answered at the panel, one socket held past the admit grace the way
 * a phone holds one, and then the blip every screen lock produces. Admitted in
 * silence is a pass; a second question is the bug.
 *
 * Not in CI: it spends two and a half minutes doing nothing on purpose, since
 * the window it is testing is two minutes long. Run it by hand after touching
 * the gate, the connection manager, or anything that mints a device id:
 *
 *   pnpm cli:smoke:reconnect           # 150s hold
 *   HOLD_SECONDS=20 pnpm cli:smoke:reconnect   # mechanics only, inside grace
 */
import { spawn } from "node-pty";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = process.env.MTMUX_BIN ?? join(ROOT, "dist/bin.js");
const HOLD_MS = Number(process.env.HOLD_SECONDS ?? 150) * 1000;
const PORT = Number(process.env.PORT ?? 14997);

const dir = mkdtempSync(join(tmpdir(), "mtmux-reconnect-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The panel draws with cursor moves and erases; strip them before matching, or
// a question can be split across two frames and never seen.
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

let out = "";
const pty = spawn(
  process.execPath,
  [BIN, "start", "--local", "--port", String(PORT)],
  {
    cols: 120,
    rows: 45,
    env: { ...process.env, MTMUX_CONFIG_DIR: dir, NO_COLOR: "1" },
  },
);
pty.onData((chunk) => {
  out += chunk;
});

async function waitFor(pattern, ms = 30_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const match = strip(out).match(pattern);
    if (match) return match;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${pattern}`);
}

/** Authenticate a socket and say what the machine answered. */
async function connect(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/_relay`);
  const answer = await new Promise((resolve, reject) => {
    // Generous: a refusal here is a *question* nobody is answering, which is
    // precisely the failure, so this has to outlast the question going up.
    const timer = setTimeout(() => resolve({ asked: true }), 20_000);
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token })));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth:success") {
        clearTimeout(timer);
        resolve({ ok: true });
      }
      if (msg.type === "auth:failure") {
        clearTimeout(timer);
        resolve({ ok: false, reason: msg.code ?? msg.reason });
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return { ws, answer };
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exitCode = 1;
}

try {
  const digits = (await waitFor(/enter\s+(\d{3})\s+(\d{3})/i)).slice(1, 3);
  const code = digits.join("");

  // Redeeming raises the pairing question on the machine; answer it there.
  const pairing = fetch(`http://127.0.0.1:${PORT}/_pair/local`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, label: "Smoke · Phone" }),
  }).then((res) => res.json());
  await waitFor(/wants in|entered this machine|Let it in/i);
  await sleep(500);
  pty.write("y\r");

  const { token } = await pairing;
  if (!token) throw new Error("the pairing did not yield a session token");
  console.log("→ paired over the LAN");

  const first = await connect(token);
  if (!first.answer.ok)
    throw new Error(`first connection refused: ${first.answer.reason}`);
  console.log(`→ connected; holding one socket for ${HOLD_MS / 1000}s`);
  await sleep(HOLD_MS);

  // The screen locks. The socket goes and the phone comes straight back.
  first.ws.close();
  await sleep(1_500);
  const second = await connect(token);
  second.ws.close();

  if (second.answer.ok) {
    console.log("✓ readmitted in silence after the blip");
  } else if (second.answer.asked) {
    fail(
      "it asked again about a device that never went away " +
        "(the question is still on the machine's screen, unanswered)",
    );
  } else {
    fail(`it refused a device that never went away: ${second.answer.reason}`);
  }
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  pty.kill();
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}

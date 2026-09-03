import { expect, test, type Page } from "@playwright/test";

import { expectTapTarget } from "./tap-target";

/**
 * Recordings, against a mocked relay.
 *
 * `page.routeWebSocket` stands in for the whole relay, which is what makes this
 * spec worth having: the recording feature's failure modes are all in how the
 * browser *reacts* to what the relay says — a feature flag it does not
 * advertise, a scope that permits no session, a `.cast` arriving in pieces —
 * and none of that is reachable through the HTTP stubs the other specs use.
 *
 * The `.cast` fixture is deliberately tiny and hand-written. A real recording
 * would test xterm rather than us, and xterm's own output is not a thing this
 * suite should be asserting on.
 */

const TOKEN = process.env.E2E_RELAY_TOKEN ?? "dev-token";

const CAST = [
  JSON.stringify({ version: 2, width: 80, height: 24, title: "work" }),
  JSON.stringify([0, "o", "MARKER_ALPHA\r\n"]),
  JSON.stringify([2, "o", "MARKER_BETA\r\n"]),
  JSON.stringify([4, "o", "MARKER_GAMMA\r\n"]),
  "",
].join("\n");

const RECORDING = {
  id: "rec_aaaaaaaaaaaaaaaa",
  filename: "a.cast",
  target: { kind: "session", session: "work" },
  title: "a refactor",
  cols: 80,
  rows: 24,
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_075_000,
  bytes: CAST.length,
  events: 3,
  truncated: false,
  stopReason: "requested",
};

type RelayOptions = {
  /** What the relay advertises in `auth:success`. */
  features?: string[];
  capabilities?: { readOnly: boolean; files: string; scope: string };
  recordings?: unknown[];
  /** Capture what the page sent, for the assertions that care. */
  sent?: string[];
};

/**
 * Stand in for the relay on `/_relay`.
 *
 * Only the frames this feature needs are answered. Anything else is ignored,
 * which is exactly what an older relay does and is therefore a fair model.
 */
async function mockRelay(page: Page, options: RelayOptions = {}) {
  const sent = options.sent ?? [];
  const features = options.features ?? [
    "window:step",
    "pane:step",
    "recording",
  ];
  const recordings = options.recordings ?? [RECORDING];

  await page.routeWebSocket(/\/_relay$/, (ws) => {
    ws.onMessage((raw) => {
      const text = String(raw);
      sent.push(text);
      const msg = JSON.parse(text) as { type: string; id?: string };

      if (msg.type === "auth") {
        ws.send(
          JSON.stringify({
            type: "auth:success",
            serverVersion: "1.0.0",
            features,
            ...(options.capabilities
              ? { capabilities: options.capabilities }
              : {}),
          }),
        );
        return;
      }

      if (msg.type === "recording:list") {
        ws.send(JSON.stringify({ type: "recording:list", recordings }));
        return;
      }

      if (msg.type === "recording:fetch") {
        // Two chunks, so reassembly is actually exercised rather than a single
        // whole-file message that would pass with no assembler at all.
        const half = Math.ceil(CAST.length / 2);
        const bytes = Buffer.from(CAST, "utf8");
        ws.send(
          JSON.stringify({
            type: "recording:chunk",
            id: msg.id,
            offset: 0,
            data: bytes.subarray(0, half).toString("base64"),
            totalBytes: bytes.length,
            final: false,
          }),
        );
        ws.send(
          JSON.stringify({
            type: "recording:chunk",
            id: msg.id,
            offset: half,
            data: bytes.subarray(half).toString("base64"),
            totalBytes: bytes.length,
            final: true,
          }),
        );
        return;
      }

      if (msg.type === "session:list") {
        ws.send(JSON.stringify({ type: "session:list", sessions: [] }));
      }
    });
  });

  await page.addInitScript((token: string) => {
    localStorage.setItem("mtmux-token", token);
  }, TOKEN);

  return sent;
}

test.describe("the recordings list", () => {
  test("lists what the relay reports", async ({ page }) => {
    await mockRelay(page);
    await page.goto("/r");

    await expect(
      page.getByRole("heading", { name: "Recordings" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "a refactor" })).toBeVisible();
  });

  test("says the machine cannot record rather than showing an empty list", async ({
    page,
  }) => {
    // An older CLI is not the same thing as no recordings, and telling somebody
    // to run a command their mtmux does not have is worse than saying nothing.
    await mockRelay(page, { features: ["window:step", "pane:step"] });
    await page.goto("/r");

    await expect(page.getByText("This machine cannot record")).toBeVisible();
    await expect(page.getByRole("link", { name: "a refactor" })).toHaveCount(0);
  });

  test("offers a way to make one when there are none", async ({ page }) => {
    await mockRelay(page, { recordings: [] });
    await page.goto("/r");

    await expect(page.getByText("No recordings yet")).toBeVisible();
    await expect(page.getByText("mtmux record")).toBeVisible();
  });

  test("hides delete from a share that only holds a recording", async ({
    page,
  }) => {
    await mockRelay(page, {
      capabilities: { readOnly: true, files: "none", scope: "recordings" },
    });
    await page.goto("/r");

    await expect(page.getByRole("link", { name: "a refactor" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Delete recording/ }),
    ).toHaveCount(0);
  });

  test("sends a recordings-scoped share to /r rather than a dead terminal", async ({
    page,
  }) => {
    // Such a connection can attach to nothing, so `/` would render a terminal
    // that never fills in — which reads as a broken share.
    await mockRelay(page, {
      capabilities: { readOnly: true, files: "none", scope: "recordings" },
    });
    await page.goto("/");

    await expect(page).toHaveURL(/\/r$/);
  });
});

/** The transport, scoped: the app shell has controls of its own. */
const transport = (page: Page) =>
  page.getByRole("group", { name: "Playback controls" });

test.describe("the player", () => {
  async function openPlayer(page: Page) {
    await page.goto(`/r/${RECORDING.id}`);
    await expect(
      transport(page).getByRole("button", { name: "Play", exact: true }),
    ).toBeVisible();
  }

  test("reassembles a chunked recording and plays it", async ({ page }) => {
    await mockRelay(page);
    await openPlayer(page);

    // The duration comes out of the parsed cast, so seeing it means every
    // chunk arrived, joined in order and parsed.
    await expect(page.getByText("0:00 / 0:04")).toBeVisible();
    await expect(page.getByText("a refactor")).toBeVisible();
  });

  test("asks for the recording exactly once, from byte zero", async ({
    page,
  }) => {
    const sent = await mockRelay(page);
    await openPlayer(page);

    const fetches = sent
      .map((raw) => JSON.parse(raw) as { type: string; offset?: number })
      .filter((msg) => msg.type === "recording:fetch");
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.offset).toBe(0);
  });

  test("plays, pauses, and scrubs", async ({ page }) => {
    await mockRelay(page);
    await openPlayer(page);

    await transport(page)
      .getByRole("button", { name: "Play", exact: true })
      .click();
    await expect(
      transport(page).getByRole("button", { name: "Pause" }),
    ).toBeVisible();

    await transport(page).getByRole("button", { name: "Pause" }).click();
    await expect(
      transport(page).getByRole("button", { name: "Play", exact: true }),
    ).toBeVisible();

    const scrubber = page.getByRole("slider", {
      name: "Seek within the recording",
    });
    await scrubber.fill("2");
    await expect(page.getByText("0:02 / 0:04")).toBeVisible();

    // Back to the start. This is the redraw path — reset and replay — and the
    // assertion that matters is that it lands rather than that it is fast.
    await scrubber.fill("0");
    await expect(page.getByText("0:00 / 0:04")).toBeVisible();
  });

  test("cycles the speed", async ({ page }) => {
    await mockRelay(page);
    await openPlayer(page);

    const speed = transport(page).getByRole("button", {
      name: /Playback speed/,
    });
    await expect(speed).toHaveText("1×");
    await speed.click();
    await expect(speed).toHaveText("2×");
    await speed.click();
    await expect(speed).toHaveText("4×");
    await speed.click();
    await expect(speed).toHaveText("0.5×");
  });

  test("says so when a recording was cut off", async ({ page }) => {
    // A recording that ends mid-thought with no explanation reads as a bug in
    // the player rather than as what actually happened.
    await mockRelay(page, {
      recordings: [{ ...RECORDING, truncated: true }],
    });
    await page.goto(`/r/${RECORDING.id}`);
    await expect(page.getByText(/cut off/)).toBeVisible();
  });
});

test.describe("on a phone", { tag: "@phone" }, () => {
  test("the transport controls are thumb-sized", async ({ page }) => {
    await mockRelay(page);
    await page.goto(`/r/${RECORDING.id}`);

    await expectTapTarget(
      transport(page).getByRole("button", { name: "Play", exact: true }),
      "play button",
    );
    await expectTapTarget(
      transport(page).getByRole("button", { name: /Playback speed/ }),
      "speed button",
    );
  });

  test("the list rows are reachable", async ({ page }) => {
    await mockRelay(page);
    await page.goto("/r");
    await expectTapTarget(
      page.getByRole("button", { name: /Delete recording/ }),
      "delete button",
    );
  });
});

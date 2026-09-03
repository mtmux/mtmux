import { Readable } from "node:stream";
import type http from "node:http";

import { describe, expect, it, vi } from "vitest";

import type { RecordingInfo } from "@repo/protocol";

import { RECORD_PATH, createRecordControl } from "./record-control.js";

const TOKEN = "a".repeat(64);

function recording(over: Partial<RecordingInfo> = {}): RecordingInfo {
  return {
    id: "rec_aaaaaaaaaaaaaaaa",
    filename: "a.cast",
    target: { kind: "session", session: "work" },
    title: "work",
    cols: 80,
    rows: 24,
    startedAt: 1000,
    endedAt: 2000,
    bytes: 10,
    events: 1,
    truncated: false,
    stopReason: "requested",
    ...over,
  };
}

function makeRecorder() {
  return {
    list: vi.fn(async () => Promise.resolve([recording()])),
    start: vi.fn(async () => Promise.resolve(recording({ endedAt: null }))),
    stop: vi.fn(async () => Promise.resolve(recording())),
    stopAll: vi.fn(async () => Promise.resolve()),
    remove: vi.fn(async () => Promise.resolve(true)),
  };
}

type Response = { status: number; body: string };

async function post(
  control: ReturnType<typeof createRecordControl>,
  options: {
    body?: unknown;
    token?: string | null;
    remoteAddress?: string;
    url?: string;
  } = {},
): Promise<{ handled: boolean; response: Response }> {
  // Buffers, not strings: `readBody` concatenates them, which is what the real
  // http server delivers.
  const req = Readable.from(
    options.body === undefined
      ? []
      : [Buffer.from(JSON.stringify(options.body), "utf8")],
  ) as unknown as http.IncomingMessage;
  req.url = options.url ?? RECORD_PATH;
  req.method = "POST";
  req.headers = {
    ...(options.token === null
      ? {}
      : { authorization: `Bearer ${options.token ?? TOKEN}` }),
  };
  (req as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: options.remoteAddress ?? "127.0.0.1",
  };

  const response: Response = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      response.status = status;
      return res;
    },
    end(chunk?: string) {
      response.body = chunk ?? "";
      return res;
    },
  } as unknown as http.ServerResponse;

  const handled = await control.handle(req, res);
  return { handled, response };
}

describe("createRecordControl", () => {
  it("ignores any other path", async () => {
    const control = createRecordControl({ authToken: TOKEN });
    const { handled } = await post(control, { url: "/_control/devices" });
    expect(handled).toBe(false);
  });

  it("refuses a non-loopback caller before it looks at the token", async () => {
    const recorder = makeRecorder();
    const control = createRecordControl({ authToken: TOKEN, recorder });
    const { response } = await post(control, {
      remoteAddress: "10.0.0.7",
      body: { action: "list" },
    });
    expect(response.status).toBe(403);
    expect(recorder.list).not.toHaveBeenCalled();
  });

  it("refuses a missing or wrong token", async () => {
    const recorder = makeRecorder();
    const control = createRecordControl({ authToken: TOKEN, recorder });

    expect((await post(control, { token: null })).response.status).toBe(401);
    expect(
      (await post(control, { token: "b".repeat(64) })).response.status,
    ).toBe(401);
    expect(recorder.list).not.toHaveBeenCalled();
  });

  it("says plainly when the running build cannot record", async () => {
    // An older bundle should not make an upgrade look broken.
    const control = createRecordControl({ authToken: TOKEN });
    const { response } = await post(control, { body: { action: "list" } });
    expect(response.status).toBe(501);
    expect(JSON.parse(response.body)).toMatchObject({ code: "UNSUPPORTED" });
  });

  it("lists", async () => {
    const recorder = makeRecorder();
    const control = createRecordControl({ authToken: TOKEN, recorder });
    const { response } = await post(control, { body: { action: "list" } });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).recordings).toHaveLength(1);
  });

  it("starts, passing the target and title through", async () => {
    const recorder = makeRecorder();
    const control = createRecordControl({ authToken: TOKEN, recorder });
    const { response } = await post(control, {
      body: {
        action: "start",
        target: { kind: "pane", session: "work", paneId: "%7" },
        title: "a refactor",
      },
    });
    expect(response.status).toBe(200);
    expect(recorder.start).toHaveBeenCalledWith({
      target: { kind: "pane", session: "work", paneId: "%7" },
      title: "a refactor",
    });
  });

  it("reports a recorder failure by its own code", async () => {
    const recorder = makeRecorder();
    recorder.start.mockRejectedValueOnce(
      Object.assign(new Error("That pane already has a pipe running."), {
        code: "PANE_ALREADY_PIPED",
      }),
    );
    const control = createRecordControl({ authToken: TOKEN, recorder });
    const { response } = await post(control, {
      body: {
        action: "start",
        target: { kind: "pane", session: "work", paneId: "%7" },
      },
    });
    expect(response.status).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      code: "PANE_ALREADY_PIPED",
    });
  });

  it("404s stopping or deleting something that is not there", async () => {
    const recorder = makeRecorder();
    recorder.stop.mockResolvedValueOnce(null as never);
    recorder.remove.mockResolvedValueOnce(false);
    const control = createRecordControl({ authToken: TOKEN, recorder });

    expect(
      (await post(control, { body: { action: "stop", id: "rec_x" } })).response
        .status,
    ).toBe(404);
    expect(
      (await post(control, { body: { action: "delete", id: "rec_x" } }))
        .response.status,
    ).toBe(404);
  });

  it("rejects a missing, unparseable or unknown action", async () => {
    const control = createRecordControl({
      authToken: TOKEN,
      recorder: makeRecorder(),
    });
    expect((await post(control)).response.status).toBe(400);
    expect(
      (await post(control, { body: { action: "teleport" } })).response.status,
    ).toBe(400);
  });

  it("caps the body so a stray POST cannot buffer without bound", async () => {
    const control = createRecordControl({
      authToken: TOKEN,
      recorder: makeRecorder(),
    });
    const { response } = await post(control, {
      body: { action: "start", title: "x".repeat(20_000) },
    });
    expect(response.status).toBe(400);
  });
});

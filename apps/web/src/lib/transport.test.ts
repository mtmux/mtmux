import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  FrameSealer,
  FrameOpener,
  deriveSessionKeys,
  randomBytes,
  utf8ToBytes,
  bytesToBase64Url,
  base64UrlToBytes,
} from "@repo/crypto";
import { DirectTransport, SealedTransport } from "./transport";

/** Minimal WebSocket stand-in the tests drive by hand. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  bufferedAmount = 0;
  sent: string[] = [];
  closed = false;

  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  parsed() {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

function handlers() {
  const opened: number[] = [];
  const messages: string[] = [];
  const closes: number[] = [];
  return {
    onOpen: () => opened.push(1),
    onMessage: (t: string) => messages.push(t),
    onClose: () => closes.push(1),
    opened,
    messages,
    closes,
  };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => vi.unstubAllGlobals());

describe("DirectTransport", () => {
  it("passes text straight through in both directions", () => {
    const h = handlers();
    const t = new DirectTransport("ws://relay.test/_relay");
    t.connect(h);
    latest().open();
    expect(h.opened).toHaveLength(1);

    t.send("hello");
    expect(latest().sent).toEqual(["hello"]);

    latest().onmessage?.({ data: "world" });
    expect(h.messages).toEqual(["world"]);
  });

  it("drops sends before the socket is open", () => {
    const t = new DirectTransport("ws://relay.test/_relay");
    t.connect(handlers());
    t.send("too early");
    expect(latest().sent).toEqual([]);
  });

  it("detaches on close so a late event cannot call back", () => {
    const h = handlers();
    const t = new DirectTransport("ws://relay.test/_relay");
    t.connect(h);
    const ws = latest();
    ws.open();

    t.close();
    // A real browser can still deliver these after close().
    ws.onclose?.();
    ws.onmessage?.({ data: "ghost" });
    expect(h.closes).toHaveLength(0);
    expect(h.messages).toEqual([]);
  });

  it("reports a construction failure as a close", () => {
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor() {
          throw new Error("blocked");
        }
      },
    );
    const h = handlers();
    new DirectTransport("ws://relay.test/_relay").connect(h);
    expect(h.closes).toHaveLength(1);
  });

  it("exposes the socket's buffered amount for backpressure", () => {
    const t = new DirectTransport("ws://relay.test/_relay");
    t.connect(handlers());
    latest().open();
    latest().bufferedAmount = 4096;
    expect(t.bufferedAmount).toBe(4096);
  });
});

describe("SealedTransport", () => {
  const keys = deriveSessionKeys(randomBytes(64), utf8ToBytes("transcript"));
  const url = "wss://api.test/v1/tunnel/tnl-abcdefgh";

  /** The CLI's side of the same stream. */
  function peer() {
    return {
      opener: new FrameOpener(keys.c2s, "c2s"),
      sealer: new FrameSealer(keys.s2c, "s2c"),
    };
  }

  function connected() {
    const h = handlers();
    const t = new SealedTransport({ url, keys });
    t.connect(h);
    latest().open();
    latest().deliver({ type: "stream:open", streamId: "str-1" });
    return { t, h, ws: latest() };
  }

  it("only reports open once the broker has assigned a stream", () => {
    const h = handlers();
    const t = new SealedTransport({ url, keys });
    t.connect(h);
    latest().open();
    expect(h.opened).toHaveLength(0);
    expect(t.isOpen).toBe(false);

    latest().deliver({ type: "stream:open", streamId: "str-1" });
    expect(h.opened).toHaveLength(1);
    expect(t.isOpen).toBe(true);
  });

  it("seals outbound text so the plaintext never appears on the wire", async () => {
    const p = peer();
    const { t } = connected();
    t.send('{"type":"terminal:input","data":"SECRET"}');
    await vi.waitFor(() => expect(latest().sent.length).toBeGreaterThan(0));

    const frame = latest().parsed()[0]!;
    expect(frame.type).toBe("stream:frame");
    expect(JSON.stringify(frame)).not.toContain("SECRET");

    const opened = await p.opener.open(base64UrlToBytes(frame.data as string));
    expect(new TextDecoder().decode(opened)).toBe(
      '{"type":"terminal:input","data":"SECRET"}',
    );
  });

  it("unseals inbound frames back into plain relay JSON", async () => {
    const { h, ws } = connected();
    const p = peer();
    const sealed = await p.sealer.seal(utf8ToBytes('{"type":"pong"}'));

    ws.deliver({
      type: "stream:frame",
      streamId: "str-1",
      data: bytesToBase64Url(sealed),
    });
    await vi.waitFor(() => expect(h.messages).toEqual(['{"type":"pong"}']));
  });

  it("queues writes made before the stream exists", async () => {
    const h = handlers();
    const t = new SealedTransport({ url, keys });
    t.connect(h);
    latest().open();

    t.send("early");
    expect(latest().sent).toHaveLength(0);

    latest().deliver({ type: "stream:open", streamId: "str-1" });
    await vi.waitFor(() => expect(latest().sent.length).toBe(1));
    const opened = await peer().opener.open(
      base64UrlToBytes(latest().parsed()[0]!.data as string),
    );
    expect(new TextDecoder().decode(opened)).toBe("early");
  });

  it("kills the connection on a tampered frame rather than passing it through", async () => {
    const { h, ws } = connected();
    const p = peer();
    const sealed = await p.sealer.seal(utf8ToBytes("legit"));
    sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 0xff;

    ws.deliver({
      type: "stream:frame",
      streamId: "str-1",
      data: bytesToBase64Url(sealed),
    });
    await vi.waitFor(() => expect(h.closes).toHaveLength(1));
    expect(h.messages).toEqual([]);
  });

  it("kills the connection on a replayed frame", async () => {
    const { h, ws } = connected();
    const p = peer();
    const sealed = await p.sealer.seal(utf8ToBytes("once"));
    const data = bytesToBase64Url(sealed);

    ws.deliver({ type: "stream:frame", streamId: "str-1", data });
    await vi.waitFor(() => expect(h.messages).toEqual(["once"]));

    ws.deliver({ type: "stream:frame", streamId: "str-1", data });
    await vi.waitFor(() => expect(h.closes).toHaveLength(1));
    expect(h.messages).toEqual(["once"]);
  });

  it("closes when the broker reports the tunnel is gone", () => {
    const { h, ws } = connected();
    ws.deliver({ type: "tunnel:closed", reason: "agent-gone" });
    expect(h.closes).toHaveLength(1);
  });

  it("ignores frames it cannot parse", () => {
    const { h, ws } = connected();
    ws.onmessage?.({ data: "{not json" });
    ws.deliver({ type: "nonsense" });
    expect(h.closes).toHaveLength(0);
    expect(h.messages).toEqual([]);
  });

  it("restarts its nonce counters on reconnect", async () => {
    const t = new SealedTransport({ url, keys });
    const h1 = handlers();
    t.connect(h1);
    latest().open();
    latest().deliver({ type: "stream:open", streamId: "str-1" });
    t.send("first");
    await vi.waitFor(() => expect(latest().sent.length).toBe(1));
    const firstFrame = latest().parsed()[0]!.data as string;

    t.close();
    const h2 = handlers();
    t.connect(h2);
    latest().open();
    latest().deliver({ type: "stream:open", streamId: "str-2" });
    t.send("first");
    await vi.waitFor(() => expect(latest().sent.length).toBe(1));
    const secondFrame = latest().parsed()[0]!.data as string;

    // Same plaintext, same key, counter back to zero — so a fresh opener on
    // the peer side can read it. (The ciphertexts differ only because GCM is
    // deterministic given key+nonce; here they must match, which is exactly
    // why both ends must reset together.)
    expect(base64UrlToBytes(firstFrame).slice(0, 8)).toEqual(
      base64UrlToBytes(secondFrame).slice(0, 8),
    );
    const opened = await new FrameOpener(keys.c2s, "c2s").open(
      base64UrlToBytes(secondFrame),
    );
    expect(new TextDecoder().decode(opened)).toBe("first");
  });

  it("detaches on close", async () => {
    const { t, h, ws } = connected();
    t.close();
    ws.onclose?.();
    ws.deliver({ type: "stream:frame", streamId: "str-1", data: "AA" });
    await Promise.resolve();
    expect(h.closes).toHaveLength(0);
    expect(h.messages).toEqual([]);
  });
});

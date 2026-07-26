import {
  FrameOpener,
  FrameSealer,
  bytesToBase64Url,
  base64UrlToBytes,
  type SessionKeys,
} from "@repo/crypto";
import { tryDeserializeTunnelServerMessage } from "@repo/protocol";

/**
 * The socket seam under RelayClient.
 *
 * RelayClient owns reconnect, backoff, zombie detection and the pending-message
 * queue; all of that is transport-agnostic and stays exactly as it was. What
 * changes between the direct and tunnelled paths is only how a line of JSON
 * gets from here to the relay.
 *
 * `DirectTransport` is today's behaviour verbatim — a plain WebSocket — so the
 * self-hosted path is untouched. `SealedTransport` carries the same JSON inside
 * AES-GCM frames over the broker's tunnel, where the broker is a blind
 * forwarder.
 */

export type TransportHandlers = {
  onOpen: () => void;
  onMessage: (text: string) => void;
  onClose: () => void;
};

export interface Transport {
  connect(handlers: TransportHandlers): void;
  send(text: string): void;
  /** Detach handlers and close. A closed transport must never call back. */
  close(): void;
  readonly isOpen: boolean;
  /** Bytes queued locally, for the client's backpressure check. */
  readonly bufferedAmount: number;
}

export type TransportFactory = () => Transport;

/** A plain WebSocket. Behaviourally identical to the pre-seam client. */
export class DirectTransport implements Transport {
  private ws: WebSocket | null = null;
  private detached = false;

  constructor(private readonly url: string) {}

  connect(handlers: TransportHandlers): void {
    this.detached = false;
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      // Surface a construction failure as a close, so the client's existing
      // reconnect path handles it rather than needing a second error channel.
      handlers.onClose();
      return;
    }
    this.ws.onopen = () => {
      if (!this.detached) handlers.onOpen();
    };
    this.ws.onmessage = (event) => {
      if (!this.detached) handlers.onMessage(event.data as string);
    };
    this.ws.onclose = () => {
      if (!this.detached) handlers.onClose();
    };
    this.ws.onerror = () => {
      // onclose always follows.
    };
  }

  send(text: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
  }

  close(): void {
    this.detached = true;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // Already closing or closed.
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }
}

export type SealedTransportOptions = {
  /** `wss://api.mtmux.com/v1/tunnel/<tunnelId>` */
  url: string;
  keys: SessionKeys;
};

/**
 * The same relay protocol, sealed end-to-end and forwarded by the broker.
 *
 * Every outbound line is AES-GCM sealed and wrapped in a `stream:frame`; every
 * inbound frame is unsealed before RelayClient ever sees it. The broker holds
 * no key that opens either direction, and a tampered or replayed frame kills
 * the connection rather than being passed through — the frame codec enforces a
 * strictly increasing counter.
 */
export class SealedTransport implements Transport {
  private ws: WebSocket | null = null;
  private detached = false;
  private streamId: string | null = null;
  private sealer: FrameSealer;
  private opener: FrameOpener;
  /** Lines written before the broker assigned a stream id. */
  private queued: string[] = [];
  private handlers: TransportHandlers | null = null;

  constructor(private readonly opts: SealedTransportOptions) {
    // The browser seals on c2s and opens s2c; the CLI is the mirror image.
    this.sealer = new FrameSealer(opts.keys.c2s, "c2s");
    this.opener = new FrameOpener(opts.keys.s2c, "s2c");
  }

  connect(handlers: TransportHandlers): void {
    this.detached = false;
    this.handlers = handlers;
    this.streamId = null;
    this.queued = [];
    // Fresh counters per connection: the key schedule is per pairing, but nonce
    // reuse across reconnects would be catastrophic, so both ends restart at 0.
    this.sealer = new FrameSealer(this.opts.keys.c2s, "c2s");
    this.opener = new FrameOpener(this.opts.keys.s2c, "s2c");

    try {
      this.ws = new WebSocket(this.opts.url);
    } catch {
      handlers.onClose();
      return;
    }

    this.ws.onopen = () => {
      // Deliberately silent: the relay-level "open" only means something once
      // the broker has assigned a stream, which arrives as stream:open.
    };

    this.ws.onmessage = (event) => {
      if (this.detached) return;
      void this.handleFrame(event.data as string);
    };

    this.ws.onclose = () => {
      if (!this.detached) handlers.onClose();
    };

    this.ws.onerror = () => {
      // onclose always follows.
    };
  }

  private async handleFrame(raw: string): Promise<void> {
    const parsed = tryDeserializeTunnelServerMessage(raw);
    if (!parsed.ok) return;
    const msg = parsed.message;

    if (msg.type === "stream:open") {
      this.streamId = msg.streamId;
      for (const text of this.queued.splice(0)) this.send(text);
      this.handlers?.onOpen();
      return;
    }

    if (msg.type === "stream:close" || msg.type === "tunnel:closed") {
      this.close();
      this.handlers?.onClose();
      return;
    }

    if (msg.type !== "stream:frame") return;

    try {
      const opened = await this.opener.open(base64UrlToBytes(msg.data));
      if (!this.detached) {
        this.handlers?.onMessage(new TextDecoder().decode(opened));
      }
    } catch {
      // Tampered, replayed or reordered. There is no safe way to continue on a
      // stream whose integrity has failed, so the connection dies and the
      // client's normal reconnect path takes over.
      const handlers = this.handlers;
      this.close();
      handlers?.onClose();
    }
  }

  send(text: string): void {
    if (this.streamId === null) {
      this.queued.push(text);
      return;
    }
    const streamId = this.streamId;
    void this.sealer
      .seal(new TextEncoder().encode(text))
      .then((sealed) => {
        if (this.detached || this.ws?.readyState !== WebSocket.OPEN) return;
        this.ws.send(
          JSON.stringify({
            type: "stream:frame",
            streamId,
            data: bytesToBase64Url(sealed),
          }),
        );
      })
      .catch(() => {
        // Sealing cannot fail in practice; if WebCrypto is unavailable the
        // constructor already threw.
      });
  }

  close(): void {
    this.detached = true;
    const ws = this.ws;
    this.ws = null;
    this.streamId = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // Already closing or closed.
    }
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.streamId !== null;
  }

  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }
}

export function directTransport(url: string): TransportFactory {
  return () => new DirectTransport(url);
}

export function sealedTransport(
  opts: SealedTransportOptions,
): TransportFactory {
  return () => new SealedTransport(opts);
}

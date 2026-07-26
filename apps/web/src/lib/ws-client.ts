import {
  serialize,
  tryDeserializeServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "@repo/protocol";

type MessageHandler = (msg: ServerMessage) => void;
type StatusHandler = (
  status: "connecting" | "connected" | "reconnecting" | "disconnected",
) => void;

interface RelayClientOptions {
  url: string;
  token: string;
  onMessage?: MessageHandler;
  onStatusChange?: StatusHandler;
  onMessageDropped?: (droppedCount: number) => void;
}

const MIN_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;
const MAX_PENDING_MESSAGES = 50;

/**
 * Messages that must NOT survive a disconnect.
 *
 * Everything used to be queued and replayed on reconnect, which meant keystrokes
 * typed against a dead socket were injected into the live shell minutes later
 * (and made ConnectionBanner's "input paused" copy a lie), and a stale
 * `session:attach` was flushed *before* the message handlers ran — racing the
 * fresh attach and respawning the PTY twice.
 *
 * Attach/detach are re-driven by TerminalView's status-dependent effect, and
 * resize is re-driven by the next fit, so dropping them loses nothing.
 */
const DROP_WHEN_DISCONNECTED: ReadonlySet<ClientMessage["type"]> = new Set([
  "terminal:input",
  "terminal:resize",
  "command:send",
  "tmux:prefix",
  "session:attach",
  "session:detach",
]);

/** Idempotent reads that are safe (and useful) to replay once connected. */
function shouldQueue(msg: ClientMessage): boolean {
  if (msg.type === "ping") return false;
  return !DROP_WHEN_DISCONNECTED.has(msg.type);
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private url: string;
  private token: string;
  private messageHandlers: Set<MessageHandler> = new Set();
  private statusHandlers: Set<StatusHandler> = new Set();
  private reconnectDelay = MIN_RECONNECT_DELAY;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private intentionalClose = false;
  private _status:
    | "connecting"
    | "connected"
    | "reconnecting"
    | "disconnected" = "disconnected";
  private _latency: number | null = null;
  private _reconnectCount = 0;
  // #15: Track last pong for zombie connection detection
  private lastPongAt = 0;
  // #12: Queue messages while disconnected
  private pendingMessages: ClientMessage[] = [];
  private onMessageDroppedHandler: ((droppedCount: number) => void) | null =
    null;

  constructor(options: RelayClientOptions) {
    this.url = options.url;
    this.token = options.token;
    if (options.onMessage) this.messageHandlers.add(options.onMessage);
    if (options.onStatusChange) this.statusHandlers.add(options.onStatusChange);
    if (options.onMessageDropped)
      this.onMessageDroppedHandler = options.onMessageDropped;
  }

  get status() {
    return this._status;
  }

  get latency() {
    return this._latency;
  }

  get reconnectCount() {
    return this._reconnectCount;
  }

  private setStatus(status: typeof this._status) {
    this._status = status;
    for (const handler of this.statusHandlers) {
      handler(status);
    }
  }

  connect(): void {
    // Always clear a pending reconnect timer first so a queued reconnect can't
    // fire a second connect() and open a parallel socket (e.g. the `online`
    // event handler and a scheduled reconnect racing each other).
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Guard: if a socket is already connecting or open, don't open another.
    // This makes concurrent connect() calls idempotent.
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CONNECTING ||
        this.ws.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    // Tear down any previous (closing/closed) socket so its stale handlers —
    // especially onclose — can't schedule another reconnect against us or
    // deliver messages onto the new connection.
    if (this.ws) {
      this.teardownSocket(this.ws);
      this.ws = null;
    }

    this.intentionalClose = false;
    this.setStatus(this._reconnectCount > 0 ? "reconnecting" : "connecting");

    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      // Send auth message immediately
      this.sendRaw(serialize({ type: "auth", token: this.token }));
    };

    this.ws.onmessage = (event) => {
      const result = tryDeserializeServerMessage(event.data as string);
      if (!result.ok) return;

      const msg = result.message;

      if (msg.type === "auth:success") {
        this.setStatus("connected");
        this.reconnectDelay = MIN_RECONNECT_DELAY;
        this._reconnectCount = 0;
        this.startPing();
        this.flushPendingMessages();
      }

      if (msg.type === "auth:failure") {
        this.intentionalClose = true;
        this.ws?.close();
        this.setStatus("disconnected");
      }

      if (msg.type === "pong") {
        this._latency = Date.now() - msg.timestamp;
        this.lastPongAt = Date.now();
      }

      for (const handler of this.messageHandlers) {
        handler(msg);
      }
    };

    this.ws.onclose = () => {
      this.stopPing();
      if (!this.intentionalClose) {
        this.setStatus("reconnecting");
        this.scheduleReconnect();
      } else {
        this.setStatus("disconnected");
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      // Detach handlers before dropping the reference. Merely calling close()
      // leaves an orphaned socket whose late onclose still runs and re-emits a
      // status — enough to knock a freshly reconnected client back to
      // "reconnecting", after which send() silently queues forever.
      this.teardownSocket(this.ws);
      this.ws = null;
    }
    this.setStatus("disconnected");
  }

  send(msg: ClientMessage): void {
    // Only send once the relay has confirmed auth (status === "connected").
    // The WS readyState becomes OPEN at handshake — before auth:success — so
    // sending here would race the auth handler and get dropped by the relay.
    if (
      this.ws?.readyState === WebSocket.OPEN &&
      this._status === "connected"
    ) {
      this.ws.send(serialize(msg));
      return;
    }
    if (!shouldQueue(msg)) return;
    this.pendingMessages.push(msg);
    if (this.pendingMessages.length > MAX_PENDING_MESSAGES) {
      const dropped = this.pendingMessages.length - MAX_PENDING_MESSAGES;
      this.pendingMessages.splice(0, dropped);
      // Report how many were actually discarded — this used to pass the
      // post-trim queue length, so the toast always said "50".
      this.onMessageDroppedHandler?.(dropped);
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatusChange(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  /**
   * Detach all handlers from a socket and close it. Detaching first ensures
   * an orphaned socket's onclose can't schedule another reconnect, and its
   * onmessage can't leak messages onto a freshly created connection.
   */
  private teardownSocket(ws: WebSocket): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // ignore — socket may already be closing/closed
    }
  }

  private sendRaw(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;

    this._reconnectCount++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      MAX_RECONNECT_DELAY,
    );
  }

  private startPing(): void {
    // Idempotent — a duplicate auth:success on one socket would otherwise leak
    // an interval.
    this.stopPing();
    this.lastPongAt = Date.now();
    this.pingTimer = setInterval(() => {
      // #15: Zombie detection — if missed 2+ pongs (>25s), force reconnect
      if (this.lastPongAt && Date.now() - this.lastPongAt > 25000) {
        this.ws?.close();
        return;
      }
      // Close if send buffer is backed up (>1MB)
      if (this.ws && this.ws.bufferedAmount > 1_048_576) {
        this.ws.close();
        return;
      }
      this.send({ type: "ping", timestamp: Date.now() });
    }, 10000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private flushPendingMessages(): void {
    const messages = this.pendingMessages.splice(0);
    for (const msg of messages) {
      this.send(msg);
    }
  }
}

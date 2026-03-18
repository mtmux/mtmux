import {
  serialize,
  tryDeserializeServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "@repo/protocol";

type MessageHandler = (msg: ServerMessage) => void;
type StatusHandler = (status: "connecting" | "connected" | "reconnecting" | "disconnected") => void;

interface RelayClientOptions {
  url: string;
  token: string;
  onMessage?: MessageHandler;
  onStatusChange?: StatusHandler;
}

const MIN_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;

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
  private _status: "connecting" | "connected" | "reconnecting" | "disconnected" = "disconnected";
  private _latency: number | null = null;
  private _reconnectCount = 0;
  // #15: Track last pong for zombie connection detection
  private lastPongAt = 0;

  constructor(options: RelayClientOptions) {
    this.url = options.url;
    this.token = options.token;
    if (options.onMessage) this.messageHandlers.add(options.onMessage);
    if (options.onStatusChange) this.statusHandlers.add(options.onStatusChange);
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
      this.ws.close();
      this.ws = null;
    }
    this.setStatus("disconnected");
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(serialize(msg));
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

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  private startPing(): void {
    this.lastPongAt = Date.now();
    this.pingTimer = setInterval(() => {
      // #15: Zombie detection — if missed 2+ pongs (>25s), force reconnect
      if (this.lastPongAt && Date.now() - this.lastPongAt > 25000) {
        this.ws?.close();
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
}

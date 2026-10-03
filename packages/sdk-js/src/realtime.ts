// WebSocket link: subscribe to a world/player, receive directives, upgrades, chunks and job updates.
// Reconnects with backoff and re-subscribes; reports status so asks can switch to long-polling while it is down.
import { WS_PATH, type WsClientMessage, type WsServerMessage } from "@liveforge/protocol";
import { Emitter } from "./emitter.js";
import { backoffMs, isPlainObject, joinUrl, withQuery } from "./util.js";

/**
 * - `idle`: not started (realtime disabled or client closed)
 * - `connecting`: opening a socket
 * - `open`: connected and subscribed
 * - `reconnecting`: lost; waiting to retry (asks long-poll meanwhile)
 * - `unavailable`: several attempts failed in a row (no WebSocket support, proxy, server down); still retrying slowly
 */
export type RealtimeStatus = "idle" | "connecting" | "open" | "reconnecting" | "unavailable";

export type WebSocketCtor = new (url: string) => WebSocket;

export interface RealtimeOptions {
  url: string;
  key: string;
  world: string;
  player: string;
  WebSocket?: WebSocketCtor;
  /** Client ping interval (ms). Default 25 000. */
  pingMs?: number;
  /** Close and reconnect when nothing arrived for this long (ms). Default 75 000. */
  staleMs?: number;
  debug?: boolean;
}

type RealtimeEvents = {
  message: (msg: WsServerMessage) => void;
  status: (status: RealtimeStatus) => void;
};

/** Internal: the client owns one Realtime. */
export class Realtime extends Emitter<RealtimeEvents> {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private _status: RealtimeStatus = "idle";
  private world: string;
  private player: string;

  constructor(private readonly opts: RealtimeOptions) {
    super();
    this.world = opts.world;
    this.player = opts.player;
  }

  get status(): RealtimeStatus {
    return this._status;
  }

  get isOpen(): boolean {
    return this._status === "open";
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try {
        ws.close(1000, "client closed");
      } catch {
        /* already closed */
      }
    }
    this.setStatus("idle");
  }

  /** Moves the subscription to another world / player without reconnecting. */
  resubscribe(world: string, player: string): void {
    const prev = { world: this.world, player: this.player };
    this.world = world;
    this.player = player;
    if (this.ws && this.ws.readyState === 1) {
      this.send({ t: "unsubscribe", world: prev.world, player: prev.player });
      this.send({ t: "subscribe", world, player });
    }
  }

  send(msg: WsClientMessage): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    const Ctor = this.opts.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!Ctor) {
      this.setStatus("unavailable");
      if (this.opts.debug) console.warn("[liveforge] no WebSocket implementation: upgrades use long-polling, directives are unavailable");
      return;
    }
    const httpUrl = withQuery(joinUrl(this.opts.url, WS_PATH), { key: this.opts.key, world: this.world, player: this.player });
    const wsUrl = httpUrl.replace(/^http/, "ws");
    this.setStatus(this.attempt >= 3 ? "unavailable" : "connecting");
    let ws: WebSocket;
    try {
      ws = new Ctor(wsUrl);
    } catch (err) {
      if (this.opts.debug) console.warn("[liveforge] WebSocket failed to open", err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      // The query already subscribes; an explicit subscribe keeps older servers / proxies happy and is idempotent.
      this.send({ t: "subscribe", world: this.world, player: this.player });
      this.setStatus("open");
      this.startPing();
    };
    ws.onmessage = (ev: MessageEvent) => {
      this.lastMessageAt = Date.now();
      if (typeof ev.data !== "string") return;
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (isPlainObject(msg) && typeof msg.t === "string") this.emit("message", msg as WsServerMessage);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = backoffMs(this.attempt, 500, this.attempt >= 6 ? 30_000 : 15_000);
    this.attempt++;
    this.setStatus(this.attempt >= 3 ? "unavailable" : "reconnecting");
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    const pingMs = this.opts.pingMs ?? 25_000;
    const staleMs = this.opts.staleMs ?? 75_000;
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > staleMs) {
        // Half-open socket: force a reconnect.
        try {
          this.ws?.close(4000, "stale");
        } catch {
          /* ignore */
        }
        return;
      }
      this.send({ t: "ping", ts: Date.now() });
    }, pingMs);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private setStatus(s: RealtimeStatus): void {
    if (s === this._status) return;
    this._status = s;
    this.emit("status", s);
  }
}

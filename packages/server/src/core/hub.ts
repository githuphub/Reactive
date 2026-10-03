// WebSocket hub: GET /v1/ws?key=...[&game=][&world=&player=]. Subscriptions per (game, world, player?) + topics.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  PROTOCOL_ID, WS_PATH, WsClientMessage, type AnyAskResponse, type Directive, type StoredEvent, type WsServerMessage, type WsTopic,
} from "@liveforge/protocol";
import type { Logger } from "../log.js";

const DEFAULT_TOPICS: WsTopic[] = ["directives", "upgrades", "chunks", "jobs"];

interface Sub {
  world: string;
  player: string | null;
  topics: Set<WsTopic>;
}

interface Conn {
  id: string;
  ws: WebSocket;
  game: string;
  admin: boolean;
  subs: Sub[];
  alive: boolean;
}

export type WsAuth = (key: string | null, gameParam: string | null) => { game: string; admin: boolean } | null;

export class WsHub {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly conns = new Set<Conn>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly log: Logger) {}

  get size(): number {
    return this.conns.size;
  }

  count(game: string): number {
    let n = 0;
    for (const c of this.conns) if (c.game === game) n++;
    return n;
  }

  attach(server: Server, auth: WsAuth): void {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname !== WS_PATH) return; // other upgrade handlers may exist
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? null;
      const who = auth(url.searchParams.get("key") ?? bearer ?? (req.headers["x-liveforge-key"] as string | undefined) ?? null, url.searchParams.get("game"));
      if (!who) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n" + JSON.stringify({ error: { code: "unauthorized", message: "invalid or missing key" } }));
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnect(ws, who.game, who.admin, url));
    });
    this.pingTimer = setInterval(() => {
      for (const c of this.conns) {
        if (!c.alive) { c.ws.terminate(); continue; }
        c.alive = false;
        try { c.ws.ping(); } catch { /* closed */ }
      }
    }, 30_000);
  }

  private onConnect(ws: WebSocket, game: string, admin: boolean, url: URL): void {
    const c: Conn = { id: randomUUID(), ws, game, admin, subs: [], alive: true };
    this.conns.add(c);
    ws.on("pong", () => (c.alive = true));
    ws.on("close", () => this.conns.delete(c));
    ws.on("error", () => this.conns.delete(c));
    ws.on("message", (raw) => this.onMessage(c, raw.toString()));
    this.send(c, { t: "welcome", protocol: PROTOCOL_ID, game, connId: c.id, serverTime: Date.now(), admin });
    const world = url.searchParams.get("world");
    if (world) {
      const topics = (url.searchParams.get("topics")?.split(",").filter(Boolean) as WsTopic[] | undefined) ?? undefined;
      this.subscribe(c, world, url.searchParams.get("player"), topics);
    }
  }

  private onMessage(c: Conn, raw: string): void {
    let msg: WsClientMessage;
    try {
      const parsed = WsClientMessage.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "bad message");
      msg = parsed.data;
    } catch (e) {
      this.send(c, { t: "error", error: { code: "bad_request", message: `bad ws message: ${(e as Error).message}` } });
      return;
    }
    if (msg.t === "ping") this.send(c, { t: "pong", ts: msg.ts, serverTime: Date.now() });
    else if (msg.t === "subscribe") this.subscribe(c, msg.world, msg.player ?? null, msg.topics);
    else if (msg.t === "unsubscribe") c.subs = c.subs.filter((s) => !(s.world === msg.world && s.player === (msg.player ?? null)));
  }

  private subscribe(c: Conn, world: string, player: string | null, topics?: WsTopic[]): void {
    let t = new Set<WsTopic>(topics?.length ? topics : DEFAULT_TOPICS);
    if (t.has("events") && !c.admin) {
      t.delete("events");
      this.send(c, { t: "error", error: { code: "forbidden", message: "topic 'events' needs the admin key" } });
    }
    c.subs = c.subs.filter((s) => !(s.world === world && s.player === player));
    c.subs.push({ world, player, topics: t });
    this.send(c, { t: "subscribed", world, player, topics: [...t] });
  }

  private send(c: Conn, msg: WsServerMessage): void {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    try {
      c.ws.send(JSON.stringify(msg));
    } catch (e) {
      this.log.warn("ws send failed", { conn: c.id, error: e as Error });
    }
  }

  /** Deliver to sockets subscribed to (world, player) with `topic`. player=null => world-wide (every sub of the world). */
  private deliver(game: string, world: string, player: string | null, topic: WsTopic, msg: WsServerMessage): number {
    let n = 0;
    for (const c of this.conns) {
      if (c.game !== game) continue;
      // admin spectators (subscribed without a player) see every player's directives / jobs in the world
      const hit = c.subs.some((s) => s.world === world && s.topics.has(topic) && (player === null || s.player === player || (c.admin && s.player === null && (topic === "directives" || topic === "jobs"))));
      if (hit) { this.send(c, msg); n++; }
    }
    return n;
  }

  directive(game: string, d: Directive): number {
    return this.deliver(game, d.world, d.player, "directives", { t: "directive", directive: d });
  }

  upgrade(game: string, world: string, player: string, response: AnyAskResponse): number {
    return this.deliver(game, world, player, "upgrades", { t: "upgrade", response });
  }

  chunk(game: string, world: string, player: string, id: string, seq: number, text: string, done: boolean): number {
    return this.deliver(game, world, player, "chunks", { t: "chunk", id, seq, text, done });
  }

  job(game: string, world: string, player: string | null, id: string, state: "queued" | "generating" | "done" | "failed", url?: string): number {
    return this.deliver(game, world, player, "jobs", { t: "job", id, state, ...(url ? { url } : {}) });
  }

  /** Admin firehose. */
  event(e: StoredEvent): number {
    let n = 0;
    for (const c of this.conns) {
      if (c.game !== e.game || !c.admin) continue;
      if (c.subs.some((s) => s.world === e.world && s.topics.has("events") && (s.player === null || s.player === e.player))) {
        this.send(c, { t: "event", event: e });
        n++;
      }
    }
    return n;
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const c of this.conns) c.ws.close(1001, "server shutting down");
    this.wss.close();
  }
}

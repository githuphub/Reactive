// @liveforge/sdk - JS/TS client (K0 typed stub; K4 owns and completes it: batching/retry policy, reconnect,
// long-poll fallback, fallback cache + bake packs, snapshots). The public surface below is the contract.
import type {
  AnyAskResponse, AskKind, AskParamsInput, AskResponse, Directive, DirectiveKind, PublicConfig, SignalBatchResult,
  SignalInput, TypedDirective, WsServerMessage,
} from "@liveforge/protocol";

export type * from "@liveforge/protocol";

export interface LiveforgeClientOptions {
  /** Server base URL, e.g. "http://localhost:8787". */
  url: string;
  /** Publishable SDK key for this game. */
  key: string;
  world: string;
  player: string;
  /** Default: random per client. */
  session?: string;
  /** Signal batching: flush after this many ms (default 250) or this many signals (default 50). */
  flushMs?: number;
  flushMax?: number;
  /** Open the WebSocket on connect() (default true). */
  websocket?: boolean;
  fetch?: typeof fetch;
}

/** Result of ask(): the instant answer now, the upgrade later. */
export interface AskHandle<K extends AskKind> {
  id: string;
  /** Resolves with the instant answer (rules / cache / bake). */
  instant: Promise<AskResponse<K>>;
  /** Resolves with the AI upgrade, or null when none is coming (upgrade:"none" or it failed: source !== "ai"). */
  upgrade: Promise<AskResponse<K> | null>;
  /** Streamed text chunks (npc.reply with stream:true). */
  onChunk(cb: (text: string, seq: number) => void): void;
}

type Listener<T> = (v: T) => void;

export class LiveforgeClient {
  readonly session: string;
  private queue: SignalInput[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ws: WebSocket | null = null;
  private readonly directiveListeners = new Map<string, Set<Listener<Directive>>>();
  private readonly upgradeWaiters = new Map<string, (r: AnyAskResponse | null) => void>();
  private readonly chunkListeners = new Map<string, Listener<{ text: string; seq: number }>[]>();
  private readonly f: typeof fetch;

  constructor(readonly opts: LiveforgeClientOptions) {
    this.session = opts.session ?? `s_${Math.random().toString(36).slice(2, 10)}`;
    this.f = opts.fetch ?? fetch.bind(globalThis);
  }

  private async http<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.f(`${this.opts.url.replace(/\/+$/, "")}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.opts.key}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null as T;
    const json = await res.json();
    if (!res.ok) throw Object.assign(new Error(json?.error?.message ?? `HTTP ${res.status}`), { code: json?.error?.code, status: res.status });
    return json as T;
  }

  /** Fetch public config and open the WebSocket. */
  async connect(): Promise<PublicConfig> {
    const cfg = await this.http<PublicConfig>("GET", "/v1/config");
    if (this.opts.websocket !== false && typeof WebSocket !== "undefined") this.openWs();
    return cfg;
  }

  private openWs(): void {
    const u = new URL(this.opts.url);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/v1/ws";
    u.search = new URLSearchParams({ key: this.opts.key, world: this.opts.world, player: this.opts.player }).toString();
    const ws = new WebSocket(u.toString());
    this.ws = ws;
    ws.onmessage = (ev) => {
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.t === "directive") {
        for (const k of [msg.directive.kind, "*"]) this.directiveListeners.get(k)?.forEach((l) => l(msg.directive));
      } else if (msg.t === "upgrade") {
        this.upgradeWaiters.get(msg.response.id)?.(msg.response);
        this.upgradeWaiters.delete(msg.response.id);
      } else if (msg.t === "chunk" && msg.text) {
        this.chunkListeners.get(msg.id)?.forEach((l) => l({ text: msg.text, seq: msg.seq }));
      }
    };
    ws.onclose = () => {
      this.ws = null;
      // K4: reconnect with backoff + re-subscribe
    };
  }

  /** Fire-and-forget signal (batched). */
  signal(type: string, data: Record<string, unknown> = {}): void {
    this.queue.push({ type, data, ts: Date.now(), world: this.opts.world, player: this.opts.player, session: this.session });
    if (this.queue.length >= (this.opts.flushMax ?? 50)) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.opts.flushMs ?? 250);
  }

  async flush(): Promise<SignalBatchResult | null> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.queue.length) return null;
    const signals = this.queue.splice(0, 500);
    return this.http<SignalBatchResult>("POST", "/v1/signals", { signals });
  }

  /** Two-stage ask. */
  ask<K extends AskKind>(kind: K, params: AskParamsInput<K>, opts: { upgrade?: boolean } = {}): AskHandle<K> {
    const id = `ask_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    let resolveUp!: (r: AskResponse<K> | null) => void;
    const upgrade = new Promise<AskResponse<K> | null>((r) => (resolveUp = r));
    this.upgradeWaiters.set(id, (r) => resolveUp(r && r.source === "ai" ? (r as AskResponse<K>) : null));
    const instant = this.http<AskResponse<K>>("POST", `/v1/ask/${kind}`, {
      id, world: this.opts.world, player: this.opts.player, session: this.session, params, upgrade: opts.upgrade,
    }).then((res) => {
      if (res.upgrade !== "pending") {
        this.upgradeWaiters.delete(id);
        resolveUp(null);
      } else if (!this.ws) {
        // no socket: long-poll fallback
        void this.http<AnyAskResponse | null>("GET", `/v1/upgrades/${id}?wait=25`).then((r) => resolveUp(r && r.source === "ai" ? (r as AskResponse<K>) : null), () => resolveUp(null));
      }
      return res;
    });
    instant.catch(() => resolveUp(null));
    return {
      id,
      instant,
      upgrade,
      onChunk: (cb) => {
        const l = (c: { text: string; seq: number }) => cb(c.text, c.seq);
        this.chunkListeners.set(id, [...(this.chunkListeners.get(id) ?? []), l]);
      },
    };
  }

  /** Listen for directives of a kind ("*" = all). Returns an unsubscribe function. */
  on<K extends DirectiveKind>(kind: K, cb: Listener<TypedDirective<K>>): () => void;
  on(kind: "*" | `custom.${string}`, cb: Listener<Directive>): () => void;
  on(kind: string, cb: Listener<never>): () => void {
    const set = this.directiveListeners.get(kind) ?? new Set();
    set.add(cb as Listener<Directive>);
    this.directiveListeners.set(kind, set);
    return () => set.delete(cb as Listener<Directive>);
  }

  close(): void {
    void this.flush();
    this.ws?.close();
  }
}

export const createClient = (opts: LiveforgeClientOptions) => new LiveforgeClient(opts);

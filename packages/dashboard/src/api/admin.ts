// Admin API client + LiveSource. Every route the dashboard uses is listed in ADMIN_ROUTES (mirrored in
// docs/protocol.md#admin-api). Responses are the protocol shapes; small envelope differences ({state} vs bare
// state, {items} vs bare array) are tolerated so the dashboard keeps working while the server evolves.
import {
  HEADERS, PROTOCOL_ID, WS_PATH,
  type BakePack, type Directive, type EventPage, type GalleryEntry, type ProjectionName, type ProjectionState, type PublicConfig,
  type ReviewItem, type SimulateRequest, type StatsResponse, type StoredEvent, type WsClientMessage, type WsServerMessage,
} from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";
import {
  AdminError, type BakeRequest, type BakeResult, type ConnStatus, type DataSource, type EventQuery, type GameInfo, type LiveHandlers, type ManifestDoc,
  type ReactionLibraryState, type SimulateResult, type WorldSummary,
} from "./types";
import { brainFromEvent, buildFromEvent, normaliseRuns, type AgentRun, type BrainEntry, type BuildEntry, type CassetteInfo, type CassetteMode } from "./brain";

/** The admin HTTP surface the dashboard relies on (all require the admin key). */
export const ADMIN_ROUTES = {
  games: "GET /admin/games",
  manifest: "GET /admin/manifest",
  manifestSource: "GET /admin/manifest/source",
  worlds: "GET /admin/worlds",
  players: "GET /admin/players?world=",
  events: "GET /admin/events?world=&player=&after=&limit=&type=&desc=",
  projection: "GET /admin/projections/:name?world=&player=",
  projectionAll: "GET /admin/projections/:name?world= (player scope without player -> {players: {id: state}})",
  stats: "GET /admin/stats",
  simulate: "POST /admin/simulate",
  review: "GET /admin/m/forge/review (fallback GET /admin/review)",
  reviewSet: "POST /admin/m/forge/review/:id (fallback POST /admin/review/:id)",
  bakePack: "GET /admin/m/forge/pack (fallback GET /admin/bake)",
  bake: "POST /admin/m/forge/bake",
  reactionLibrary: "GET /admin/m/world/reactions-lib?world=&player=",
  agentRuns: "GET /admin/projections/agents.runs?world= (K6)",
  builds: "GET /admin/events?type=lf.builder.planned (K6)",
  brain: "GET /v1/brain?world= (K6 ring; falls back to module events)",
  cassettes: "GET /admin/cassettes, POST /admin/cassettes/mode {mode}",
} as const;

export interface AdminClientOptions {
  /** Server origin, e.g. "http://localhost:8787". Empty = same origin as the dashboard. */
  baseUrl: string;
  adminKey: string;
  /** Game to act on when the admin key covers several games. */
  game?: string;
  /** Request timeout (ms). Default 10 s. */
  timeoutMs?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Thin typed fetch wrapper around the admin API. */
export class AdminClient {
  readonly baseUrl: string;
  constructor(private readonly opts: AdminClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }

  get game(): string | undefined {
    return this.opts.game;
  }
  set game(g: string | undefined) {
    this.opts.game = g;
  }

  url(path: string, query?: Record<string, string | number | boolean | undefined | null>): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    const s = qs.toString();
    return `${this.baseUrl}${path}${s ? `?${s}` : ""}`;
  }

  async request<T>(method: "GET" | "POST", path: string, opts: { query?: Record<string, string | number | boolean | undefined | null>; body?: unknown } = {}): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 10_000);
    const headers: Record<string, string> = { [HEADERS.key]: this.opts.adminKey, [HEADERS.protocol]: PROTOCOL_ID, accept: "application/json" };
    if (this.opts.game) headers[HEADERS.game] = this.opts.game;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(this.url(path, opts.query), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctrl.signal,
      });
    } catch (e) {
      const aborted = (e as Error).name === "AbortError";
      throw new AdminError(aborted ? `${method} ${path} timed out` : `Cannot reach ${this.baseUrl || "the server"} (${(e as Error).message})`, 0, aborted ? "timeout" : "network");
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const err = isObj(data) && isObj(data.error) ? data.error : null;
      const code = typeof err?.code === "string" ? err.code : res.status === 401 ? "unauthorized" : res.status === 404 ? "not_found" : "http_error";
      const msg = typeof err?.message === "string" ? err.message : `${method} ${path} failed (${res.status})`;
      throw new AdminError(msg, res.status, code, err?.details);
    }
    return data as T;
  }

  get<T>(path: string, query?: Record<string, string | number | boolean | undefined | null>): Promise<T> {
    return this.request<T>("GET", path, { query });
  }
  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  /** WebSocket URL for the admin firehose (the admin key is passed as ?key=, as the protocol specifies). */
  wsUrl(): string {
    const base = this.baseUrl || `${location.protocol}//${location.host}`;
    const u = new URL(WS_PATH, base.replace(/^http/, "ws"));
    u.searchParams.set("key", this.opts.adminKey);
    if (this.opts.game) u.searchParams.set("game", this.opts.game);
    return u.toString();
  }
}

/** Pull a Directive out of an "lf.directive" event (data is the directive, or {directive}). */
export function directiveFromEvent(e: StoredEvent): Directive | null {
  if (e.type !== "lf.directive") return null;
  const d = isObj(e.data.directive) ? e.data.directive : e.data;
  if (typeof d.kind !== "string") return null;
  return {
    id: typeof d.id === "string" ? d.id : `ev${e.seq}`,
    kind: d.kind,
    target: typeof d.target === "string" ? d.target : "world",
    args: isObj(d.args) ? d.args : {},
    why: typeof d.why === "string" ? d.why : "",
    ts: typeof d.ts === "number" ? d.ts : e.ts,
    world: e.world,
    player: typeof d.player === "string" ? d.player : e.player,
    source: typeof d.source === "string" ? d.source : undefined,
  };
}

/** Map a forge.gallery entry (forge review queue) onto the protocol ReviewItem the panel renders. */
export function reviewFromGallery(e: GalleryEntry & { key?: string; note?: string }): ReviewItem {
  const status = e.review === "approved" || e.review === "rejected" ? e.review : "pending";
  return { id: e.id, kind: e.askKind, status, payload: e.result, note: e.note ?? (e.key ? `prompt: ${e.key}` : undefined), createdAt: e.ts, updatedAt: e.ts };
}

function gameInfoFromManifest(m: Manifest, extra: Partial<GameInfo> = {}): GameInfo {
  const modules: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(m.modules)) modules[k] = typeof v === "boolean" ? v : (v as { enabled: boolean }).enabled;
  return {
    id: m.game.id,
    name: m.game.name,
    protocol: PROTOCOL_ID,
    serverVersion: "?",
    modules,
    personas: m.personas.map((p) => ({ id: p.id, name: p.name, role: p.role, faction: p.faction, zone: p.zone })),
    factions: m.factions.map((f) => ({ id: f.id, name: f.name })),
    bosses: m.bosses.map((b) => ({ id: b.id, name: b.name, phases: b.phases })),
    games: [{ id: m.game.id, name: m.game.name }],
    ...extra,
  };
}

/** DataSource backed by a running Liveforge server. */
export class LiveSource implements DataSource {
  readonly mode = "live" as const;
  readonly label: string;
  readonly client: AdminClient;
  private sockets = new Set<() => void>();
  private manifestCache: ManifestDoc | null = null;

  constructor(opts: AdminClientOptions) {
    this.client = new AdminClient(opts);
    this.label = opts.baseUrl ? opts.baseUrl.replace(/^https?:\/\//, "") : location.host;
  }

  /** Verifies the key (used by the login screen). */
  async check(): Promise<GameInfo> {
    return this.game();
  }

  async game(): Promise<GameInfo> {
    const r = await this.client.get<{ games?: { id: string; name: string; modules?: Record<string, boolean> }[] }>("/admin/games");
    const games = (r.games ?? []).map((g) => ({ id: g.id, name: g.name }));
    const current = r.games?.find((g) => g.id === this.client.game) ?? r.games?.[0];
    const doc = await this.manifest().catch(() => null);
    if (doc?.manifest) {
      return gameInfoFromManifest(doc.manifest, { ...(games.length ? { games } : {}), ...(current?.modules ? { modules: current.modules } : {}) });
    }
    // Fallback: the public config slice.
    const cfg = await this.client.get<PublicConfig>("/v1/config");
    return {
      id: cfg.game.id,
      name: cfg.game.name,
      protocol: cfg.protocol,
      serverVersion: cfg.server.version,
      modules: cfg.modules,
      personas: cfg.personas,
      factions: [],
      bosses: cfg.bosses,
      games: games.length ? games : [cfg.game],
    };
  }

  async manifest(): Promise<ManifestDoc> {
    if (this.manifestCache) return this.manifestCache;
    const [r, src] = await Promise.all([
      this.client.get<unknown>("/admin/manifest"),
      this.client.get<{ filename?: string; yaml?: string }>("/admin/manifest/source").catch(() => null),
    ]);
    let doc: ManifestDoc;
    if (isObj(r) && "manifest" in r) {
      doc = { manifest: (r.manifest as Manifest) ?? null, yaml: typeof r.yaml === "string" ? r.yaml : null, filename: typeof r.filename === "string" ? r.filename : undefined };
    } else {
      doc = { manifest: isObj(r) && "liveforge" in r ? (r as unknown as Manifest) : null, yaml: null };
    }
    if (src?.yaml) {
      doc.yaml = src.yaml;
      doc.filename = src.filename ?? doc.filename;
    }
    this.manifestCache = doc;
    return doc;
  }

  async worlds(): Promise<WorldSummary[]> {
    const [w, p] = await Promise.all([
      this.client.get<unknown>("/admin/worlds"),
      this.client.get<unknown>("/admin/players").catch(() => null),
    ]);
    const list = (Array.isArray(w) ? w : isObj(w) && Array.isArray(w.worlds) ? w.worlds : []) as unknown[];
    const players = (Array.isArray(p) ? p : isObj(p) && Array.isArray(p.players) ? p.players : []) as Record<string, unknown>[];
    const playerOf = (q: unknown) => {
      if (typeof q === "string") return { id: q, events: 0, lastSeen: null };
      const o = isObj(q) ? q : {};
      return { id: String(o.player ?? o.id), events: Number(o.events ?? 0), lastSeen: typeof o.lastSeen === "number" ? o.lastSeen : null };
    };
    return list.map((x) => {
      const o: Record<string, unknown> = typeof x === "string" ? { world: x } : isObj(x) ? x : {};
      const id = String(o.id ?? o.world ?? "default");
      const pl = Array.isArray(o.players) ? o.players.map(playerOf) : players.filter((q) => q.world === id).map(playerOf);
      const last = typeof o.lastEventAt === "number" ? o.lastEventAt : typeof o.lastSeen === "number" ? o.lastSeen : null;
      return { id, events: Number(o.events ?? 0), lastEventAt: last, players: pl };
    });
  }

  events(q: EventQuery): Promise<EventPage> {
    return this.client.get<EventPage>("/admin/events", { ...q });
  }

  async projection<N extends ProjectionName>(name: N, world: string, player?: string | null): Promise<ProjectionState<N> | null> {
    try {
      const r = await this.client.get<unknown>(`/admin/projections/${encodeURIComponent(name)}`, { world, player: player ?? undefined });
      if (isObj(r) && "state" in r) return (r.state as ProjectionState<N>) ?? null;
      return (r as ProjectionState<N>) ?? null;
    } catch (e) {
      if (e instanceof AdminError && e.status === 404) return null;
      throw e;
    }
  }

  async projectionAll<N extends ProjectionName>(name: N, world: string): Promise<{ player: string; state: ProjectionState<N> }[]> {
    try {
      const r = await this.client.get<unknown>(`/admin/projections/${encodeURIComponent(name)}`, { world });
      if (Array.isArray(r)) return r as { player: string; state: ProjectionState<N> }[];
      if (isObj(r) && Array.isArray(r.players)) return r.players as { player: string; state: ProjectionState<N> }[];
      if (isObj(r) && isObj(r.players)) return Object.entries(r.players).map(([player, state]) => ({ player, state: state as ProjectionState<N> }));
      return [];
    } catch (e) {
      if (e instanceof AdminError && e.status === 404) return [];
      throw e;
    }
  }

  stats(): Promise<StatsResponse> {
    return this.client.get<StatsResponse>("/admin/stats");
  }

  simulate(req: SimulateRequest): Promise<SimulateResult> {
    return this.client.post<SimulateResult>("/admin/simulate", req);
  }

  /** World the forge review queue lives in (forge option bakeWorld, reported by the server). */
  private reviewWorld: string | undefined;

  /**
   * Review queue. Prefers the Forge module's event-sourced queue (GET /admin/m/forge/review: forge.gallery entries
   * with review != "none"); falls back to the core queue (GET /admin/review) when the forge module is off.
   */
  async reviewList(): Promise<ReviewItem[]> {
    try {
      const r = await this.client.get<{ world?: string; items?: GalleryEntry[] }>("/admin/m/forge/review");
      this.reviewWorld = r.world ?? this.reviewWorld;
      return (r.items ?? []).filter((e) => e.review && e.review !== "none").map(reviewFromGallery);
    } catch (e) {
      if (!(e instanceof AdminError && (e.status === 404 || e.status === 409))) throw e;
    }
    const r = await this.client.get<unknown>("/admin/review");
    return (Array.isArray(r) ? r : isObj(r) && Array.isArray(r.items) ? r.items : []) as ReviewItem[];
  }

  async reviewSet(id: string, status: ReviewItem["status"], note?: string): Promise<ReviewItem> {
    try {
      await this.client.post<unknown>(`/admin/m/forge/review/${encodeURIComponent(id)}`, { status, note, world: this.reviewWorld });
    } catch (e) {
      if (!(e instanceof AdminError && (e.status === 404 || e.status === 409))) throw e;
      await this.client.post<unknown>(`/admin/review/${encodeURIComponent(id)}`, { status, note });
    }
    const fresh = (await this.reviewList()).find((x) => x.id === id);
    if (!fresh) throw new AdminError(`review item ${id} not found after update`, 404, "not_found");
    return fresh;
  }

  /** Bake pack of approved items: the forge pack (with mesh asset urls), else the core bake. */
  async bakeExport(): Promise<BakePack> {
    try {
      return await this.client.get<BakePack>("/admin/m/forge/pack", { world: this.reviewWorld });
    } catch (e) {
      if (!(e instanceof AdminError && (e.status === 404 || e.status === 409))) throw e;
      return this.client.get<BakePack>("/admin/bake");
    }
  }

  /** Reaction Library (R1): GET /admin/m/world/reactions-lib. */
  async reactionLibrary(world: string, player?: string | null): Promise<ReactionLibraryState | null> {
    return this.client.get<ReactionLibraryState>("/admin/m/world/reactions-lib", { world, player: player ?? undefined });
  }

  /** Agent runs: the agents.runs projection (K6). */
  async agentRuns(world: string): Promise<AgentRun[]> {
    try {
      const r = await this.client.get<unknown>("/admin/projections/agents.runs", { world });
      return normaliseRuns(isObj(r) && "state" in r ? r.state : r);
    } catch (e) {
      if (e instanceof AdminError && (e.status === 404 || e.status === 400)) return [];
      throw e;
    }
  }

  /** Builder plans: lf.builder.planned events, newest first. */
  async builds(world: string, limit = 30): Promise<BuildEntry[]> {
    const page = await this.events({ world, type: "lf.builder.planned", limit, desc: true });
    return page.events.map(buildFromEvent).filter((b): b is BuildEntry => !!b).sort((a, b) => b.ts - a.ts);
  }

  /** Brain history: the server ring (K6 GET /v1/brain) when present, plus entries derived from module events. */
  async brainHistory(world: string): Promise<BrainEntry[]> {
    const out: BrainEntry[] = [];
    try {
      const r = await this.client.get<unknown>("/v1/brain", { world, limit: 300 });
      const list = Array.isArray(r) ? r : isObj(r) && Array.isArray(r.entries) ? r.entries : [];
      for (const x of list) if (isObj(x) && typeof x.text === "string") out.push(x as unknown as BrainEntry);
    } catch {
      /* no ring on this server (pre-K6) */
    }
    const types = ["lf.factions.*", "lf.agents.*", "lf.builder.planned", "lf.director.decision", "lf.brain"];
    const pages = await Promise.all(types.map((type) => this.events({ world, type, limit: 80, desc: true }).catch(() => null)));
    for (const p of pages) for (const e of p?.events ?? []) {
      const b = brainFromEvent(e);
      if (b) out.push(b);
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  /** LLM provider mode + cassettes (null on servers without K7). */
  async cassettes(): Promise<CassetteInfo | null> {
    try {
      return await this.client.get<CassetteInfo>("/admin/cassettes", { limit: 100 });
    } catch (e) {
      if (e instanceof AdminError && e.status === 404) return null;
      throw e;
    }
  }

  setCassetteMode(mode: CassetteMode): Promise<CassetteInfo> {
    return this.client.post<CassetteInfo>("/admin/cassettes/mode", { mode });
  }

  /** Bake mode: POST /admin/m/forge/bake - pre-generate a catalogue into the review queue. */
  async bake(req: BakeRequest): Promise<BakeResult> {
    const r = await this.client.post<{ queued?: number; skipped?: number[]; ai?: string; world?: string }>("/admin/m/forge/bake", req);
    if (r.world) this.reviewWorld = r.world;
    return { queued: r.queued ?? 0, skipped: r.skipped?.length ?? 0, ai: r.ai ?? "off" };
  }

  /**
   * Admin firehose over WebSocket (topics events + directives). Falls back to polling /admin/events while the
   * socket is down, and reconnects with backoff.
   */
  connect(world: string, h: LiveHandlers): () => void {
    let ws: WebSocket | null = null;
    let closed = false;
    let lastSeq = -1;
    let retry = 0;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const seenDirectives = new Set<string>();

    const emitEvent = (e: StoredEvent) => {
      if (e.seq <= lastSeq) return;
      lastSeq = e.seq;
      h.onEvent(e);
      const d = directiveFromEvent(e);
      if (d) emitDirective(d);
    };
    const emitDirective = (d: Directive) => {
      if (seenDirectives.has(d.id)) return;
      seenDirectives.add(d.id);
      if (seenDirectives.size > 2000) seenDirectives.clear();
      h.onDirective(d);
    };

    const poll = async () => {
      try {
        const page = await this.events({ world, after: lastSeq >= 0 ? lastSeq : undefined, limit: 200 });
        for (const e of [...page.events].sort((a, b) => a.seq - b.seq)) emitEvent(e);
      } catch {
        /* status already shows polling/offline */
      }
    };
    const startPolling = () => {
      if (pollTimer || closed) return;
      h.onStatus("polling");
      void poll();
      pollTimer = setInterval(poll, 3000);
    };
    const stopPolling = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    };

    const open = () => {
      if (closed) return;
      h.onStatus("connecting");
      try {
        ws = new WebSocket(this.client.wsUrl());
      } catch {
        startPolling();
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        retry = 0;
        const sub: WsClientMessage = { t: "subscribe", world, topics: ["events", "directives"] };
        ws?.send(JSON.stringify(sub));
        pingTimer = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "ping", ts: Date.now() })), 20_000);
      };
      ws.onmessage = (m) => {
        let msg: WsServerMessage;
        try {
          msg = JSON.parse(String(m.data)) as WsServerMessage;
        } catch {
          return;
        }
        // K6 Brain feed: {t:"brain", entry} (not in this branch's protocol union yet)
        const raw = msg as unknown as { t: string; entry?: BrainEntry };
        if (raw.t === "brain") {
          if (raw.entry) h.onBrain?.(raw.entry);
          return;
        }
        switch (msg.t) {
          case "subscribed":
            stopPolling();
            h.onStatus("live");
            void poll(); // catch up on anything between the snapshot and the socket
            break;
          case "event":
            emitEvent(msg.event);
            break;
          case "directive":
            emitDirective(msg.directive);
            break;
          case "error":
            h.onStatus("polling", msg.error.message);
            break;
          default:
            break;
        }
      };
      ws.onclose = () => {
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = null;
        ws = null;
        if (closed) return;
        startPolling();
        scheduleReconnect();
      };
      ws.onerror = () => ws?.close();
    };
    const scheduleReconnect = () => {
      if (closed || reconnectTimer) return;
      const delay = Math.min(15_000, 1000 * 2 ** retry++);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        open();
      }, delay);
    };

    // Seed the cursor with the latest events so the stream starts populated.
    void this.events({ world, limit: 100, desc: true })
      .then((page) => {
        for (const e of [...page.events].sort((a, b) => a.seq - b.seq)) emitEvent(e);
      })
      .catch(() => h.onStatus("offline"))
      .finally(open);

    const stop = () => {
      closed = true;
      stopPolling();
      if (pingTimer) clearInterval(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
      this.sockets.delete(stop);
    };
    this.sockets.add(stop);
    return stop;
  }

  close(): void {
    for (const s of [...this.sockets]) s();
  }
}

export type { ConnStatus };

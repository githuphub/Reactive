// LiveforgeClient: signals (batched), asks (instant + upgrade), directives (WebSocket), fallback cache + packs,
// STT, forge jobs and snapshots. One client per player session.
import type {
  AnyAskResponse,
  AskKind,
  AskParamsInput,
  AskResponse,
  AskResult,
  AskSource,
  BuiltinSignalType,
  Directive,
  DirectiveKind,
  ForgeJob,
  PublicConfig,
  Signal,
  SignalBatchResult,
  Snapshot,
  SnapshotImportResult,
  SttResponse,
  TypedDirective,
  WsServerMessage,
  WsServerMessageOf,
} from "@liveforge/protocol";
import { AskHandleImpl, type AskHandle } from "./ask.js";
import { FallbackCache, type FallbackCacheOptions } from "./cache.js";
import { FactionsApi } from "./factions.js";
import { Emitter, type Unsubscribe } from "./emitter.js";
import { LiveforgeError, isLiveforgeError } from "./errors.js";
import { Http, type FetchLike } from "./http.js";
import { Realtime, type RealtimeStatus, type WebSocketCtor } from "./realtime.js";
import type { CustomSignalType, SignalData } from "./types.js";
import { ID_RE, SIGNAL_TYPE_RE, backoffMs, isPlainObject, randomId, sleep } from "./util.js";

/** Client configuration. Only `url`, `gameKey` and `player` are required. */
export interface LiveforgeConfig {
  /** Server base URL, e.g. "http://localhost:8787". */
  url: string;
  /** Publishable SDK key of the game (`pk_...`; in dev mode `pk_dev_<gameId>`). Never put the admin key in a client. */
  gameKey?: string;
  /** Alias of `gameKey` (the K0 client stub's name). */
  key?: string;
  /** Player id (`[A-Za-z0-9_-.:]`, <= 64 chars). Change later with `setPlayer`. */
  player: string;
  /** World / save slot / server id. Default "default". */
  world?: string;
  /** Play-session id. Default: a random id per client. */
  session?: string;
  /** Connect the WebSocket for directives and live upgrades. Default true. */
  realtime?: boolean;
  /** Alias of `realtime`. */
  websocket?: boolean;
  /** Signal batching: flush at least this often (ms). Default 250. */
  flushIntervalMs?: number;
  /** Signal batching: flush as soon as this many signals are queued. Default 50. */
  flushSize?: number;
  /** Alias of `flushIntervalMs`. */
  flushMs?: number;
  /** Alias of `flushSize`. */
  flushMax?: number;
  /** Max signals kept while the server is unreachable (oldest dropped). Default 2000. */
  maxQueue?: number;
  /** Timeout for instant answers and other requests (ms). Default 8000. */
  requestTimeoutMs?: number;
  /** How long to wait for an AI upgrade before giving up (ms). Default 45 000. */
  upgradeTimeoutMs?: number;
  /** Fallback cache options, or false to disable caching. */
  cache?: FallbackCacheOptions | false;
  /** Never call the server for asks: answer from cache / bake packs / `setFallback` only. Signals are dropped. */
  offline?: boolean;
  /** Flush queued signals when the page is hidden / unloaded (browser). Default true. */
  flushOnUnload?: boolean;
  /** Custom fetch (Node < 18, tests, proxies). Default globalThis.fetch. */
  fetch?: FetchLike;
  /** Custom WebSocket constructor (e.g. the `ws` package on old Node). Default globalThis.WebSocket. */
  WebSocket?: WebSocketCtor;
  /** Log transport details to the console. */
  debug?: boolean;
  /** Called for background errors (failed flushes, rejected signals, socket errors). Default: console.warn. */
  onError?: (err: LiveforgeError) => void;
}

/** Per-ask options. */
export interface AskOptions<K extends AskKind> {
  /** false = instant answer only (no AI upgrade). Default true. */
  upgrade?: boolean;
  /** Instant answer timeout (ms). Default: config.requestTimeoutMs. */
  timeoutMs?: number;
  /** Upgrade wait (ms). Default: config.upgradeTimeoutMs. */
  upgradeTimeoutMs?: number;
  /** Answer to use when the server and every local fallback fail (instead of rejecting). */
  fallback?: AskResult<K>;
  /** Your own ask id (default random). */
  id?: string;
}

/** Local fallback producer for a kind (used when the server is unreachable and nothing is cached). */
export type FallbackFn<K extends AskKind> = (params: AskParamsInput<K>) => AskResult<K> | undefined | null;

/** Directive listener options. */
export interface OnOptions {
  /** Only directives with this target, e.g. "npc:bess", "boss:training_dummy", "player". */
  target?: string;
}

type ClientEvents = {
  status: (status: RealtimeStatus) => void;
  error: (err: LiveforgeError) => void;
  job: (job: WsServerMessageOf<"job">) => void;
  welcome: (msg: WsServerMessageOf<"welcome">) => void;
};

interface Pending {
  handle: AskHandleImpl<AskKind>;
  params: unknown;
  waiting: boolean;
  poll: AbortController | null;
  deadline: number;
}

interface DirectiveListener {
  pattern: string;
  target?: string;
  fn: (d: Directive) => void;
}

/**
 * The Liveforge client.
 *
 * ```ts
 * const lf = createClient({ url: "http://localhost:8787", gameKey: "pk_dev_my-game", player: "p1" });
 * lf.signal("combat.dodged", { source: "boss", direction: "left" });
 * const reply = lf.ask("npc.reply", { npc: "bess", text: "Any news?", stream: true });
 * reply.instant.then((r) => show(r.result.text));
 * reply.onPartial((p) => speak(p.text));
 * reply.onUpgrade((r) => show(r.result.text));
 * lf.on("npc.bark", (d) => bubble(d.args.npc, d.args.text));
 * ```
 */
export class LiveforgeClient {
  /** Last-good-answer cache + bake packs. */
  readonly cache: FallbackCache;
  /** Village minds (K7 factions module): `state(id)`, `raidPlan(params)`, `onPosture`, `onGuardPosts`, `reportThreat`. */
  readonly factions: FactionsApi = new FactionsApi({
    world: () => this._world,
    get: async (path, query) => (await this.http.request<never>({ method: "GET", path, query })).data,
    post: async (path, body) => (await this.http.request<never>({ method: "POST", path, json: body })).data,
    ask: (params, opts) => this.ask("faction.raid_plan", params, opts),
    on: (kind, fn) => this.on(kind, fn),
  });
  private readonly cfg: Required<Pick<LiveforgeConfig, "gameKey" | "flushIntervalMs" | "flushSize" | "maxQueue" | "requestTimeoutMs" | "upgradeTimeoutMs">> & LiveforgeConfig;
  private readonly http: Http;
  private readonly fetchImpl: FetchLike | null;
  private readonly realtime: Realtime | null;
  private readonly events = new Emitter<ClientEvents>();
  private readonly directiveListeners = new Set<DirectiveListener>();
  private readonly seenDirectives: string[] = [];
  private readonly seenSet = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private readonly fallbacks = new Map<string, (params: never) => unknown>();
  private queue: Signal[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<SignalBatchResult | null> | null = null;
  private flushFailures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private configPromise: Promise<PublicConfig> | null = null;
  private closed = false;
  private _world: string;
  private _player: string;
  private readonly _session: string;
  private readonly unloadHandlers: Array<() => void> = [];
  private readonly cacheDisabled: boolean;

  constructor(config: LiveforgeConfig) {
    if (!config || typeof config.url !== "string" || !/^https?:\/\//.test(config.url)) {
      throw new LiveforgeError("invalid_input", 'config.url must be the server URL, e.g. "http://localhost:8787"');
    }
    const gameKey = config.gameKey ?? config.key;
    if (typeof gameKey !== "string" || !gameKey) {
      throw new LiveforgeError("invalid_input", 'config.gameKey is required (the publishable key, e.g. "pk_dev_<gameId>" in dev mode)');
    }
    checkId("config.player", config.player);
    if (config.world !== undefined) checkId("config.world", config.world);
    if (config.session !== undefined) checkId("config.session", config.session);
    this.cfg = {
      maxQueue: 2000,
      requestTimeoutMs: 8000,
      upgradeTimeoutMs: 45_000,
      ...config,
      gameKey,
      flushIntervalMs: config.flushIntervalMs ?? config.flushMs ?? 250,
      flushSize: config.flushSize ?? config.flushMax ?? 50,
    };
    this._world = config.world ?? "default";
    this._player = config.player;
    this._session = config.session ?? randomId("s");
    const f = config.fetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
    this.fetchImpl = f;
    this.http = new Http(config.url, gameKey, f ?? missingFetch, this.cfg.requestTimeoutMs);
    this.cache = new FallbackCache(
      config.cache === false
        ? { storage: null, maxEntries: 1 }
        : { namespace: `${gameKey}@${config.url}`, ...(config.cache ?? {}) },
    );
    this.cacheDisabled = config.cache === false;

    if ((config.realtime ?? config.websocket) !== false && !config.offline) {
      this.realtime = new Realtime({
        url: config.url,
        key: gameKey,
        world: this._world,
        player: this._player,
        ...(config.WebSocket ? { WebSocket: config.WebSocket } : {}),
        ...(config.debug ? { debug: true } : {}),
      });
      this.realtime.on("message", (m) => this.onMessage(m));
      this.realtime.on("status", (s) => this.onRealtimeStatus(s));
      this.realtime.start();
    } else {
      this.realtime = null;
    }
    if (config.flushOnUnload !== false) this.installUnloadFlush();
  }

  // ============================================================================================ identity

  /** Current world id. */
  get world(): string {
    return this._world;
  }
  /** Current player id. */
  get player(): string {
    return this._player;
  }
  /** Play-session id sent with every signal and ask. */
  get session(): string {
    return this._session;
  }
  /** WebSocket status ("idle" when realtime is off). */
  get status(): RealtimeStatus {
    return this.realtime?.status ?? "idle";
  }

  /**
   * Switches player (and optionally world): flushes queued signals, then moves the WebSocket subscription.
   * Pending asks keep their original player.
   */
  setPlayer(player: string, world: string = this._world): void {
    checkId("player", player);
    checkId("world", world);
    if (player === this._player && world === this._world) return;
    void this.flush();
    this._player = player;
    this._world = world;
    this.realtime?.resubscribe(world, player);
  }

  // ============================================================================================ signals

  /**
   * Reports a fact (fire-and-forget, batched). Built-in types are typed from protocol `BUILTIN_SIGNALS`; custom
   * types must be declared in the manifest `signals` section.
   *
   * ```ts
   * lf.signal("combat.hurt", { source: "boss", damage: 12, hp: 0.4 });
   * lf.signal("magic.raise_dead", { count: 3 });
   * ```
   */
  signal<T extends BuiltinSignalType>(type: T, data: SignalData<T>): void;
  signal<T extends string>(type: CustomSignalType<T>, data?: Record<string, unknown>): void;
  signal(type: string, data: Record<string, unknown> = {}): void {
    if (this.closed) return;
    if (typeof type !== "string" || !SIGNAL_TYPE_RE.test(type) || type.length > 64) {
      this.report(new LiveforgeError("invalid_input", `signal type "${String(type)}" is invalid: use dotted lowercase like "combat.dodged"`));
      return;
    }
    if (!isPlainObject(data)) {
      this.report(new LiveforgeError("invalid_input", `signal "${type}": data must be a plain object`));
      return;
    }
    if (this.cfg.offline) return;
    const s: Signal = { type, data, ts: Date.now(), player: this._player, world: this._world, session: this._session };
    this.queue.push(s);
    if (this.queue.length > this.cfg.maxQueue) this.queue.splice(0, this.queue.length - this.cfg.maxQueue);
    if (this.queue.length >= this.cfg.flushSize) void this.flush();
    else this.scheduleFlush();
  }

  /**
   * Sends queued signals now. Resolves with the last batch result (null when nothing was sent or the batch was
   * re-queued after a failure).
   */
  flush(): Promise<SignalBatchResult | null> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushing) return this.flushing.then((r) => (this.queue.length ? this.flush() : r));
    if (!this.queue.length || this.cfg.offline) return Promise.resolve(null);
    this.flushing = this.sendQueue().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** Signals waiting to be sent. */
  get queuedSignals(): number {
    return this.queue.length;
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.retryTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.cfg.flushIntervalMs);
  }

  private async sendQueue(): Promise<SignalBatchResult | null> {
    let last: SignalBatchResult | null = null;
    while (this.queue.length) {
      const batch = this.queue.splice(0, 500);
      try {
        const r = await this.http.request<SignalBatchResult>({ method: "POST", path: "/v1/signals", json: { signals: batch } });
        this.flushFailures = 0;
        last = r.data ?? null;
        for (const rej of r.data?.rejected ?? []) {
          const s = batch[rej.index];
          this.report(new LiveforgeError("bad_request", `signal "${s?.type ?? "?"}" rejected: ${rej.code}: ${rej.message}`));
        }
      } catch (err) {
        const e = toError(err);
        if (e.retryable) {
          // Put the batch back (oldest first) and retry with backoff.
          this.queue = [...batch, ...this.queue].slice(-this.cfg.maxQueue);
          const delay = backoffMs(this.flushFailures++, 1000, 30_000);
          if (this.flushFailures === 1 || this.cfg.debug) this.report(e);
          if (!this.retryTimer && !this.closed) {
            this.retryTimer = setTimeout(() => {
              this.retryTimer = null;
              void this.flush();
            }, delay);
          }
        } else {
          this.report(e);
        }
        return null;
      }
    }
    return last;
  }

  // ============================================================================================ asks

  /**
   * Asks a module for something. Returns at once with an {@link AskHandle}: `instant` (rules / cache answer),
   * `upgrade` (AI answer or null), `final` (best of both), `onPartial` (streamed sentences) and `onUpgrade`.
   *
   * ```ts
   * const h = lf.ask("forge.item", { prompt: "a frost axe that hums" });
   * equip((await h.instant).result.item);
   * h.onUpgrade((r) => equip(r.result.item));
   * ```
   */
  ask<K extends AskKind>(kind: K, params: AskParamsInput<K>, opts: AskOptions<K> = {}): AskHandle<K> {
    const id = opts.id ?? randomId("a");
    const handle = new AskHandleImpl<K>(id, kind);
    if (this.closed) {
      handle.rejectInstant(new LiveforgeError("closed", "the client was closed"));
      return handle;
    }
    if (opts.id !== undefined && !ID_RE.test(opts.id)) {
      handle.rejectInstant(new LiveforgeError("invalid_input", `ask id "${opts.id}" is invalid (letters, digits, _ - . :, <= 64 chars)`));
      return handle;
    }
    const entry: Pending = {
      handle: handle as unknown as AskHandleImpl<AskKind>,
      params,
      waiting: false,
      poll: null,
      deadline: 0,
    };
    this.pending.set(id, entry);
    handle.onSettled = () => {
      entry.poll?.abort();
      this.pending.delete(id);
    };
    void this.runAsk(kind, params, opts, entry);
    return handle;
  }

  /**
   * Shortcut: ask and wait for the best answer's result (upgrade if it arrives within `upgradeTimeoutMs`).
   * Prefer `ask()` in games so you can show the instant answer first.
   */
  async askFinal<K extends AskKind>(kind: K, params: AskParamsInput<K>, opts: AskOptions<K> = {}): Promise<AskResult<K>> {
    return (await this.ask(kind, params, opts).final).result;
  }

  /**
   * Registers a local fallback for a kind, used when the server is unreachable (or in `offline` mode) and neither
   * the cache nor a bake pack has an answer. Return undefined to fall through.
   */
  setFallback<K extends AskKind>(kind: K, fn: FallbackFn<K>): void {
    this.fallbacks.set(kind, fn as (params: never) => unknown);
  }

  /**
   * Loads a bake pack: an object, or a URL / path to fetch (e.g. "/packs/forge.json"). Returns the entry count.
   * Pack answers are used when the server is unreachable or in `offline` mode.
   */
  async loadPack(pack: unknown): Promise<number> {
    if (typeof pack === "string") {
      if (!this.fetchImpl) throw new LiveforgeError("invalid_input", "loadPack(url) needs fetch; pass the pack object instead");
      let res: Response;
      try {
        res = await this.fetchImpl(pack);
      } catch (err) {
        throw new LiveforgeError("network", `cannot load pack ${pack}`, { cause: err });
      }
      if (!res.ok) throw new LiveforgeError("not_found", `cannot load pack ${pack}: HTTP ${res.status}`, { status: res.status });
      pack = await res.json();
    }
    return this.cache.loadPack(pack);
  }

  private async runAsk<K extends AskKind>(kind: K, params: AskParamsInput<K>, opts: AskOptions<K>, entry: Pending): Promise<void> {
    const handle = entry.handle as unknown as AskHandleImpl<K>;
    if (this.cfg.offline) {
      const local = this.localAnswer(kind, params, handle.id, opts.fallback);
      if (local) handle.resolveInstant(local);
      else handle.rejectInstant(new LiveforgeError("offline", `offline and no local answer for ${kind} (load a bake pack or setFallback)`));
      handle.settleUpgrade(null);
      return;
    }
    let res: AnyAskResponse | undefined;
    try {
      const r = await this.http.request<AnyAskResponse>({
        method: "POST",
        path: `/v1/ask/${kind}`,
        json: {
          id: handle.id,
          world: this._world,
          player: this._player,
          session: this._session,
          params,
          ...(opts.upgrade === false ? { upgrade: false } : {}),
        },
        timeoutMs: opts.timeoutMs ?? this.cfg.requestTimeoutMs,
      });
      res = r.data;
      if (!res || !isPlainObject(res) || !("result" in res)) {
        throw new LiveforgeError("internal", `ask ${kind}: the server returned no answer`);
      }
    } catch (err) {
      const e = toError(err);
      // Client errors (bad params, unknown kind, moderation) are real errors: do not mask them with a cached answer.
      const local = e.retryable || e.code === "budget_exceeded" ? this.localAnswer(kind, params, handle.id, opts.fallback) : null;
      if (local) {
        if (this.cfg.debug) console.warn(`[liveforge] ask ${kind} failed (${e.code}); answered from ${local.source}`);
        handle.resolveInstant(local);
      } else if (opts.fallback !== undefined && e.retryable) {
        handle.resolveInstant(this.makeLocal(kind, handle.id, opts.fallback, "rules", "fallback answer"));
      } else {
        handle.rejectInstant(e.retryable ? new LiveforgeError("no_fallback", `${e.message} (and no cached / pack / fallback answer for ${kind})`, { cause: e, ...(e.status !== undefined ? { status: e.status } : {}) }) : e);
      }
      handle.settleUpgrade(null);
      return;
    }
    const typed = res as unknown as AskResponse<K>;
    if (!this.cacheDisabled) this.cache.set(kind, params, typed.result, typed.source, typed.why);
    handle.resolveInstant(typed);
    if (res.upgrade !== "pending" || opts.upgrade === false) {
      handle.settleUpgrade(null);
      return;
    }
    this.awaitUpgrade(entry, opts.upgradeTimeoutMs ?? this.cfg.upgradeTimeoutMs);
  }

  private awaitUpgrade(entry: Pending, timeoutMs: number): void {
    if (entry.handle.settled) return;
    entry.waiting = true;
    entry.deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => entry.handle.settleUpgrade(null), timeoutMs);
    const prev = entry.handle.onSettled;
    entry.handle.onSettled = () => {
      clearTimeout(timer);
      prev?.();
    };
    if (!this.realtime || !this.realtime.isOpen) void this.pollUpgrade(entry);
  }

  /** Long-poll `GET /v1/upgrades/:id?wait=25` until the upgrade arrives, 404s, or the deadline passes. */
  private async pollUpgrade(entry: Pending): Promise<void> {
    if (entry.poll || entry.handle.settled) return;
    const ctrl = new AbortController();
    entry.poll = ctrl;
    let fails = 0;
    try {
      while (!entry.handle.settled && !this.closed && Date.now() < entry.deadline) {
        const wait = Math.max(1, Math.min(25, Math.floor((entry.deadline - Date.now()) / 1000)));
        try {
          const r = await this.http.request<AnyAskResponse>({
            method: "GET",
            path: `/v1/upgrades/${encodeURIComponent(entry.handle.id)}`,
            query: { wait },
            timeoutMs: (wait + 10) * 1000,
            signal: ctrl.signal,
          });
          fails = 0;
          if (r.status === 200 && r.data && isPlainObject(r.data)) {
            this.acceptUpgrade(r.data);
            return;
          }
        } catch (err) {
          if (ctrl.signal.aborted) return;
          const e = toError(err);
          if (e.code === "not_found") {
            entry.handle.settleUpgrade(null);
            return;
          }
          await sleep(backoffMs(fails++, 1000, 10_000));
        }
      }
    } finally {
      if (entry.poll === ctrl) entry.poll = null;
    }
  }

  private acceptUpgrade(resp: AnyAskResponse): void {
    const entry = this.pending.get(resp.id);
    if (!entry) return;
    if (!this.cacheDisabled && resp.result !== undefined) this.cache.set(entry.handle.kind, entry.params, resp.result, "ai", resp.why);
    entry.handle.settleUpgrade(resp as unknown as AskResponse<AskKind>);
  }

  private localAnswer<K extends AskKind>(kind: K, params: AskParamsInput<K>, id: string, explicit: AskResult<K> | undefined): AskResponse<K> | null {
    if (!this.cacheDisabled) {
      const cached = this.cache.get(kind, params);
      if (cached) return this.makeLocal(kind, id, cached.result as AskResult<K>, "cache", "cached answer (server unreachable)");
    }
    const packed = this.cache.fromPack(kind, params);
    if (packed) return this.makeLocal(kind, id, packed.result as AskResult<K>, "bake", "bake pack answer");
    const fn = this.fallbacks.get(kind) as FallbackFn<K> | undefined;
    if (fn) {
      try {
        const r = fn(params);
        if (r !== undefined && r !== null) return this.makeLocal(kind, id, r, "rules", "local fallback");
      } catch (err) {
        console.error(`[liveforge] setFallback("${kind}") threw`, err);
      }
    }
    if (explicit !== undefined) return this.makeLocal(kind, id, explicit, "rules", "fallback answer");
    return null;
  }

  private makeLocal<K extends AskKind>(kind: K, id: string, result: AskResult<K>, source: AskSource, why: string): AskResponse<K> {
    return { id, kind, stage: "instant", result, source, why, upgrade: "none", ms: 0, ts: Date.now() };
  }

  // ============================================================================================ directives

  /**
   * Listens for directives pushed by the server. `kind` is an exact kind ("npc.bark"), a prefix pattern ("npc.*")
   * or "*" for everything. Returns an unsubscribe function.
   *
   * ```ts
   * lf.on("boss.move_added", (d) => boss.learn(d.args.move), { target: "boss:training_dummy" });
   * ```
   */
  on<K extends DirectiveKind>(kind: K, fn: (directive: TypedDirective<K>) => void, opts?: OnOptions): Unsubscribe;
  on(kind: string, fn: (directive: Directive) => void, opts?: OnOptions): Unsubscribe;
  on(kind: string, fn: (directive: never) => void, opts: OnOptions = {}): Unsubscribe {
    const l: DirectiveListener = { pattern: kind, fn: fn as (d: Directive) => void, ...(opts.target ? { target: opts.target } : {}) };
    this.directiveListeners.add(l);
    return () => this.directiveListeners.delete(l);
  }

  /** Like `on`, but runs once. */
  once<K extends DirectiveKind>(kind: K, fn: (directive: TypedDirective<K>) => void, opts?: OnOptions): Unsubscribe;
  once(kind: string, fn: (directive: Directive) => void, opts?: OnOptions): Unsubscribe;
  once(kind: string, fn: (directive: never) => void, opts: OnOptions = {}): Unsubscribe {
    const off = this.on(kind, (d: Directive) => {
      off();
      (fn as (d: Directive) => void)(d);
    }, opts);
    return off;
  }

  /** WebSocket status changes ("connecting", "open", "reconnecting", "unavailable", "idle"). */
  onStatus(fn: (status: RealtimeStatus) => void): Unsubscribe {
    return this.events.on("status", fn);
  }

  /** Background errors (failed flushes, rejected signals, socket errors). */
  onError(fn: (err: LiveforgeError) => void): Unsubscribe {
    return this.events.on("error", fn);
  }

  /** Forge job state changes (Hyper3D meshes). The `forge.ready` directive also fires when a job finishes. */
  onJob(fn: (job: WsServerMessageOf<"job">) => void): Unsubscribe {
    return this.events.on("job", fn);
  }

  /** Dispatches a directive to listeners as if the server had pushed it (testing tools, local scripted events). */
  dispatch(directive: Directive): void {
    if (directive.id) {
      if (this.seenSet.has(directive.id)) return;
      this.seenSet.add(directive.id);
      this.seenDirectives.push(directive.id);
      if (this.seenDirectives.length > 500) this.seenSet.delete(this.seenDirectives.shift() as string);
    }
    for (const l of [...this.directiveListeners]) {
      if (l.target && l.target !== directive.target) continue;
      if (!matchKind(l.pattern, directive.kind)) continue;
      try {
        l.fn(directive);
      } catch (err) {
        console.error(`[liveforge] directive listener for "${l.pattern}" threw`, err);
      }
    }
  }

  private onMessage(m: WsServerMessage): void {
    switch (m.t) {
      case "directive":
        this.dispatch(m.directive);
        break;
      case "upgrade":
        this.acceptUpgrade(m.response);
        break;
      case "chunk":
        this.pending.get(m.id)?.handle.pushPartial(m.seq, m.text, m.done);
        break;
      case "job":
        this.events.emit("job", m);
        break;
      case "welcome":
        this.events.emit("welcome", m);
        break;
      case "error":
        this.report(new LiveforgeError(m.error.code, `server: ${m.error.message}`, { details: m.error.details }));
        break;
      default:
        break;
    }
  }

  private onRealtimeStatus(s: RealtimeStatus): void {
    this.events.emit("status", s);
    if (s !== "open") {
      // Socket down: make sure every waiting ask long-polls for its upgrade.
      for (const entry of this.pending.values()) if (entry.waiting && !entry.poll) void this.pollUpgrade(entry);
    }
  }

  // ============================================================================================ other endpoints

  /**
   * Fetches `GET /v1/config` and makes sure the WebSocket is running (it starts on construction already, so calling
   * this is optional). Resolves with the public config; rejects when the server is unreachable or the key is wrong,
   * which makes it a good startup check.
   */
  async connect(): Promise<PublicConfig> {
    this.realtime?.start();
    return this.config(true);
  }

  /** `GET /v1/config`: personas, bosses, actions, elements, enabled modules ... (cached; `refresh` to reload). */
  config(refresh = false): Promise<PublicConfig> {
    if (!this.configPromise || refresh) {
      this.configPromise = this.http.request<PublicConfig>({ method: "GET", path: "/v1/config" }).then((r) => {
        if (!r.data) throw new LiveforgeError("internal", "GET /v1/config returned nothing");
        return r.data;
      });
      this.configPromise.catch(() => {
        this.configPromise = null;
      });
    }
    return this.configPromise;
  }

  /** Persona card from `/v1/config` (name, role, voice ...), or undefined. */
  async persona(id: string): Promise<PublicConfig["personas"][number] | undefined> {
    const c = await this.config();
    return c.personas.find((p) => p.id === id);
  }

  /**
   * Speech to text: `POST /v1/stt`. Pass a recorded Blob (MediaRecorder) or raw bytes with a content type.
   * Returns `{text, language?, flagged?...}`.
   */
  async stt(audio: Blob | ArrayBuffer | Uint8Array, opts: { language?: string; contentType?: string; timeoutMs?: number } = {}): Promise<SttResponse> {
    const blobType = typeof Blob !== "undefined" && audio instanceof Blob ? audio.type : "";
    const contentType = opts.contentType ?? (blobType || "audio/webm");
    const body: BodyInit = audio instanceof Uint8Array ? new Blob([audio as Uint8Array<ArrayBuffer>], { type: contentType }) : (audio as BodyInit);
    const r = await this.http.request<SttResponse>({
      method: "POST",
      path: "/v1/stt",
      query: { language: opts.language },
      body,
      contentType,
      timeoutMs: opts.timeoutMs ?? 30_000,
    });
    if (!r.data) throw new LiveforgeError("internal", "POST /v1/stt returned nothing");
    return r.data;
  }

  /** `GET /v1/forge/jobs/:id` (Hyper3D mesh job). */
  async forgeJob(id: string): Promise<ForgeJob> {
    const r = await this.http.request<ForgeJob>({ method: "GET", path: `/v1/forge/jobs/${encodeURIComponent(id)}` });
    if (!r.data) throw new LiveforgeError("not_found", `forge job ${id} not found`);
    return r.data;
  }

  /** Exports the current world (event log + projections) as a snapshot (`GET /v1/snapshot`). */
  async exportSnapshot(world: string = this._world): Promise<Snapshot> {
    await this.flush();
    const r = await this.http.request<Snapshot>({ method: "GET", path: "/v1/snapshot", query: { world }, timeoutMs: 60_000 });
    if (!r.data) throw new LiveforgeError("internal", "GET /v1/snapshot returned nothing");
    return r.data;
  }

  /** Imports a snapshot (replaces that world's events, then the server rebuilds projections). */
  async importSnapshot(snapshot: Snapshot): Promise<SnapshotImportResult> {
    if (!isPlainObject(snapshot) || snapshot.protocol !== "liveforge-protocol/1" || !Array.isArray(snapshot.events)) {
      throw new LiveforgeError("invalid_input", "importSnapshot: not a Liveforge snapshot");
    }
    const r = await this.http.request<SnapshotImportResult>({ method: "POST", path: "/v1/snapshot", json: snapshot, timeoutMs: 120_000 });
    if (!r.data) throw new LiveforgeError("internal", "POST /v1/snapshot returned nothing");
    return r.data;
  }

  /** Absolute URL for a server-relative path (e.g. a forge GLB `/v1/assets/x.glb`). */
  resolveUrl(path: string): string {
    return this.http.url(path);
  }

  /** Auth headers for your own requests / loaders (e.g. `gltfLoader.setRequestHeader(lf.authHeaders())`). */
  authHeaders(): Record<string, string> {
    return this.http.authHeaders();
  }

  /** Flushes signals, closes the socket and stops waiting for upgrades. The client cannot be reused. */
  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.flush();
    } catch {
      /* best effort */
    }
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.realtime?.stop();
    for (const p of [...this.pending.values()]) p.handle.settleUpgrade(null);
    this.pending.clear();
    for (const off of this.unloadHandlers) off();
    this.directiveListeners.clear();
    this.events.clear();
    this.cache.save();
  }

  // ============================================================================================ internals

  private installUnloadFlush(): void {
    const g = globalThis as { addEventListener?: typeof addEventListener; removeEventListener?: typeof removeEventListener; document?: Document };
    if (typeof g.addEventListener !== "function" || !g.document) return;
    const onHide = () => this.flushOnUnload();
    const onVis = () => {
      if (g.document?.visibilityState === "hidden") this.flushOnUnload();
    };
    g.addEventListener("pagehide", onHide);
    g.document.addEventListener("visibilitychange", onVis);
    this.unloadHandlers.push(() => {
      g.removeEventListener?.("pagehide", onHide);
      g.document?.removeEventListener("visibilitychange", onVis);
    });
  }

  /** Sends queued signals with keepalive fetch (falls back to navigator.sendBeacon with `?key=`). */
  private flushOnUnload(): void {
    if (!this.queue.length || this.cfg.offline) return;
    const all = this.queue.splice(0);
    const chunks: Signal[][] = [];
    let cur: Signal[] = [];
    let size = 0;
    for (const s of all) {
      const n = JSON.stringify(s).length + 1;
      if (cur.length && (size + n > 60_000 || cur.length >= 500)) {
        chunks.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(s);
      size += n;
    }
    if (cur.length) chunks.push(cur);
    for (const signals of chunks) {
      const body = JSON.stringify({ signals });
      let sent = false;
      if (this.fetchImpl) {
        try {
          void this.fetchImpl(this.http.url("/v1/signals"), {
            method: "POST",
            headers: { ...this.http.authHeaders(), "content-type": "application/json" },
            body,
            keepalive: true,
          }).catch(() => {});
          sent = true;
        } catch {
          sent = false;
        }
      }
      if (!sent) {
        const nav = (globalThis as { navigator?: Navigator }).navigator;
        if (nav && typeof nav.sendBeacon === "function") {
          nav.sendBeacon(this.http.url("/v1/signals", { key: this.cfg.gameKey }), new Blob([body], { type: "application/json" }));
        }
      }
    }
  }

  private report(err: LiveforgeError): void {
    if (this.events.listenerCount("error") > 0) this.events.emit("error", err);
    if (this.cfg.onError) {
      try {
        this.cfg.onError(err);
      } catch {
        /* ignore */
      }
    } else if (this.events.listenerCount("error") === 0) {
      console.warn(err.message);
    }
  }
}

/** Creates a client (same as `new LiveforgeClient(config)`). */
export function createClient(config: LiveforgeConfig): LiveforgeClient {
  return new LiveforgeClient(config);
}

function matchKind(pattern: string, kind: string): boolean {
  if (pattern === "*" || pattern === kind) return true;
  if (pattern.endsWith(".*")) return kind.startsWith(pattern.slice(0, -1));
  return false;
}

function checkId(what: string, v: unknown): void {
  if (typeof v !== "string" || !ID_RE.test(v)) {
    throw new LiveforgeError("invalid_input", `${what} must be 1-64 characters of letters, digits, _ - . : (got ${JSON.stringify(v)})`);
  }
}

function toError(err: unknown): LiveforgeError {
  if (isLiveforgeError(err)) return err;
  return new LiveforgeError("internal", err instanceof Error ? err.message : String(err), { cause: err });
}

const missingFetch: FetchLike = () => Promise.reject(new LiveforgeError("network", "no fetch implementation: pass config.fetch"));

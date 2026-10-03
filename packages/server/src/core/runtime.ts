// The Liveforge runtime: games (manifest + keys + enabled modules), event ingest, projections, the two-stage ask
// engine, directive emission, ticks, jobs, snapshots, review queue. HTTP / WS are thin layers over this.
import { randomUUID } from "node:crypto";
import {
  ASKS, AskRequest, BUILTIN_MOMENTS, DIRECTIVE_KINDS, DirectiveDraftSchema, PROTOCOL_ID, Signal, Snapshot, isAskKind, validateDirectiveArgs,
  type AnyAskResponse, type AskKind, type AskSource, type BakePack, type Directive, type DirectiveLog, type ForgeJob,
  type ReviewItem, type SignalBatchResult, type SnapshotImportResult, type StoredEvent,
} from "@liveforge/protocol";
import {
  actionsFor, moduleEnabled, moduleOptions, parseManifest, personaById, signalAllowed, ManifestError,
  type Manifest, type ManifestIssue,
} from "@liveforge/manifest";
import { loadManifest } from "@liveforge/manifest/node";
import type { ServerConfig } from "../config.js";
import type { Logger } from "../log.js";
import { LfError, BudgetExceededError } from "../errors.js";
import { openDb, Kv, type Db } from "../store/db.js";
import { EventLog, matchType, type EventQuery } from "../store/events.js";
import { ProjectionEngine } from "../store/projections.js";
import { CacheStore } from "./cache.js";
import { KeywordModerator, type Moderator } from "./moderation.js";
import { BudgetTracker } from "./budgets.js";
import { Metrics } from "./metrics.js";
import { WsHub } from "./hub.js";
import { JobRunner } from "./jobs.js";
import { fallbackAnswer } from "./fallbacks.js";
import { priceFor, type Providers } from "../providers/index.js";
import type {
  AskContext, AskHandler, BudgetView, EventContext, LiveforgeModule, ModuleContext, Projection, ProjectionReader,
  ScopedContext, ScopedLlm, TickContext,
} from "../module.js";

export interface GameRuntime {
  id: string;
  manifest: Manifest;
  manifestPath: string | null;
  warnings: ManifestIssue[];
  modules: LiveforgeModule[];
  askHandlers: Map<AskKind, { module: string; handler: AskHandler<AskKind> }>;
  timers: ReturnType<typeof setInterval>[];
}

interface PendingUpgrade {
  game: string;
  response: AnyAskResponse | null;
  done: boolean;
  waiters: ((r: AnyAskResponse | null) => void)[];
  expires: number;
}

/** Core projection: last 200 directives per world. */
const directiveLogProjection: Projection<DirectiveLog> = {
  name: "core.directives",
  scope: "world",
  version: 1,
  types: ["lf.directive"],
  init: () => ({ directives: [] }),
  apply(state, ev) {
    const d = ev.data as unknown as Directive;
    state.directives.push({ id: d.id, kind: d.kind, target: d.target, why: d.why, ts: d.ts, player: d.player, source: d.source });
    if (state.directives.length > 200) state.directives.splice(0, state.directives.length - 200);
  },
};

const SIM_PRESETS: Record<string, { description: string; signals: { type: string; data: Record<string, unknown> }[] }> = {
  dodger: { description: "Dodges everything, mostly to the left.", signals: Array.from({ length: 20 }, (_, i) => ({ type: "combat.dodged", data: { source: "boss", direction: i % 4 === 0 ? "right" : "left" } })) },
  turtle: { description: "Blocks constantly, rarely attacks.", signals: [...Array.from({ length: 15 }, () => ({ type: "combat.blocked", data: { source: "boss" } })), { type: "combat.hit", data: { target: "boss", damage: 3 } }] },
  berserker: { description: "Hits hard and often, takes lots of damage.", signals: Array.from({ length: 16 }, (_, i) => (i % 2 ? { type: "combat.hit", data: { target: "boss", damage: 20, range: 1 } } : { type: "combat.hurt", data: { source: "boss", damage: 12, hp: Math.max(0.1, 1 - i * 0.05) } })) },
  ranged_camper: { description: "Shoots from far away.", signals: Array.from({ length: 15 }, () => ({ type: "combat.hit", data: { target: "boss", damage: 8, range: 25, weapon: "bow" } })) },
  rich_show_off: { description: "Flashes a lot of gold in town and buys expensive things.", signals: [{ type: "movement.entered_zone", data: { zone: "courtyard" } }, { type: "economy.gold", data: { amount: 5000, delta: 4000 } }, { type: "economy.bought", data: { item: "golden_hat", price: 900 } }, { type: "gear.equipped", data: { item: "golden_hat", slot: "head", tags: ["gold", "flashy"], value: 900 } }] },
  thief: { description: "Steals from NPCs.", signals: [{ type: "economy.stole", data: { from: "merchant", item: "apple", value: 2, seen: false } }, { type: "economy.stole", data: { from: "merchant", item: "ring", value: 80, seen: true } }] },
  chatterbox: { description: "Talks to everyone.", signals: Array.from({ length: 8 }, (_, i) => ({ type: "social.talked_to", data: { npc: `npc_${i % 4}` } })) },
  near_death: { description: "Drops to 3% HP, then flees and survives.", signals: [{ type: "combat.hurt", data: { source: "boss", damage: 40, hp: 0.03 } }, { type: "movement.fled", data: { from: "boss", hp: 0.03 } }] },
  explorer: { description: "Discovers new places.", signals: ["library", "forge_hall", "undercroft", "lecture_hall"].map((z) => ({ type: "movement.explored", data: { zone: z, discovery: z } })) },
};

export interface LiveforgeOptions {
  modules: LiveforgeModule[];
  providers: Providers;
  moderator?: Moderator;
  log: Logger;
}

export class Liveforge {
  readonly db: Db;
  readonly events: EventLog;
  readonly projections: ProjectionEngine;
  readonly cacheStore: CacheStore;
  readonly budgets: BudgetTracker;
  readonly metrics: Metrics;
  readonly hub: WsHub;
  readonly jobs: JobRunner;
  readonly kv: Kv;
  readonly moderator: Moderator;
  readonly games = new Map<string, GameRuntime>();
  private readonly pending = new Map<string, PendingUpgrade>();
  private readonly rate = new Map<string, { start: number; n: number }>();
  private readonly running = new Set<string>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private dispatchDepth = 0;
  private readonly shutdownAc = new AbortController();
  readonly log: Logger;

  constructor(readonly config: ServerConfig, private readonly opts: LiveforgeOptions) {
    this.log = opts.log;
    this.db = openDb(config.dbPath);
    this.events = new EventLog(this.db);
    this.projections = new ProjectionEngine(this.db, this.events, this.log.child("projections"));
    this.cacheStore = new CacheStore(this.db);
    this.budgets = new BudgetTracker(this.db);
    this.metrics = new Metrics(this.db);
    this.hub = new WsHub(this.log.child("ws"));
    this.kv = new Kv(this.db);
    this.moderator = opts.moderator ?? new KeywordModerator();
    this.jobs = new JobRunner(this.db, opts.providers.mesh3d, config.dataDir, config.mesh3d.pollMs, {
      onChange: (job, scope) => this.onJobChange(job, scope),
    }, this.log.child("jobs"));
  }

  get providers(): Providers {
    return this.opts.providers;
  }

  // ------------------------------------------------------------------ lifecycle

  async start(): Promise<void> {
    if (!this.config.manifests.length) throw new Error("no manifests configured (LIVEFORGE_MANIFESTS)");
    for (const path of this.config.manifests) {
      const { manifest, warnings } = loadManifest(path);
      for (const w of warnings) this.log.warn(`manifest ${path}: ${w.path}: ${w.message}`);
      if (this.games.has(manifest.game.id)) throw new Error(`duplicate game id "${manifest.game.id}" (${path})`);
      await this.installGame(manifest, path, warnings);
    }
    this.flushTimer = setInterval(() => this.projections.flush(), this.config.flushMs);
    this.jobs.start();
    this.log.info("liveforge started", { games: [...this.games.keys()], llm: this.providers.llm?.id ?? "none" });
  }

  private async installGame(manifest: Manifest, path: string | null, warnings: ManifestIssue[]): Promise<GameRuntime> {
    const id = manifest.game.id;
    const old = this.games.get(id);
    old?.timers.forEach(clearInterval);
    const modules = this.opts.modules.filter((m) => moduleEnabled(manifest, m.id));
    const askHandlers = new Map<AskKind, { module: string; handler: AskHandler<AskKind> }>();
    for (const m of modules) {
      for (const [kind, handler] of Object.entries(m.asks ?? {})) {
        if (!handler) continue;
        if (!isAskKind(kind)) {
          this.log.warn(`module ${m.id} registers unknown ask kind "${kind}" (ignored)`);
          continue;
        }
        const prev = askHandlers.get(kind);
        if (prev) this.log.warn(`ask kind ${kind} registered by ${prev.module} and ${m.id}; using ${m.id}`);
        askHandlers.set(kind, { module: m.id, handler: handler as AskHandler<AskKind> });
      }
    }
    const rt: GameRuntime = { id, manifest, manifestPath: path, warnings, modules, askHandlers, timers: [] };
    this.games.set(id, rt);
    const projections = [directiveLogProjection as Projection<unknown>, ...modules.flatMap((m) => (m.projections ?? []) as Projection<unknown>[])];
    this.projections.register(id, manifest, projections);
    for (const m of modules) {
      try {
        await m.init?.(this.moduleContext(id, m.id));
      } catch (e) {
        this.log.error(`module ${m.id} init failed`, { game: id, error: e as Error });
      }
      for (const tick of m.ticks ?? []) {
        rt.timers.push(setInterval(() => void this.runTick(id, m.id, tick.name, tick.run), Math.max(250, tick.everyMs)));
      }
    }
    this.log.info("game installed", { game: id, modules: modules.map((m) => m.id), asks: [...askHandlers.keys()], projections: projections.map((p) => p.name) });
    return rt;
  }

  async reloadManifest(game: string, text?: string): Promise<{ ok: boolean; errors: ManifestIssue[]; warnings: ManifestIssue[] }> {
    const rt = this.game(game);
    let manifest: Manifest;
    let warnings: ManifestIssue[];
    if (text !== undefined) {
      const r = parseManifest(text);
      if (!r.ok) return { ok: false, errors: r.errors, warnings: r.warnings };
      manifest = r.manifest;
      warnings = r.warnings;
    } else {
      if (!rt.manifestPath) throw new LfError("bad_request", "game has no manifest file; POST the manifest text");
      try {
        ({ manifest, warnings } = loadManifest(rt.manifestPath));
      } catch (e) {
        if (e instanceof ManifestError) return { ok: false, errors: e.issues, warnings: [] };
        throw e;
      }
    }
    if (manifest.game.id !== game) return { ok: false, errors: [{ path: "game.id", message: `cannot change game id on reload (${game} -> ${manifest.game.id})`, severity: "error" }], warnings };
    this.projections.flush(game);
    await this.installGame(manifest, rt.manifestPath, warnings);
    return { ok: true, errors: [], warnings };
  }

  async stop(): Promise<void> {
    this.shutdownAc.abort();
    if (this.flushTimer) clearInterval(this.flushTimer);
    for (const rt of this.games.values()) rt.timers.forEach(clearInterval);
    this.jobs.stop();
    this.hub.close();
    this.projections.flush();
    this.db.close();
  }

  game(id: string): GameRuntime {
    const rt = this.games.get(id);
    if (!rt) throw new LfError("not_found", `unknown game "${id}"`);
    return rt;
  }

  // ------------------------------------------------------------------ auth

  /** Resolve a key to a game (SDK key) or admin. `gameParam` picks the game for admin keys. */
  authenticate(key: string | null, gameParam: string | null): { game: string; admin: boolean } | null {
    if (!key) return null;
    const firstGame = this.games.keys().next().value as string | undefined;
    const adminKey = this.config.adminKey ?? (this.config.dev ? "dev-admin" : null);
    if (adminKey && key === adminKey) {
      const game = gameParam && this.games.has(gameParam) ? gameParam : firstGame;
      return game ? { game, admin: true } : null;
    }
    for (const [game, keys] of Object.entries(this.config.sdkKeys)) if (keys.includes(key) && this.games.has(game)) return { game, admin: false };
    if (this.config.dev && key.startsWith("pk_dev_")) {
      const game = key.slice("pk_dev_".length);
      if (this.games.has(game) && !(this.config.sdkKeys[game]?.length)) return { game, admin: false };
    }
    return null;
  }

  /** Fixed-window rate limit per key. */
  rateLimit(key: string): boolean {
    const now = Date.now();
    const r = this.rate.get(key);
    if (!r || now - r.start >= 60_000) {
      this.rate.set(key, { start: now, n: 1 });
      return true;
    }
    r.n++;
    return r.n <= this.config.rateLimitPerMin;
  }

  // ------------------------------------------------------------------ events

  /** Append + project + broadcast + dispatch handlers. */
  appendEvent(game: string, e: Omit<StoredEvent, "seq" | "receivedAt" | "game">): StoredEvent {
    const ev = this.events.append({ ...e, game });
    this.projections.apply(ev);
    this.hub.event(ev);
    this.dispatch(game, ev);
    return ev;
  }

  private dispatch(game: string, ev: StoredEvent): void {
    const rt = this.games.get(game);
    if (!rt) return;
    if (this.dispatchDepth > 8) {
      this.log.warn("signal handler recursion depth exceeded; dropping dispatch", { type: ev.type, seq: ev.seq });
      return;
    }
    this.dispatchDepth++;
    try {
      for (const m of rt.modules) {
        for (const h of m.signalHandlers ?? []) {
          if (!h.types.some((t) => matchType(t, ev.type))) continue;
          const ctx: EventContext = { ...this.scopedContext(game, m.id, ev.world, ev.player, ev.session), event: ev };
          try {
            const r = h.handle(ctx, ev);
            if (r && typeof (r as Promise<void>).catch === "function") {
              (r as Promise<void>).catch((e) => this.log.error("signal handler failed", { module: m.id, type: ev.type, error: e as Error }));
            }
          } catch (e) {
            this.log.error("signal handler failed", { module: m.id, type: ev.type, error: e as Error });
          }
        }
      }
    } finally {
      this.dispatchDepth--;
    }
  }

  ingestSignals(game: string, raw: unknown): SignalBatchResult {
    const rt = this.game(game);
    const list = (raw as { signals?: unknown })?.signals;
    if (!Array.isArray(list) || list.length === 0) throw new LfError("bad_request", "body must be {signals: Signal[]} with at least one signal");
    if (list.length > 500) throw new LfError("bad_request", "at most 500 signals per batch");
    const rejected: SignalBatchResult["rejected"] = [];
    let accepted = 0;
    let lastSeq: number | null = null;
    list.forEach((s, index) => {
      const parsed = Signal.safeParse(s);
      if (!parsed.success) {
        rejected.push({ index, code: "bad_request", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
        return;
      }
      const sig = parsed.data;
      if (!signalAllowed(rt.manifest, sig.type)) {
        rejected.push({ index, code: "unknown_kind", message: `signal type "${sig.type}" is not built-in and not declared in the manifest signals` });
        return;
      }
      const ev = this.appendEvent(game, {
        world: sig.world, player: sig.player, session: sig.session ?? "default", type: sig.type, data: sig.data, ts: sig.ts, origin: "sdk",
      });
      accepted++;
      lastSeq = ev.seq;
    });
    return { accepted, rejected, lastSeq };
  }

  // ------------------------------------------------------------------ directives

  emit(game: string, module: string, draftRaw: unknown, scope: { world: string; player?: string | null }): Directive | null {
    const rt = this.game(game);
    const parsed = DirectiveDraftSchema.safeParse(draftRaw);
    if (!parsed.success) {
      this.log.warn("directive rejected: bad draft", { module, issues: parsed.error.issues.map((i) => i.message) });
      return null;
    }
    const draft = parsed.data;
    const v = validateDirectiveArgs(draft.kind, draft.args);
    if (!v.ok) {
      this.log.warn("directive rejected", { module, kind: draft.kind, error: v.error });
      return null;
    }
    if (draft.kind === "npc.action") {
      const err = this.checkNpcAction(rt.manifest, module, draft.args as { npc: string; action: { action: string; args: Record<string, unknown> } });
      if (err) {
        this.log.warn("directive rejected: action schema", { module, error: err });
        return null;
      }
    }
    const d: Directive = {
      id: `dir_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      kind: draft.kind,
      target: draft.target,
      args: draft.args,
      why: (draft.why || "").slice(0, 200),
      ts: Date.now(),
      world: scope.world,
      player: scope.player ?? null,
      source: module,
    };
    this.appendEvent(game, { world: d.world, player: d.player, session: null, type: "lf.directive", data: d as unknown as Record<string, unknown>, ts: d.ts, origin: "module" });
    this.hub.directive(game, d);
    return d;
  }

  /** Only manifest-declared actions, usable by this emitter, allowed for the persona; args type-checked + clamped in place. */
  private checkNpcAction(m: Manifest, module: string, args: { npc: string; action: { action: string; args: Record<string, unknown> } }): string | null {
    const name = args.action.action;
    const decl = m.actions[name];
    if (!decl) return `action "${name}" is not declared in the manifest`;
    const by = module === "director" ? "director" : module === "world" ? "world" : "npc";
    if (!decl.by.includes(by) && !decl.by.includes("npc")) return `action "${name}" may not be emitted by ${module}`;
    const persona = personaById(m, args.npc);
    if (persona && !actionsFor(m, persona.id).includes(name) && !(by !== "npc" && decl.by.includes(by))) return `persona "${args.npc}" may not "${name}"`;
    const a = args.action.args ?? {};
    for (const [k, spec] of Object.entries(decl.args)) {
      const val = a[k];
      if (val === undefined) {
        if (spec.required) return `action "${name}" needs arg "${k}"`;
        continue;
      }
      if (spec.type === "number") {
        if (typeof val !== "number" || !Number.isFinite(val)) return `action "${name}" arg "${k}" must be a number`;
        a[k] = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, val));
      } else if (spec.type === "string") {
        if (typeof val !== "string") return `action "${name}" arg "${k}" must be a string`;
        if (spec.enum && !spec.enum.includes(val)) return `action "${name}" arg "${k}" must be one of ${spec.enum.join(", ")}`;
      } else if (typeof val !== "boolean") return `action "${name}" arg "${k}" must be a boolean`;
    }
    for (const k of Object.keys(a)) if (!(k in decl.args)) delete a[k];
    args.action.args = a;
    return null;
  }

  // ------------------------------------------------------------------ contexts

  private scopedLlm(game: string, module: string, defaultPlayer: string | null, signal?: AbortSignal): ScopedLlm | null {
    const provider = this.providers.llm;
    if (!provider) return null;
    const self = this;
    const prepare = (task: string | undefined, player: string | null | undefined, tier: "fast" | "rich" | undefined) => {
      const m = self.game(game).manifest;
      const pl = player === undefined ? defaultPlayer : player;
      const b = self.budgets.check(game, m, pl);
      if (!b.ok) throw new BudgetExceededError(b.reason);
      const effTier = (task && m.models.overrides[task]) || tier || "fast";
      const models = { fast: self.config.llm.modelFast ?? m.models.fast, rich: self.config.llm.modelRich ?? m.models.rich };
      return { pl, effTier, models };
    };
    const account = (task: string | undefined, pl: string | null, model: string, ms: number, usage: { inputTokens: number; outputTokens: number }, error?: string) => {
      const [pin, pout] = priceFor(model, self.config.llm.prices);
      const usd = (usage.inputTokens * pin + usage.outputTokens * pout) / 1e6;
      self.budgets.charge(game, pl, { ...usage, usd });
      self.metrics.log({ id: randomUUID(), game, world: null, player: pl, kind: task ?? module, module, stage: "llm", source: "ai", ms, ...usage, usd, error });
    };
    return {
      provider: provider.id,
      async json(schema, system, user, opts = {}) {
        const { pl, effTier, models } = prepare(opts.task, opts.player, opts.tier);
        const started = Date.now();
        try {
          const r = await provider.json(schema, system, user, { ...opts, tier: effTier, models, signal: opts.signal ?? signal });
          account(opts.task, pl, r.model, r.ms, r.usage);
          return r as never;
        } catch (e) {
          self.metrics.log({ id: randomUUID(), game, world: null, player: pl, kind: opts.task ?? module, module, stage: "llm", source: "ai", ms: Date.now() - started, error: (e as Error).message.slice(0, 200) });
          throw e;
        }
      },
      async stream(system, user, opts = {}) {
        const { pl, effTier, models } = prepare(opts.task, opts.player, opts.tier);
        const started = Date.now();
        try {
          const r = await provider.stream(system, user, { ...opts, tier: effTier, models, signal: opts.signal ?? signal });
          account(opts.task, pl, r.model, r.ms, r.usage);
          return r;
        } catch (e) {
          self.metrics.log({ id: randomUUID(), game, world: null, player: pl, kind: opts.task ?? module, module, stage: "llm", source: "ai", ms: Date.now() - started, error: (e as Error).message.slice(0, 200) });
          throw e;
        }
      },
    };
  }

  moduleContext(game: string, module: string, player: string | null = null, signal?: AbortSignal): ModuleContext {
    const self = this;
    const projections = {
      get: (name: string, scope: { world: string; player?: string | null }) => self.projections.get(game, name, scope.world, scope.player),
      all: (name: string, world: string) => self.projections.all(game, name, world),
    } as ProjectionReader;
    const budgets: BudgetView = { check: (p) => self.budgets.check(game, self.game(game).manifest, p) };
    return {
      game,
      get manifest() { return self.game(game).manifest; },
      module,
      get options() { return moduleOptions(self.game(game).manifest, module); },
      log: this.log.child(`${game}:${module}`),
      now: () => Date.now(),
      events: (q: Omit<EventQuery, "game">) => self.events.query({ ...q, game }),
      projections,
      kv: this.kv.scoped(game, module),
      llm: this.scopedLlm(game, module, player, signal),
      stt: this.providers.stt,
      tts: this.providers.tts,
      jobs: {
        submitMesh: async (prompt, o) => (self.game(game).manifest.clamps.forge.meshJobs ? self.jobs.submit(game, prompt, o) : null),
        get: (id) => self.jobs.get(id, game),
      },
      budgets,
      cache: this.cacheStore.scoped(game),
      moderation: this.moderator,
      emit: (draft, scope) => self.emit(game, module, draft, scope),
      record: (type, data, scope) => self.appendEvent(game, { world: scope.world, player: scope.player ?? null, session: scope.session ?? null, type, data, ts: Date.now(), origin: "module" }),
    };
  }

  scopedContext(game: string, module: string, world: string, player: string | null, session: string | null, signal?: AbortSignal): ScopedContext {
    const base = this.moduleContext(game, module, player, signal);
    return Object.assign(Object.create(Object.getPrototypeOf(base), Object.getOwnPropertyDescriptors(base)), {
      world,
      player,
      session,
      emit: (draft: unknown, scope?: { world?: string; player?: string | null }) =>
        this.emit(game, module, draft, { world: scope?.world ?? world, player: scope && "player" in scope ? scope.player : player }),
      record: (type: string, data: Record<string, unknown>, scope?: { world?: string; player?: string | null }) =>
        this.appendEvent(game, { world: scope?.world ?? world, player: scope && "player" in scope ? (scope.player ?? null) : player, session, type, data, ts: Date.now(), origin: "module" }),
    }) as ScopedContext;
  }

  private async runTick(game: string, module: string, name: string, run: (ctx: TickContext) => void | Promise<void>): Promise<void> {
    const worlds = this.events.worlds(game).filter((w) => Date.now() - w.lastSeen < this.config.activeWorldMs);
    for (const w of worlds) {
      const key = `${game}|${module}|${name}|${w.world}`;
      if (this.running.has(key)) continue;
      this.running.add(key);
      try {
        const ctx: TickContext = { ...this.scopedContext(game, module, w.world, null, null), activePlayers: this.events.activePlayers(game, w.world, this.config.activeWorldMs) };
        await run(ctx);
      } catch (e) {
        this.log.error("tick failed", { game, module, tick: name, world: w.world, error: e as Error });
      } finally {
        this.running.delete(key);
      }
    }
  }

  // ------------------------------------------------------------------ asks

  async ask(game: string, kindStr: string, body: unknown): Promise<AnyAskResponse> {
    const started = Date.now();
    const rt = this.game(game);
    if (!isAskKind(kindStr)) throw new LfError("unknown_kind", `unknown ask kind "${kindStr}"`, { known: Object.keys(ASKS) });
    const kind: AskKind = kindStr;
    const req = AskRequest.safeParse(body);
    if (!req.success) throw new LfError("bad_request", "invalid ask request", req.error.issues);
    const { world, player } = req.data;
    const session = req.data.session ?? null;
    const pv = ASKS[kind].params.safeParse(req.data.params);
    if (!pv.success) throw new LfError("bad_request", `invalid params for ${kind}`, pv.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    const params = pv.data as never;
    const id = req.data.id ?? `ask_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    if (kind === "npc.reply") {
      const v = await this.moderator.check((params as { text: string }).text, { direction: "input", manifest: rt.manifest });
      if (!v.ok) throw new LfError("moderated", "player text blocked by moderation", { reason: v.reason });
    }

    const owner = rt.askHandlers.get(kind);
    const module = owner?.module ?? "core";
    const handler = owner?.handler;
    const ac = new AbortController();
    this.shutdownAc.signal.addEventListener("abort", () => ac.abort(), { once: true });
    let seq = 0;
    const scoped = this.scopedContext(game, module, world, player, session, ac.signal);
    const ctx: AskContext = Object.assign(scoped, {
      askId: id,
      kind,
      signal: ac.signal,
      chunk: (text: string) => void this.hub.chunk(game, world, player, id, seq++, text, false),
    });
    const resultSchema = ASKS[kind].result;

    // 1) cache of earlier upgraded answers
    let cacheKey: string | null = null;
    if (handler?.upgrade) {
      const material = handler.cacheKey ? handler.cacheKey(params, ctx) : { params, player };
      if (material !== false) {
        cacheKey = ctx.cache.key(kind, material);
        const hit = ctx.cache.get<{ result: unknown; why?: string }>(cacheKey);
        if (hit && resultSchema.safeParse(hit.result).success) {
          const res: AnyAskResponse = { id, kind, stage: "instant", result: hit.result, source: "cache", why: hit.why, upgrade: "none", ms: Date.now() - started, ts: Date.now() };
          this.metrics.log({ id, game, world, player, kind, module, stage: "instant", source: "cache", ms: res.ms! });
          return res;
        }
      }
    }

    // 2) instant
    let result: unknown;
    let why: string | undefined;
    let source: AskSource = "rules";
    let final = false;
    let instantError: string | null = null;
    if (handler) {
      try {
        const a = await handler.instant(ctx, params);
        const ok = resultSchema.safeParse(a.result);
        if (ok.success) {
          result = ok.data;
          why = a.why;
          source = a.source ?? "rules";
          final = !!a.final;
        } else {
          instantError = `instant result failed schema: ${ok.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
          this.log.warn(instantError, { game, kind, module });
        }
      } catch (e) {
        instantError = (e as Error).message;
        this.log.error("instant failed; using core fallback", { game, kind, module, error: e as Error });
      }
    }
    if (result === undefined) {
      const fb = fallbackAnswer(kind, params, rt.manifest, player);
      result = fb.result;
      why = fb.why;
      source = "rules";
    }

    // 3) schedule upgrade
    const budgetOk = this.budgets.check(game, rt.manifest, player).ok;
    const willUpgrade = !!handler?.upgrade && !final && req.data.upgrade !== false && !!this.providers.llm && budgetOk;
    const response: AnyAskResponse = { id, kind, stage: "instant", result, source, why, upgrade: willUpgrade ? "pending" : "none", ms: Date.now() - started, ts: Date.now() };
    this.metrics.log({ id, game, world, player, kind, module, stage: "instant", source, ms: response.ms!, error: instantError });
    if (willUpgrade) {
      this.pending.set(id, { game, response: null, done: false, waiters: [], expires: Date.now() + 5 * 60_000 });
      void this.runUpgrade(game, module, handler!, ctx, params, response, cacheKey, () => seq, ac);
    }
    this.gcPending();
    return response;
  }

  private async runUpgrade(
    game: string, module: string, handler: AskHandler<AskKind>, ctx: AskContext, params: never, instant: AnyAskResponse,
    cacheKey: string | null, chunkCount: () => number, ac: AbortController,
  ): Promise<void> {
    const started = Date.now();
    const timeoutMs = handler.upgradeTimeoutMs ?? this.config.llm.timeoutMs + 2000;
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let final: AnyAskResponse;
    let error: string | null = null;
    try {
      const up = await Promise.race([
        handler.upgrade!(ctx, params, instant.result as never),
        new Promise<never>((_, rej) => ac.signal.addEventListener("abort", () => rej(new Error(`upgrade timed out after ${timeoutMs}ms`)), { once: true })),
      ]);
      const ok = up ? ASKS[instant.kind as AskKind].result.safeParse(up.result) : null;
      if (up && ok?.success) {
        final = { id: instant.id, kind: instant.kind, stage: "upgrade", result: ok.data, source: "ai", why: up.why ?? instant.why, ms: Date.now() - started, ts: Date.now() };
        if (cacheKey) ctx.cache.set(cacheKey, { result: ok.data, why: final.why }, { ttlSec: handler.cacheTtlSec ?? 3600, kind: instant.kind });
      } else {
        if (up && ok && !ok.success) error = `upgrade result failed schema: ${ok.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
        final = { ...instant, stage: "upgrade", upgrade: undefined, why: instant.why ?? "kept instant answer", ms: Date.now() - started, ts: Date.now() };
      }
    } catch (e) {
      error = (e as Error).message;
      final = { ...instant, stage: "upgrade", upgrade: undefined, why: instant.why ?? "kept instant answer", ms: Date.now() - started, ts: Date.now() };
    } finally {
      clearTimeout(timer);
    }
    if (error) this.log.warn("upgrade failed; instant answer stands", { game, kind: instant.kind, module, error });
    if (chunkCount() > 0) this.hub.chunk(game, ctx.world, ctx.player!, instant.id, chunkCount(), "", true);
    this.hub.upgrade(game, ctx.world, ctx.player!, final);
    this.metrics.log({ id: instant.id, game, world: ctx.world, player: ctx.player, kind: instant.kind, module, stage: "upgrade", source: final.source, ms: Date.now() - started, error });
    const p = this.pending.get(instant.id);
    if (p) {
      p.response = final;
      p.done = true;
      p.waiters.splice(0).forEach((w) => w(final));
    }
  }

  /** Long-poll: resolves with the upgrade (or null on timeout). Throws not_found for unknown ids. */
  async waitUpgrade(game: string, id: string, waitMs: number): Promise<AnyAskResponse | null> {
    const p = this.pending.get(id);
    if (!p || p.game !== game) throw new LfError("not_found", `no pending upgrade "${id}"`);
    if (p.done) return p.response;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        const i = p.waiters.indexOf(done);
        if (i >= 0) p.waiters.splice(i, 1);
        resolve(null);
      }, Math.max(0, Math.min(waitMs, 30_000)));
      const done = (r: AnyAskResponse | null) => {
        clearTimeout(t);
        resolve(r);
      };
      p.waiters.push(done);
    });
  }

  private gcPending(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.expires < now && p.waiters.length === 0) this.pending.delete(id);
  }

  // ------------------------------------------------------------------ jobs

  private onJobChange(job: ForgeJob, scope: { game: string; world: string; player: string | null; meta: Record<string, unknown> }): void {
    if (!this.games.has(scope.game)) return;
    this.hub.job(scope.game, scope.world, scope.player, job.id, job.state, job.url);
    this.appendEvent(scope.game, { world: scope.world, player: scope.player, session: null, type: "lf.forge.job", data: { jobId: job.id, state: job.state, url: job.url ?? null, askId: job.askId ?? null, meta: scope.meta }, ts: Date.now(), origin: "module" });
    if (job.state === "done" || job.state === "failed") {
      this.emit(scope.game, "forge", {
        kind: "forge.ready",
        target: "player",
        args: { jobId: job.id, state: job.state, ...(job.askId ? { askId: job.askId } : {}), ...(job.url ? { url: job.url } : {}) },
        why: job.state === "done" ? "3D model finished" : `3D model failed: ${job.error ?? "unknown"}`,
      }, { world: scope.world, player: scope.player });
    }
  }

  // ------------------------------------------------------------------ snapshots

  exportSnapshot(game: string, world: string): Snapshot {
    this.game(game);
    const events = [...this.events.scan(game, { world })];
    return {
      protocol: PROTOCOL_ID,
      game,
      world,
      exportedAt: Date.now(),
      upToSeq: events.length ? events[events.length - 1].seq : 0,
      events,
      projections: this.projections.dumpWorld(game, world),
    };
  }

  importSnapshot(game: string, raw: unknown, targetWorld?: string): SnapshotImportResult {
    this.game(game);
    const parsed = Snapshot.safeParse(raw);
    if (!parsed.success) throw new LfError("bad_request", "invalid snapshot", parsed.error.issues.slice(0, 10));
    const snap = parsed.data;
    if (snap.game !== game) throw new LfError("bad_request", `snapshot is for game "${snap.game}", not "${game}"`);
    const world = targetWorld ?? snap.world;
    const tx = this.db.transaction(() => {
      this.events.deleteWorld(game, world);
      for (const e of snap.events) {
        this.events.append({ game, world, player: e.player, session: e.session, type: e.type, data: e.data, ts: e.ts, origin: "import" });
      }
    });
    tx();
    this.projections.rebuild(game, world);
    return { world, events: snap.events.length, rebuilt: this.projections.names(game).map((p) => p.name) };
  }

  // ------------------------------------------------------------------ review / bake

  enqueueReview(game: string, kind: string, payload: unknown, note?: string): ReviewItem {
    const id = `rev_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = Date.now();
    this.db.prepare("INSERT INTO review (id, game, kind, status, payload, note, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)").run(id, game, kind, JSON.stringify(payload), note ?? null, now, now);
    return { id, kind, status: "pending", payload, ...(note ? { note } : {}), createdAt: now, updatedAt: now };
  }

  listReview(game: string, status?: string): ReviewItem[] {
    const rows = (status
      ? this.db.prepare("SELECT * FROM review WHERE game = ? AND status = ? ORDER BY created_at DESC LIMIT 500").all(game, status)
      : this.db.prepare("SELECT * FROM review WHERE game = ? ORDER BY created_at DESC LIMIT 500").all(game)) as { id: string; kind: string; status: ReviewItem["status"]; payload: string; note: string | null; created_at: number; updated_at: number }[];
    return rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, payload: JSON.parse(r.payload), ...(r.note ? { note: r.note } : {}), createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  setReview(game: string, id: string, status: ReviewItem["status"], note?: string): void {
    const n = this.db.prepare("UPDATE review SET status = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ? AND game = ?").run(status, note ?? null, Date.now(), id, game).changes;
    if (!n) throw new LfError("not_found", `no review item "${id}"`);
  }

  bakePack(game: string): BakePack {
    const entries: BakePack["entries"] = {};
    for (const item of this.listReview(game, "approved")) (entries[item.kind] ??= []).push({ key: item.id, result: item.payload });
    return { protocol: PROTOCOL_ID, game, createdAt: Date.now(), entries };
  }

  // ------------------------------------------------------------------ simulate

  simulatePresets(): { id: string; description: string; signals: number }[] {
    return Object.entries(SIM_PRESETS).map(([id, p]) => ({ id, description: p.description, signals: p.signals.length }));
  }

  simulate(game: string, req: { world: string; player: string; preset?: string; signals?: { type: string; data: Record<string, unknown> }[] }): SignalBatchResult {
    const list = [...(req.preset ? (SIM_PRESETS[req.preset]?.signals ?? []) : []), ...(req.signals ?? [])];
    if (req.preset && !SIM_PRESETS[req.preset]) throw new LfError("not_found", `unknown preset "${req.preset}"`, { presets: Object.keys(SIM_PRESETS) });
    if (!list.length) throw new LfError("bad_request", "nothing to simulate");
    const now = Date.now();
    return this.ingestSignals(game, { signals: list.map((s, i) => ({ type: s.type, data: s.data, ts: now + i, world: req.world, player: req.player, session: "simulate" })) });
  }

  // ------------------------------------------------------------------ public config

  publicConfig(game: string) {
    const rt = this.game(game);
    const m = rt.manifest;
    return {
      protocol: PROTOCOL_ID,
      server: { version: "0.1.0", wsPath: "/v1/ws", features: { llm: !!this.providers.llm, stt: !!this.providers.stt, mesh3d: !!this.providers.mesh3d && m.clamps.forge.meshJobs, tts: !!this.providers.tts } },
      game: { id: m.game.id, name: m.game.name },
      modules: Object.fromEntries(this.opts.modules.map((x) => [x.id, moduleEnabled(m, x.id)])),
      personas: m.personas.map((p) => ({ id: p.id, name: p.name, role: p.role, faction: p.faction, voice: p.voice, zone: p.zone })),
      bosses: m.bosses.map((b) => ({ id: b.id, name: b.name, phases: b.phases })),
      actions: Object.keys(m.actions),
      customSignals: Object.keys(m.signals),
      elements: m.elements,
      askKinds: Object.keys(ASKS),
      directiveKinds: [...DIRECTIVE_KINDS],
      moments: [...BUILTIN_MOMENTS, ...Object.keys(m.moments)],
    };
  }
}

// The module plugin interface (K0 contract). Every feature module (observer, persona, world, director, forge,
// quests, or a third-party plugin) is a LiveforgeModule registered in modules/index.ts. See docs/CONTRACTS.md.
import type {
  AskKind, AskParams, AskResult, AskSource, Directive, DirectiveDraft, ForgeJob, LooseDirectiveDraft,
  ProjectionName, ProjectionState, StoredEvent,
} from "@liveforge/protocol";
import type { BrainDraft, BrainEntry } from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";
import type { Hono } from "hono";
import type { Logger } from "./log.js";
import type { KvScope } from "./store/db.js";
import type { EventQuery } from "./store/events.js";
import type { LlmCallOptions, LlmJsonResult, LlmStreamOptions, LlmTextResult, SttProvider, TtsProvider } from "./providers/index.js";
import type { LlmToolsOptions, LlmToolsResult } from "./providers/index.js";
import type { Cache } from "./core/cache.js";
import type { Moderator } from "./core/moderation.js";

// ---------------------------------------------------------------- projections

export interface ProjectionKey {
  game: string;
  world: string;
  /** null for world-scope projections. */
  player: string | null;
}

/**
 * A fold over the event log. MUST be deterministic and side-effect free (no LLM, no Date.now(): use event.ts /
 * event.receivedAt) so the state can always be rebuilt from the log. Anything non-deterministic (an LLM profile,
 * a generated rumour) is first recorded as an event with ctx.record(), then folded here.
 */
export interface Projection<S = unknown> {
  /** "<module>.<thing>"; canonical names + state shapes are in @liveforge/protocol PROJECTIONS. */
  name: string;
  /** player: one state per (game, world, player), events without a player are skipped. world: one per (game, world). */
  scope: "world" | "player";
  /** Bump when apply() semantics change: the server rebuilds from the log on startup. */
  version?: number;
  /** Event types to receive: exact, "ns.*" or "*". Default ["*"]. */
  types?: string[];
  init(key: ProjectionKey, manifest: Manifest): S;
  /** Mutate `state` in place and/or return a new state. */
  apply(state: S, event: StoredEvent, env: { manifest: Manifest; key: ProjectionKey }): S | void;
}

/** Typed projection names. Canonical ones come from the protocol; plugins may augment this interface. */
export type ProjectionTypes = { [N in ProjectionName]: ProjectionState<N> };

export interface ProjectionReader {
  /** Current state (initialised lazily). For player-scope projections pass the player. */
  get<N extends keyof ProjectionTypes>(name: N, scope: { world: string; player?: string | null }): ProjectionTypes[N];
  get<S = unknown>(name: string, scope: { world: string; player?: string | null }): S;
  /** Every player state of a player-scope projection in a world (dashboard, ticks). */
  all<S = unknown>(name: string, world: string): { player: string; state: S }[];
}

// ---------------------------------------------------------------- LLM (budget / metrics aware)

export interface ScopedLlmOptions extends LlmCallOptions {
  /** Metrics / tier-override key, e.g. "npc.reply" or "observer.profile" (manifest models.overrides). */
  task?: string;
  /** Charge this player's budget (asks fill this automatically). */
  player?: string | null;
}

/**
 * ctx.llm: the provider wrapped with tier mapping (manifest + env), budgets (throws BudgetExceededError before the
 * call when over), usage accounting and moderation of nothing (moderate inputs/outputs yourself with ctx.moderation).
 * null when no LLM provider is configured: modules must keep working on rules alone.
 */
export interface ScopedLlm {
  readonly provider: string;
  json<T = unknown>(schema: object, system: string, user: string, opts?: ScopedLlmOptions): Promise<LlmJsonResult<T>>;
  stream(system: string, user: string, opts?: LlmStreamOptions & { task?: string; player?: string | null }): Promise<LlmTextResult>;
  /**
   * One native tool-use call (K6 agents): `{system, messages, tools, tier, maxTokens, timeoutMs, task, player, signal}`
   * -> `{content, stopReason, usage, model, ms}`. Tier mapping, budgets and metrics as json(); no retries. Throws
   * when the provider has no tool use (check `supportsTools`).
   */
  tools(opts: LlmToolsOptions & { task?: string; player?: string | null }): Promise<LlmToolsResult>;
  /** True when the provider implements native tool use. */
  readonly supportsTools: boolean;
}

// ---------------------------------------------------------------- contexts

export interface BudgetView {
  /** ok=false when the game or player is over its tokens/min or $/day budget. */
  check(player?: string | null): { ok: true } | { ok: false; reason: string };
}

export interface JobsApi {
  /**
   * Start a 3D mesh job (Hyper3D) if a mesh provider is keyed AND manifest clamps.forge.meshJobs is true; else null.
   * On completion the GLB is stored, a `forge.ready` directive is pushed to the player, and an "lf.forge.job"
   * event is recorded.
   */
  submitMesh(prompt: string, opts: { world: string; player?: string | null; askId?: string; meta?: Record<string, unknown> }): Promise<ForgeJob | null>;
  get(id: string): ForgeJob | null;
}

export interface ModuleContext {
  readonly game: string;
  /** Validated manifest (replaced on admin reload: read it per call, don't cache across calls). */
  readonly manifest: Manifest;
  /** Calling module id. */
  readonly module: string;
  /** manifest.modules.<id>.options */
  readonly options: Record<string, unknown>;
  readonly log: Logger;
  now(): number;
  /** Read the event log (this game only). */
  events(q: Omit<EventQuery, "game">): StoredEvent[];
  projections: ProjectionReader;
  /** Module-private persistent key-value store (namespace = module id). Not rebuilt from the log. */
  kv: KvScope;
  llm: ScopedLlm | null;
  stt: SttProvider | null;
  tts: TtsProvider | null;
  jobs: JobsApi;
  budgets: BudgetView;
  cache: Cache;
  moderation: Moderator;
  /**
   * Push a directive. Validates kind + args (protocol DIRECTIVE_ARGS; "custom.*" free) and, for npc.action,
   * the action against the manifest action schema + persona allowedActions. Records an "lf.directive" event and
   * pushes it over WS to the world (player: null) or one player. Returns null (and logs) when rejected.
   */
  emit(draft: DirectiveDraft | LooseDirectiveDraft, scope: { world: string; player?: string | null }): Directive | null;
  /** Append an internal event ("lf.<module>.<what>") so projections can fold it. Returns the stored event. */
  record(type: string, data: Record<string, unknown>, scope: { world: string; player?: string | null; session?: string | null }): StoredEvent;
  /**
   * Push a Brain feed entry (agent step, plan, decision) to the world's WS subscribers (`{t:"brain"}`) and the
   * per-world ring buffer behind GET /v1/brain. `model` badge: brainModel(modelId, source) from the protocol.
   */
  brain(entry: BrainDraft, scope: { world: string }): BrainEntry | null;
}

/** A context bound to one world (+ player). emit/record default to this scope. */
export interface ScopedContext extends Omit<ModuleContext, "emit" | "record"> {
  readonly world: string;
  readonly player: string | null;
  readonly session: string | null;
  emit(draft: DirectiveDraft | LooseDirectiveDraft, scope?: { world?: string; player?: string | null }): Directive | null;
  record(type: string, data: Record<string, unknown>, scope?: { world?: string; player?: string | null }): StoredEvent;
  brain(entry: BrainDraft, scope?: { world?: string }): BrainEntry | null;
}

export interface AskContext extends ScopedContext {
  readonly askId: string;
  readonly kind: AskKind;
  /** upgrade(): push a streamed text chunk to the asking client (WS `chunk`); final upgrade follows automatically. */
  chunk(text: string): void;
  /** Aborted when the upgrade times out or the server shuts down. */
  readonly signal: AbortSignal;
}

export interface EventContext extends ScopedContext {
  readonly event: StoredEvent;
}

export interface TickContext extends ScopedContext {
  /** Players seen in this world within the active window. */
  readonly activePlayers: string[];
}

// ---------------------------------------------------------------- module parts

export interface InstantAnswer<K extends AskKind> {
  result: AskResult<K>;
  why?: string;
  /** Default "rules". */
  source?: Exclude<AskSource, "ai">;
  /** true = this answer is final, don't schedule upgrade(). */
  final?: boolean;
}

export interface UpgradeAnswer<K extends AskKind> {
  result: AskResult<K>;
  why?: string;
}

export interface AskHandler<K extends AskKind> {
  /** Fast path (rules / cache / bake). Must answer in milliseconds and never call the LLM. */
  instant(ctx: AskContext, params: AskParams<K>): InstantAnswer<K> | Promise<InstantAnswer<K>>;
  /**
   * AI upgrade, run in the background after the instant answer was sent (only when ctx.llm exists, budgets allow
   * and the client did not opt out). Return null to keep the instant answer. Results are validated against the
   * protocol result schema before being pushed.
   */
  upgrade?(ctx: AskContext, params: AskParams<K>, instant: AskResult<K>): Promise<UpgradeAnswer<K> | null>;
  /**
   * Cache key material for upgraded answers (exact + normalised dedupe). Default: kind + params + player.
   * Return false to disable caching for this call (e.g. conversation replies).
   */
  cacheKey?(params: AskParams<K>, ctx: AskContext): unknown | false;
  /** Seconds an upgraded answer stays in the cache (default 3600). */
  cacheTtlSec?: number;
  /** Upgrade timeout (default: LLM timeout + 2 s). */
  upgradeTimeoutMs?: number;
}

export type AskHandlers = { [K in AskKind]?: AskHandler<K> };

export interface SignalHandler {
  /** Event types (exact, "ns.*", "*"). Internal "lf.*" events are delivered too. */
  types: string[];
  /** Runs after projections applied the event. Async errors are logged, never thrown to the client. */
  handle(ctx: EventContext, event: StoredEvent): void | Promise<void>;
}

export interface Tick {
  name: string;
  everyMs: number;
  /** Runs once per active world of every game that enables the module. */
  run(ctx: TickContext): void | Promise<void>;
}

export interface ModuleRoutes {
  /** Mounted at /v1/m/<module id>/* (SDK key auth; c.get("game") is the game id). */
  public?: Hono<LfEnv>;
  /** Mounted at /admin/m/<module id>/* (admin key auth). */
  admin?: Hono<LfEnv>;
}

export interface LiveforgeModule {
  /** Matches manifest `modules.<id>`. */
  id: string;
  description?: string;
  projections?: Projection<any>[];
  signalHandlers?: SignalHandler[];
  asks?: AskHandlers;
  ticks?: Tick[];
  routes?: ModuleRoutes;
  /** Called once per game when the module is enabled (startup and manifest reload). */
  init?(ctx: ModuleContext): void | Promise<void>;
}

/** Helper for type inference: `export default defineModule({ ... })`. */
export const defineModule = <M extends LiveforgeModule>(m: M): M => m;

/** Hono env shared by core + module routes. */
export interface LfEnv {
  Variables: {
    game: string;
    admin: boolean;
    key: string;
  };
}

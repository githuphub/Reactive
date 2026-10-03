// HTTP API shapes not covered by signals / asks: errors, STT, snapshots, forge jobs, public config, admin.
import { z } from "zod";
import { Bag, Id, Timestamp } from "./common.js";
import { StoredEvent } from "./state.js";
import { VoiceStyle } from "./content.js";

export const ERROR_CODES = [
  "bad_request", "unauthorized", "forbidden", "not_found", "rate_limited", "budget_exceeded", "moderated",
  "invalid_manifest", "unknown_kind", "module_disabled", "provider_unavailable", "provider_error", "timeout", "internal",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Every non-2xx response body. */
export const ErrorBody = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/** POST /v1/stt (multipart field "audio", or raw body with an audio/* content-type). Query: ?language=en&provider=openai|whispercpp */
export const SttResponse = z.object({
  id: z.string(),
  text: z.string(),
  language: z.string().optional(),
  durationMs: z.number().optional(),
  provider: z.string(),
  /** Moderation verdict on the transcript (the text is still returned; npc.reply re-checks). */
  flagged: z.boolean().optional(),
});
export type SttResponse = z.infer<typeof SttResponse>;

export const FORGE_JOB_STATES = ["queued", "generating", "done", "failed"] as const;
/** GET /v1/forge/jobs/:id */
export const ForgeJob = z.object({
  id: z.string(),
  provider: z.string(),
  state: z.enum(FORGE_JOB_STATES),
  prompt: z.string(),
  /** Server-relative GLB url once done (GET /v1/assets/:file). */
  url: z.string().optional(),
  error: z.string().optional(),
  askId: z.string().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ForgeJob = z.infer<typeof ForgeJob>;

/** GET /v1/snapshot?world=&player= / POST /v1/snapshot (import replaces the world's events, then rebuilds). */
export const Snapshot = z.object({
  protocol: z.literal("liveforge-protocol/1"),
  game: z.string(),
  world: z.string(),
  exportedAt: Timestamp,
  /** Highest seq included. */
  upToSeq: z.number().int(),
  events: z.array(StoredEvent),
  /** projection name -> { world?: state, players?: { [player]: state } } (informational; import rebuilds from events). */
  projections: z.record(z.string(), z.object({ world: z.unknown().optional(), players: z.record(z.string(), z.unknown()).optional() })),
});
export type Snapshot = z.infer<typeof Snapshot>;

export const SnapshotImportResult = z.object({ world: z.string(), events: z.number().int(), rebuilt: z.array(z.string()) });
export type SnapshotImportResult = z.infer<typeof SnapshotImportResult>;

/** GET /v1/config: the public slice of the manifest an SDK / engine addon needs. */
export const PublicConfig = z.object({
  protocol: z.string(),
  server: z.object({ version: z.string(), wsPath: z.string(), features: z.record(z.string(), z.boolean()) }),
  game: z.object({ id: z.string(), name: z.string() }),
  modules: z.record(z.string(), z.boolean()),
  personas: z.array(z.object({ id: z.string(), name: z.string(), role: z.string(), faction: z.string().optional(), voice: VoiceStyle.optional(), zone: z.string().optional() })),
  bosses: z.array(z.object({ id: z.string(), name: z.string(), phases: z.number().int() })),
  actions: z.array(z.string()),
  customSignals: z.array(z.string()),
  elements: z.array(z.string()),
  askKinds: z.array(z.string()),
  directiveKinds: z.array(z.string()),
});
export type PublicConfig = z.infer<typeof PublicConfig>;

/** GET /admin/events?world=&player=&after=&limit=&type= */
export const EventPage = z.object({ events: z.array(StoredEvent), next: z.number().int().nullable() });
export type EventPage = z.infer<typeof EventPage>;

/** GET /admin/stats: cost / latency / cache meters per module (dashboard). */
export const ModuleStats = z.object({
  asks: z.number().int(),
  upgrades: z.number().int(),
  cacheHits: z.number().int(),
  errors: z.number().int(),
  /** p50 / p95 ms of instant answers and of upgrades. */
  instantMs: z.object({ p50: z.number(), p95: z.number() }),
  upgradeMs: z.object({ p50: z.number(), p95: z.number() }),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  usd: z.number(),
});
export type ModuleStats = z.infer<typeof ModuleStats>;

export const StatsResponse = z.object({
  game: z.string(),
  since: Timestamp,
  modules: z.record(z.string(), ModuleStats),
  budgets: z.object({
    game: z.object({ tokensLastMin: z.number(), tokensPerMin: z.number(), usdToday: z.number(), usdPerDay: z.number() }),
  }),
  cache: z.object({ entries: z.number().int(), hits: z.number().int(), misses: z.number().int() }),
  ws: z.object({ connections: z.number().int() }),
});
export type StatsResponse = z.infer<typeof StatsResponse>;

/** POST /admin/simulate: fire a preset or explicit signals as a (fake) player. */
export const SimulateRequest = z.object({
  world: Id,
  player: Id,
  preset: z.string().optional(),
  signals: z.array(z.object({ type: z.string(), data: Bag.default({}) })).optional(),
});
export type SimulateRequest = z.infer<typeof SimulateRequest>;

/** Review / bake queue item (forge bake mode; dashboard approves). */
export const ReviewItem = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  payload: z.unknown(),
  note: z.string().optional(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ReviewItem = z.infer<typeof ReviewItem>;

/** Bake pack file (exported from approved review items; SDKs load it offline). */
export const BakePack = z.object({
  protocol: z.literal("liveforge-protocol/1"),
  game: z.string(),
  createdAt: Timestamp,
  /** ask kind -> list of {key, result}; SDK fallback picks by key or at random. */
  entries: z.record(z.string(), z.array(z.object({ key: z.string(), result: z.unknown(), tags: z.array(z.string()).optional() }))),
});
export type BakePack = z.infer<typeof BakePack>;

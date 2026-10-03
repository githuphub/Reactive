// Projection state shapes (read by the dashboard via /admin/projections and exported in snapshots).
// Owner lanes may ADD optional fields; renaming / removing fields is a protocol change.
import { ReactionLedger } from "./reactions.js";
import { FactionMindState } from "./factions.js";
import { z } from "zod";
import { Bag, Timestamp, Unit } from "./common.js";
import { Achievement, Moment, Quest, Rumour } from "./content.js";
import { MoveSpec } from "./moves.js";

/** Stored event (the log row). Signals are events with origin "sdk"; modules record internal "lf.*" events. */
export const StoredEvent = z.object({
  seq: z.number().int(),
  game: z.string(),
  world: z.string(),
  player: z.string().nullable(),
  session: z.string().nullable(),
  type: z.string(),
  data: Bag,
  /** Client time for signals, server time otherwise. */
  ts: Timestamp,
  /** Server receive time. */
  receivedAt: Timestamp,
  origin: z.enum(["sdk", "module", "admin", "import"]),
});
export type StoredEvent = z.infer<typeof StoredEvent>;

export const TraitScore = z.object({
  /** 0-1 */
  score: Unit,
  /** Latest human-readable evidence, newest first (<= 5). */
  evidence: z.array(z.string()).default([]),
  updatedAt: Timestamp,
  /** true for manifest (designer DSL) traits. */
  designer: z.boolean().optional(),
});
export type TraitScore = z.infer<typeof TraitScore>;

/** Projection "observer.player_model" (scope player) - owner K1. */
export const PlayerModel = z.object({
  player: z.string(),
  traits: z.record(z.string(), TraitScore).default({}),
  /** Recent moments, newest first (<= 50). */
  moments: z.array(Moment).default([]),
  /** LLM narrative (2-3 sentences, rich tier), refreshed every N events. */
  profile: z.object({ text: z.string(), updatedAt: Timestamp, eventCount: z.number().int() }).nullable().default(null),
  /** Cheap running counters (gold, kills, deaths, zone ...) for rules + DSL. */
  stats: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
  eventCount: z.number().int().default(0),
  lastSeen: Timestamp.optional(),
  /** Observer-private accumulators behind the built-in trait scores (decayed counters, seen sets). Shape may change. */
  acc: z.record(z.string(), z.unknown()).optional(),
});
export type PlayerModel = z.infer<typeof PlayerModel>;

export const MemoryEntry = z.object({
  text: z.string().max(300),
  /** 0-1; decays over time, sharpens when recalled. */
  salience: Unit,
  ts: Timestamp,
  kind: z.enum(["conversation", "witnessed", "rumour", "gift", "harm", "trade", "other"]).default("other"),
  /** Optional reference (ask id, moment id, rumour id) so a later event can replace / sharpen this entry. */
  ref: z.string().max(64).optional(),
});
export type MemoryEntry = z.infer<typeof MemoryEntry>;

/** One NPC's memory of one player. */
export const NpcMemory = z.object({
  npc: z.string(),
  player: z.string(),
  /** -1..1 */
  attitude: z.number().min(-1).max(1).default(0),
  entries: z.array(MemoryEntry).default([]),
  /** Rolling summary of older interactions. */
  summary: z.string().default(""),
  lastTalked: Timestamp.optional(),
});
export type NpcMemory = z.infer<typeof NpcMemory>;

/** Projection "persona.memories" (scope player) - owner K1. npc id -> memory. */
export const PersonaMemories = z.object({ npcs: z.record(z.string(), NpcMemory).default({}) });
export type PersonaMemories = z.infer<typeof PersonaMemories>;

/** Projection "world.rumours" (scope world) - owner K2. */
export const RumourState = z.object({
  rumours: z.array(Rumour).default([]),
  /** Spread edges for the dashboard graph: who told whom. */
  spread: z.array(z.object({ rumourId: z.string(), from: z.string(), to: z.string(), ts: Timestamp })).default([]),
});
export type RumourState = z.infer<typeof RumourState>;

/** Projection "world.factions" (scope world) - owner K2. */
export const FactionState = z.object({
  /** faction id -> player id -> reputation -1..1 */
  reputation: z.record(z.string(), z.record(z.string(), z.number())).default({}),
  /** npc pair relationships as they evolved (seeded from the manifest). */
  relationships: z.array(z.object({ a: z.string(), b: z.string(), kind: z.string(), strength: z.number() })).default([]),
});
export type FactionState = z.infer<typeof FactionState>;

export const DirectorDecision = z.object({
  ts: Timestamp,
  /** "boss_phase" | "boss_move" | "encounter" | "pacing" | "difficulty" ... */
  kind: z.string(),
  summary: z.string().max(200),
  why: z.string().max(300),
  source: z.enum(["rules", "cache", "ai", "bake"]),
  data: Bag.optional(),
});
export type DirectorDecision = z.infer<typeof DirectorDecision>;

/** Projection "director.state" (scope world) - owner K3. */
export const DirectorState = z.object({
  aggression: Unit.default(0.5),
  difficultyMode: z.enum(["hidden", "assist", "off"]).default("hidden"),
  /** Tension samples for the curve, newest last (<= 200). */
  tension: z.array(z.object({ ts: Timestamp, value: Unit })).default([]),
  /** boss id -> invented moves currently in rotation. */
  bosses: z.record(z.string(), z.object({ phase: z.number().int(), invented: z.array(MoveSpec), attune: z.string().nullable() })).default({}),
  /** Decision timeline, newest last (<= 200). */
  timeline: z.array(DirectorDecision).default([]),
});
export type DirectorState = z.infer<typeof DirectorState>;

/** Projection "quests.log" (scope player) - owner K2. */
export const QuestLog = z.object({
  offered: z.array(Quest).default([]),
  active: z.array(z.object({ quest: Quest, acceptedAt: Timestamp, progress: z.record(z.string(), z.number()).default({}) })).default([]),
  completed: z.array(z.object({ questId: z.string(), title: z.string(), at: Timestamp })).default([]),
  failed: z.array(z.object({ questId: z.string(), title: z.string(), at: Timestamp })).default([]),
  achievements: z.array(Achievement).default([]),
});
export type QuestLog = z.infer<typeof QuestLog>;

export const GalleryEntry = z.object({
  id: z.string(),
  askKind: z.string(),
  ts: Timestamp,
  player: z.string().nullable(),
  source: z.enum(["rules", "cache", "ai", "bake"]),
  /** forge result payload (ForgedItem / Creature / Prop / Variant / VfxRecipe ...). */
  result: z.unknown(),
  review: z.enum(["none", "pending", "approved", "rejected"]).default("none"),
});
export type GalleryEntry = z.infer<typeof GalleryEntry>;

/** Projection "forge.gallery" (scope world) - owner K3. */
export const ForgeGallery = z.object({ entries: z.array(GalleryEntry).default([]) });
export type ForgeGallery = z.infer<typeof ForgeGallery>;

/** Projection "core.directives" (scope world) - owner K0: the last 200 directives emitted. */
export const DirectiveLog = z.object({
  directives: z.array(z.object({ id: z.string(), kind: z.string(), target: z.string(), why: z.string(), ts: Timestamp, player: z.string().nullable(), source: z.string().optional() })).default([]),
});
export type DirectiveLog = z.infer<typeof DirectiveLog>;

/** Canonical projection names -> state schema. Dashboard / snapshot consumers rely on these names. */
export const PROJECTIONS = {
  "observer.player_model": { scope: "player", owner: "K1 observer", schema: PlayerModel },
  "persona.memories": { scope: "player", owner: "K1 persona", schema: PersonaMemories },
  "world.rumours": { scope: "world", owner: "K2 world", schema: RumourState },
  "world.factions": { scope: "world", owner: "K2 world", schema: FactionState },
  "quests.log": { scope: "player", owner: "K2 quests", schema: QuestLog },
  "director.state": { scope: "world", owner: "K3 director", schema: DirectorState },
  "forge.gallery": { scope: "world", owner: "K3 forge", schema: ForgeGallery },
  "core.directives": { scope: "world", owner: "K0 core", schema: DirectiveLog },
  "world.reaction_ledger": { scope: "player", owner: "R1 world reactions-lib", schema: ReactionLedger },
  "factions.mind": { scope: "world", owner: "K7 factions", schema: FactionMindState },
} as const;
export type ProjectionName = keyof typeof PROJECTIONS;
export type ProjectionState<N extends ProjectionName> = z.infer<(typeof PROJECTIONS)[N]["schema"]>;

// Factions "village mind" (K7): projection state `factions.mind`, the `faction.raid_plan` ask shapes, the custom
// directive args the module pushes (`custom.faction_posture`, `custom.guard_posts`) and pure helpers (clamp + JSON
// Schemas for the LLM, a default raid plan) that any SDK can reuse.
import { z } from "zod";
import { Id, Timestamp, cleanText, clampNum, isObj, oneOf } from "./common.js";

// ------------------------------------------------------------------ vocab

/** Village posture: how the faction treats outsiders right now. */
export const FACTION_POSTURES = ["calm", "wary", "hostile", "festive"] as const;
export type FactionPosture = (typeof FACTION_POSTURES)[number];

/** Where a raid wave enters. */
export const RAID_SPAWNS = ["edge", "underground", "behind_player", "rooftops"] as const;
export type RaidSpawn = (typeof RAID_SPAWNS)[number];

export const RAID_SIZES = ["small", "medium", "large"] as const;
export type RaidSize = (typeof RAID_SIZES)[number];

/** Mob ids a raid may use when the manifest declares none (`factions[].raid.mobs`). */
export const DEFAULT_RAID_MOBS = ["zombie", "skeleton", "creeper", "spider"] as const;

/** Hard limits per raid size (waves, mobs per wave, mobs in total). */
export const RAID_SIZE_LIMITS: Record<RaidSize, { waves: number; perWave: number; total: number }> = {
  small: { waves: 2, perWave: 4, total: 6 },
  medium: { waves: 3, perWave: 6, total: 12 },
  large: { waves: 4, perWave: 8, total: 20 },
};

// ------------------------------------------------------------------ projection "factions.mind" (world scope)

export const GuardPost = z.object({
  /** Persona id of the guard (or golem). */
  npc: z.string().max(64),
  /** Post id the game maps to a place: "gate", "square", "well", "home:<npc>" (that NPC's house) ... */
  post: z.string().max(64),
});
export type GuardPost = z.infer<typeof GuardPost>;

export const FactionThreat = z.object({
  /** killer | thief | vandal | threat | raid | <game-reported kind> */
  kind: z.string().max(32),
  /** Who / what: a player id, a mob id ... */
  source: z.string().max(64),
  /** 0-1 at the time it was folded (the module decays it by age). */
  level: z.number().min(0).max(1),
  ts: Timestamp,
  note: z.string().max(160).optional(),
});
export type FactionThreat = z.infer<typeof FactionThreat>;

export const FactionDamage = z.object({
  count: z.number().int().nonnegative().default(0),
  /** Rough total worth (gold) of everything damaged. */
  value: z.number().nonnegative().default(0),
  /** Newest last (<= 12). */
  recent: z.array(z.object({
    ts: Timestamp,
    player: z.string().nullable(),
    object: z.string().max(64),
    owner: z.string().max(64).optional(),
    value: z.number().optional(),
  })).default([]),
});
export type FactionDamage = z.infer<typeof FactionDamage>;

/** The last council decision or raid plan (what the dashboard and Brain View show). */
export const FactionPlan = z.object({
  ts: Timestamp,
  kind: z.enum(["council", "raid"]),
  summary: z.string().max(200),
  why: z.string().max(300),
  /** rules | ai | replay | cache */
  source: z.string().max(16),
  model: z.string().max(64).optional(),
  posture: z.enum(FACTION_POSTURES).optional(),
  priceMult: z.number().optional(),
  announcement: z.string().max(200).optional(),
});
export type FactionPlan = z.infer<typeof FactionPlan>;

export const RaidRecord = z.object({
  ts: Timestamp,
  player: z.string().nullable(),
  night: z.number().int().optional(),
  size: z.enum(RAID_SIZES),
  waves: z.array(z.object({ mob: z.string(), count: z.number().int(), tactic: z.string(), spawn: z.enum(RAID_SPAWNS) })),
  counters: z.array(z.object({ habit: z.string(), tactic: z.string(), why: z.string() })).default([]),
  captain: z.object({ name: z.string(), taunt: z.string() }).optional(),
  why: z.string().max(300),
  source: z.string().max(16),
});
export type RaidRecord = z.infer<typeof RaidRecord>;

/** One village's mind. */
export const FactionMind = z.object({
  faction: z.string(),
  posture: z.enum(FACTION_POSTURES).default("calm"),
  /** Village-wide price multiplier (already clamped to the faction priceRange + clamps.npc.priceMultiplier). */
  priceMult: z.number().default(1),
  /** player id -> trust -1..1 (mirrors world.factions reputation for this faction). */
  trust: z.record(z.string(), z.number().min(-1).max(1)).default({}),
  damage: FactionDamage.prefault({}),
  /** Newest last (<= 10). */
  threats: z.array(FactionThreat).default([]),
  guards: z.array(GuardPost).default([]),
  lastPlan: FactionPlan.optional(),
  /** -1 grim .. +1 jubilant (decays toward 0, half-life 10 min). */
  mood: z.number().min(-1).max(1).default(0),
  moodTs: Timestamp.default(0),
  /** Rumours about players that reached the village: count + summed sentiment. */
  rumours: z.object({ count: z.number().int().default(0), sentiment: z.number().default(0) }).prefault({}),
  /** player id -> last time the player did something the village noticed. */
  seen: z.record(z.string(), Timestamp).default({}),
  /** World clock (from world.time): "dawn" | "day" | "dusk" | "night". */
  phase: z.string().max(16).optional(),
  day: z.number().int().optional(),
  postureSince: Timestamp.default(0),
  /** Posture changes, newest last (<= 30). */
  history: z.array(z.object({ ts: Timestamp, posture: z.enum(FACTION_POSTURES), priceMult: z.number(), why: z.string().max(300), source: z.string().max(16) })).default([]),
  /** Raid plans, newest last (<= 10). */
  raids: z.array(RaidRecord).default([]),
});
export type FactionMind = z.infer<typeof FactionMind>;

/** Projection "factions.mind" (scope world) - owner K7 factions. faction id -> mind. */
export const FactionMindState = z.object({ factions: z.record(z.string(), FactionMind).default({}) });
export type FactionMindState = z.infer<typeof FactionMindState>;

// ------------------------------------------------------------------ ask "faction.raid_plan"

export const RaidWave = z.object({
  /** Mob id from the faction's raid.mobs (default zombie / skeleton / creeper / spider). */
  mob: z.string().min(1).max(32),
  count: z.number().int().min(1).max(20),
  /** Short tactic id the game's spawner / mob AI understands: climb, crossfire, shield_rush, tunnel, keep_distance ... */
  tactic: z.string().min(1).max(40),
  spawn: z.enum(RAID_SPAWNS),
  /** Seconds after the raid starts (optional; waves without it come one after another). */
  delaySec: z.number().min(0).max(600).optional(),
});
export type RaidWave = z.infer<typeof RaidWave>;

export const RaidCounter = z.object({
  /** The play-style habit being punished: pillaring, bow_heavy, hiding, melee_heavy, kiting, fire ... */
  habit: z.string().max(32),
  tactic: z.string().max(40),
  why: z.string().max(200),
});
export type RaidCounter = z.infer<typeof RaidCounter>;

export const RaidPlanParams = z.object({
  /** Faction whose raid config (mobs) to use. Default: the first faction with a raid block, else the first faction. */
  faction: z.string().max(64).optional(),
  /** Player to read habits from (default: the asking player). */
  player: Id.optional(),
  /** Night counter (raids grow a little each night). */
  night: z.number().int().min(0).max(9999).optional(),
  /** Default: the faction's raid.size, else medium. */
  size: z.enum(RAID_SIZES).optional(),
});
export type RaidPlanParams = z.infer<typeof RaidPlanParams>;

export const RaidPlanResult = z.object({
  waves: z.array(RaidWave).min(1).max(8),
  captain: z.object({ name: z.string().max(48), taunt: z.string().max(200) }).optional(),
  counters: z.array(RaidCounter).max(6).default([]),
  why: z.string().max(300),
  faction: z.string().max(64).optional(),
  night: z.number().int().optional(),
  size: z.enum(RAID_SIZES).optional(),
  /** Director aggression (0-1) the plan was scaled with. */
  aggression: z.number().min(0).max(1).optional(),
  /** Habits read from the player, strongest first. */
  habits: z.array(z.object({ habit: z.string().max(32), score: z.number().min(0).max(1), evidence: z.string().max(120) })).max(6).optional(),
});
export type RaidPlanResult = z.infer<typeof RaidPlanResult>;

// ------------------------------------------------------------------ custom directives the module pushes

/** `custom.faction_posture` (target "world"): the village changed posture / prices. */
export const FactionPostureArgs = z.object({
  faction: z.string(),
  posture: z.enum(FACTION_POSTURES),
  priceMult: z.number(),
  announcement: z.string().max(200),
  previous: z.enum(FACTION_POSTURES).optional(),
});
export type FactionPostureArgs = z.infer<typeof FactionPostureArgs>;

/** `custom.guard_posts` (target "world"): where each guard should stand. */
export const GuardPostsArgs = z.object({ faction: z.string(), posts: z.array(GuardPost) });
export type GuardPostsArgs = z.infer<typeof GuardPostsArgs>;

// ------------------------------------------------------------------ helpers (pure)

/** A plain mixed raid (used when nothing is known about the player). */
export function defaultRaidPlan(mobs: readonly string[] = DEFAULT_RAID_MOBS, size: RaidSize = "medium"): RaidPlanResult {
  const has = (m: string) => mobs.includes(m);
  const first = mobs[0] ?? "zombie";
  const lim = RAID_SIZE_LIMITS[size];
  const base = Math.max(1, Math.floor(lim.total / 3));
  const all: RaidWave[] = [
    { mob: has("zombie") ? "zombie" : first, count: Math.min(lim.perWave, base + 1), tactic: "rush", spawn: "edge" },
    { mob: has("skeleton") ? "skeleton" : first, count: Math.min(lim.perWave, base), tactic: "spread_out", spawn: "rooftops" },
    { mob: has("spider") ? "spider" : first, count: Math.min(lim.perWave, Math.max(1, base - 1)), tactic: "flank", spawn: "edge" },
  ];
  const waves = all.slice(0, lim.waves);
  return { waves, counters: [], why: "nothing known about the player yet: a mixed wave", size };
}

/**
 * Clamp an untrusted raid plan (LLM output): known mob ids only (unknown ones map to the closest by name, else the
 * first), counts within the size limits, spawn points from RAID_SPAWNS, text cleaned. Returns null when nothing usable.
 */
export function clampRaidPlan(raw: unknown, opts: { mobs?: readonly string[]; size?: RaidSize } = {}): RaidPlanResult | null {
  if (!isObj(raw)) return null;
  const mobs = opts.mobs?.length ? opts.mobs : DEFAULT_RAID_MOBS;
  const size = opts.size ?? oneOf(RAID_SIZES, raw.size) ?? "medium";
  const lim = RAID_SIZE_LIMITS[size];
  const mapMob = (v: unknown): string => {
    const s = typeof v === "string" ? v.toLowerCase().trim().replace(/\s+/g, "_") : "";
    if (mobs.includes(s)) return s;
    return mobs.find((m) => s && (s.includes(m) || m.includes(s))) ?? mobs[0];
  };
  const waves: RaidWave[] = [];
  let total = 0;
  for (const w of Array.isArray(raw.waves) ? raw.waves : []) {
    if (!isObj(w) || waves.length >= lim.waves || total >= lim.total) continue;
    const count = Math.min(lim.perWave, lim.total - total, Math.round(clampNum(w.count, 1, 20, 2)));
    if (count < 1) continue;
    const tactic = (cleanText(w.tactic, 40).toLowerCase().replace(/[^a-z0-9_ -]/g, "").replace(/[ -]+/g, "_") || "rush").slice(0, 40);
    const wave: RaidWave = { mob: mapMob(w.mob), count, tactic, spawn: oneOf(RAID_SPAWNS, w.spawn) ?? "edge" };
    if (typeof w.delaySec === "number" && Number.isFinite(w.delaySec)) wave.delaySec = clampNum(w.delaySec, 0, 600, 0);
    waves.push(wave);
    total += count;
  }
  if (!waves.length) return null;
  const counters: RaidCounter[] = [];
  for (const c of Array.isArray(raw.counters) ? raw.counters : []) {
    if (!isObj(c) || counters.length >= 6) continue;
    const habit = cleanText(c.habit, 32);
    const tactic = cleanText(c.tactic, 40);
    if (habit && tactic) counters.push({ habit, tactic, why: cleanText(c.why, 200) || `${tactic} counters ${habit}` });
  }
  const out: RaidPlanResult = { waves, counters, why: cleanText(raw.why, 300) || "raid plan", size };
  if (isObj(raw.captain)) {
    const name = cleanText(raw.captain.name, 48);
    const taunt = cleanText(raw.captain.taunt, 200);
    if (name && taunt) out.captain = { name, taunt };
  }
  return out;
}

/** JSON Schema (Anthropic structured-output subset) for a raid plan restricted to `mobs`. */
export function raidPlanJsonSchema(mobs: readonly string[] = DEFAULT_RAID_MOBS): object {
  return {
    type: "object",
    additionalProperties: false,
    required: ["waves", "captain", "counters", "why"],
    properties: {
      waves: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["mob", "count", "tactic", "spawn"],
          properties: {
            mob: { type: "string", enum: [...mobs] },
            count: { type: "integer" },
            tactic: { type: "string" },
            spawn: { type: "string", enum: [...RAID_SPAWNS] },
          },
        },
      },
      captain: {
        type: "object",
        additionalProperties: false,
        required: ["name", "taunt"],
        properties: { name: { type: "string" }, taunt: { type: "string" } },
      },
      counters: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["habit", "tactic", "why"],
          properties: { habit: { type: "string" }, tactic: { type: "string" }, why: { type: "string" } },
        },
      },
      why: { type: "string" },
    },
  };
}

/** A council decision as the LLM returns it (clamp with the module before use). */
export interface CouncilDecision {
  posture: FactionPosture;
  priceMult: number;
  guardPosts: GuardPost[];
  announcement: string;
  why: string;
}

/** JSON Schema for the village council decision (posture, prices, guard posts, announcement, why). */
export function councilJsonSchema(guards: readonly string[], posts: readonly string[]): object {
  return {
    type: "object",
    additionalProperties: false,
    required: ["announcement", "posture", "priceMult", "guardPosts", "why"],
    properties: {
      announcement: { type: "string" },
      posture: { type: "string", enum: [...FACTION_POSTURES] },
      priceMult: { type: "number" },
      guardPosts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["npc", "post"],
          properties: {
            npc: guards.length ? { type: "string", enum: [...guards] } : { type: "string" },
            post: posts.length ? { type: "string", enum: [...posts] } : { type: "string" },
          },
        },
      },
      why: { type: "string" },
    },
  };
}

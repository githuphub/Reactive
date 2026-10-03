// Asks (spec §2.2): request -> instant answer {stage:"instant"} now, optional AI upgrade {stage:"upgrade"} later
// over WebSocket (or long-poll GET /v1/upgrades/:id). Params + result schemas per kind.
import { z } from "zod";
import { Bag, Id, Timestamp, Unit } from "./common.js";
import { Achievement, ForgedItem, NpcAction, Quest, Rumour, VoiceStyle } from "./content.js";
import { Blueprint } from "./blueprint.js";
import { VfxRecipe } from "./vfx.js";
import { Variant } from "./variant.js";
import { EngineMoveRef, MoveSpec } from "./moves.js";
import { DirectiveDraftSchema } from "./directives.js";
import { PlayerModel } from "./state.js";
import { RaidPlanParams, RaidPlanResult } from "./factions.js";

/** Free-form habits bag (keys of MoveHabits in moves.ts, or game-specific numbers). Cleaned with cleanHabits. */
const Habits = z.record(z.string(), z.unknown());
const Seed = z.number().int().optional();

/** One boss move in a phase plan: an engine-native move, an invented grammar move, or both. */
export const BossMovePlan = z.object({
  engine: EngineMoveRef.optional(),
  grammar: MoveSpec.optional(),
  /** Relative selection weight 0-1. */
  weight: z.number().min(0).max(1),
});
export type BossMovePlan = z.infer<typeof BossMovePlan>;

export const Creature = z.object({
  id: Id,
  name: z.string().max(64),
  flavor: z.string().max(240),
  role: z.enum(["minion", "elite", "boss", "critter", "mount", "summon"]),
  blueprint: Blueprint,
  stats: z.record(z.string(), z.number()),
  /** Behaviour id the game implements (charge, orbit, turret, kite, guard ...). */
  behaviour: z.string().max(32),
  tags: z.array(z.string()).default([]),
  vfx: VfxRecipe.optional(),
  mesh: z.object({ jobId: z.string(), state: z.enum(["queued", "generating", "done", "failed"]), url: z.string().optional() }).optional(),
});
export type Creature = z.infer<typeof Creature>;

export const Prop = z.object({
  id: Id,
  name: z.string().max(64),
  blueprint: Blueprint,
  tags: z.array(z.string()).default([]),
  interactable: z.boolean().optional(),
  vfx: VfxRecipe.optional(),
});
export type Prop = z.infer<typeof Prop>;

/** Per-kind params + result schemas. */
export const ASKS = {
  "npc.bark": {
    params: z.object({
      npc: z.string(),
      /** What prompted it: approach, idle, combat, gear, moment, rumour, greeting, farewell, or a custom string. */
      trigger: z.string().max(32).default("idle"),
      context: Bag.optional(),
    }),
    result: z.object({
      npc: z.string(),
      text: z.string().max(300),
      emote: z.string().max(32).optional(),
      voice: VoiceStyle.optional(),
      actions: z.array(NpcAction).default([]),
    }),
  },
  "npc.reply": {
    params: z.object({
      npc: z.string(),
      /** What the player said (typed, or the text from POST /v1/stt). */
      text: z.string().min(1).max(1000),
      /** Recent turns the client still has on screen (the server also keeps memory). */
      history: z.array(z.object({ role: z.enum(["player", "npc"]), text: z.string().max(1000) })).max(20).optional(),
      /** true = stream the upgrade as `chunk` messages (sentence by sentence) before the final `upgrade`. */
      stream: z.boolean().optional(),
      context: Bag.optional(),
    }),
    result: z.object({
      npc: z.string(),
      text: z.string().max(1200),
      emote: z.string().max(32).optional(),
      voice: VoiceStyle.optional(),
      /** Validated against persona allowedActions + manifest action schema. */
      actions: z.array(NpcAction).default([]),
      /** -1..1 attitude change toward the player this turn. */
      mood: z.number().min(-1).max(1).optional(),
      /** NPC ends the conversation. */
      end: z.boolean().optional(),
    }),
  },
  "director.boss_phase": {
    params: z.object({
      boss: z.string(),
      phase: z.number().int().min(1).max(9),
      /** Boss HP fraction 0-1. */
      hp: Unit.optional(),
      habits: Habits.optional(),
      /** Tags of the player's current gear (counters target these). */
      gear: z.array(z.string()).optional(),
      /** Move names / engine ids already in the rotation. */
      existing: z.array(z.string()).optional(),
      seed: Seed,
    }),
    result: z.object({
      boss: z.string(),
      phase: z.number().int(),
      moves: z.array(BossMovePlan),
      aggression: Unit,
      /** Gear tags / habits this phase counters. */
      counters: z.array(z.string()).default([]),
      attune: z.string().nullable().optional(),
      taunt: z.string().max(200).optional(),
    }),
  },
  "director.boss_move": {
    params: z.object({
      boss: z.string(),
      phase: z.number().int().min(1).max(9),
      habits: Habits.optional(),
      existing: z.array(z.string()).optional(),
      attune: z.string().nullable().optional(),
      seed: Seed,
    }),
    result: z.object({ boss: z.string(), move: MoveSpec, engineMove: EngineMoveRef.optional() }),
  },
  "director.encounter": {
    params: z.object({
      encounter: z.string().optional(),
      zone: z.string().optional(),
      units: z.array(z.object({ id: z.string(), type: z.string(), elite: z.boolean().optional(), modifiers: z.array(z.string()).optional() })).min(1).max(64),
      habits: Habits.optional(),
      seed: Seed,
    }),
    result: z.object({
      /** Tactics: flank, kite, ambush, shield_wall, focus_healer, rush, hold, surround, retreat. */
      assignments: z.array(z.object({ unit: z.string(), tactic: z.string().max(32), target: z.string().optional() })),
      /** Elite modifiers chosen to counter the player. */
      modifiers: z.array(z.string()).default([]),
      aggression: Unit,
    }),
  },
  "director.pacing": {
    params: z.object({
      zone: z.string().optional(),
      /** Game-measured intensity 0-1 (else derived from recent combat signals). */
      intensity: Unit.optional(),
      enemiesAlive: z.number().int().min(0).optional(),
      playerHp: Unit.optional(),
      sinceLastBreatherSec: z.number().min(0).optional(),
    }),
    result: z.object({
      tension: Unit,
      action: z.enum(["spawn", "breather", "loot", "hold", "escalate"]),
      /** Directives the game should apply now (also pushed over WS). */
      directives: z.array(DirectiveDraftSchema).default([]),
      aggression: Unit.optional(),
    }),
  },
  "forge.item": {
    params: z.object({
      prompt: z.string().max(400).optional(),
      family: z.string().optional(),
      slot: z.string().optional(),
      element: z.string().optional(),
      /** Also start a 3D mesh job (Hyper3D) if enabled + keyed. */
      mesh: z.boolean().optional(),
      context: Bag.optional(),
      seed: Seed,
    }),
    result: z.object({ item: ForgedItem }),
  },
  "forge.armour_set": {
    params: z.object({ prompt: z.string().max(400), slots: z.array(z.string()).max(8).optional(), mesh: z.boolean().optional(), seed: Seed }),
    result: z.object({
      name: z.string().max(64),
      pieces: z.array(ForgedItem).min(1),
      setBonus: z.object({ description: z.string().max(200), stats: z.record(z.string(), z.number()) }).optional(),
    }),
  },
  "forge.look": {
    params: z.object({ prompt: z.string().max(400), asset: z.string(), slots: z.array(z.string()).optional(), seed: Seed }),
    result: z.object({ variant: Variant }),
  },
  "forge.vfx": {
    params: z.object({ prompt: z.string().max(400), attach: z.string().optional(), durationSec: z.number().positive().optional(), seed: Seed }),
    result: z.object({ vfx: VfxRecipe }),
  },
  "forge.creature": {
    params: z.object({ prompt: z.string().max(400), role: z.enum(["minion", "elite", "boss", "critter", "mount", "summon"]).optional(), mesh: z.boolean().optional(), seed: Seed }),
    result: z.object({ creature: Creature }),
  },
  "forge.npc_look": {
    params: z.object({ npc: z.string(), prompt: z.string().max(400), asset: z.string().optional(), seed: Seed }),
    result: z.object({ npc: z.string(), variant: Variant.optional(), accessories: z.array(Blueprint).default([]) }),
  },
  "forge.prop": {
    params: z.object({ prompt: z.string().max(400), mesh: z.boolean().optional(), seed: Seed }),
    result: z.object({ prop: Prop }),
  },
  "forge.loot": {
    params: z.object({
      count: z.number().int().min(1).max(5).default(1),
      /** What was defeated / where (loot is themed on the fight). */
      enemy: z.string().optional(),
      zone: z.string().optional(),
      moment: z.string().optional(),
      seed: Seed,
    }),
    result: z.object({ items: z.array(ForgedItem) }),
  },
  "quest.offer": {
    params: z.object({ giver: z.string().optional(), zone: z.string().optional(), context: Bag.optional(), seed: Seed }),
    /** null = nothing worth offering right now. */
    result: z.object({ quest: Quest.nullable() }),
  },
  "achievement.check": {
    params: z.object({ recent: z.array(z.string()).max(20).optional() }),
    result: z.object({ unlocked: z.array(Achievement) }),
  },
  /** The Observer's player model (traits decayed to now, moments, profile, stats) for SDKs and dashboards. */
  "player.model": {
    params: z.object({
      /** true = also generate a fresh LLM profile (arrives as the upgrade; instant carries the current one). */
      refreshProfile: z.boolean().optional(),
      /** Max traits in `top` (default 5). */
      top: z.number().int().min(1).max(30).optional(),
    }),
    result: PlayerModel.omit({ acc: true }).extend({
      /** Strongest traits first (score >= 0.2). */
      top: z.array(z.object({ trait: z.string(), score: Unit })).default([]),
    }),
  },
  /** Village mind (K7 factions): a night raid that counters the player's habits (pillaring, bow, hiding ...). */
  "faction.raid_plan": { params: RaidPlanParams, result: RaidPlanResult },
  "world.reactions": {
    params: z.object({ zone: z.string().optional(), npcs: z.array(z.string()).max(32).optional() }),
    result: z.object({
      rumours: z.array(Rumour).default([]),
      directives: z.array(DirectiveDraftSchema).default([]),
      /** npc id -> attitude toward the player (-1..1). */
      attitudes: z.record(z.string(), z.number().min(-1).max(1)).default({}),
    }),
  },
} as const;

export type AskKind = keyof typeof ASKS;
export const ASK_KINDS = Object.keys(ASKS) as AskKind[];
export const isAskKind = (k: string): k is AskKind => k in ASKS;
export type AskParams<K extends AskKind> = z.infer<(typeof ASKS)[K]["params"]>;
export type AskParamsInput<K extends AskKind> = z.input<(typeof ASKS)[K]["params"]>;
export type AskResult<K extends AskKind> = z.infer<(typeof ASKS)[K]["result"]>;

export const ASK_STAGES = ["instant", "upgrade"] as const;
export type AskStage = (typeof ASK_STAGES)[number];
/** rules = designer rules / procedural fast-path; cache = cached earlier AI answer; ai = LLM; bake = pre-generated pack. */
export const ASK_SOURCES = ["rules", "cache", "ai", "bake"] as const;
export type AskSource = (typeof ASK_SOURCES)[number];

/** POST /v1/ask/:kind body. */
export const AskRequest = z.object({
  /** Client-generated id (else the server makes one). Upgrades reuse it. */
  id: Id.optional(),
  world: Id,
  player: Id,
  session: Id.optional(),
  params: Bag.default({}),
  /** false = instant only, never schedule an AI upgrade. Default true. */
  upgrade: z.boolean().optional(),
});
export type AskRequest = z.infer<typeof AskRequest>;
export type AskRequestInput = z.input<typeof AskRequest>;

/** Both stages share this shape; `result` matches ASKS[kind].result. */
export const AskResponse = z.object({
  id: Id,
  kind: z.string(),
  stage: z.enum(ASK_STAGES),
  result: z.unknown(),
  source: z.enum(ASK_SOURCES),
  why: z.string().max(300).optional(),
  /** Instant responses only: "pending" = an upgrade will follow (WS `upgrade` or GET /v1/upgrades/:id). */
  upgrade: z.enum(["pending", "none"]).optional(),
  /** Server time spent (ms). */
  ms: z.number().optional(),
  ts: Timestamp,
});
export type AskResponse<K extends AskKind = AskKind> = Omit<z.infer<typeof AskResponse>, "result" | "kind"> & {
  kind: K;
  result: AskResult<K>;
};
export type AnyAskResponse = z.infer<typeof AskResponse>;

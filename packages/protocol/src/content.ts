// Content types shared by asks, directives and projection state: NPC actions, voice, forged items, quests,
// achievements, rumours, moments.
import { z } from "zod";
import { Bag, Hex, Id, Timestamp } from "./common.js";
import { Blueprint } from "./blueprint.js";
import { VfxRecipe } from "./vfx.js";
import { Variant } from "./variant.js";

/**
 * Built-in NPC action names (spec §3.2). The manifest `actions` schema decides which exist in a game (it may add
 * custom ones); a persona's `allowedActions` narrows them per NPC. The server drops anything outside both.
 */
export const BUILTIN_NPC_ACTIONS = [
  "emote", "trade", "give", "take", "quest_offer", "reveal", "hostile", "flee", "call_guards", "steal", "follow", "help", "join",
] as const;
export type BuiltinNpcAction = (typeof BUILTIN_NPC_ACTIONS)[number];

/** A structured action an NPC performs (validated against the manifest action schema + persona allowedActions). */
export const NpcAction = z.object({
  action: z.string().min(1).max(48),
  /** Args per the manifest action schema, e.g. trade {priceMultiplier: 1.2}, give {item: "potion"}. */
  args: Bag.default({}),
  /** Who it is aimed at ("player" by default, or an npc id). */
  target: z.string().max(64).optional(),
});
export type NpcAction = z.infer<typeof NpcAction>;

/** Voice hints for SDK / engine TTS (Godot DisplayServer.tts_speak, browser speechSynthesis). */
export const VoiceStyle = z.object({
  /** 0.5-2 (1 = engine default). */
  pitch: z.number().min(0.5).max(2).optional(),
  /** 0.5-2 (1 = engine default). */
  rate: z.number().min(0.5).max(2).optional(),
  /** Accent / language hint, e.g. "en-GB", "scottish". */
  accent: z.string().max(32).optional(),
  /** Free style words: "gruff", "whispering", "sing-song". */
  style: z.string().max(64).optional(),
  /** Preferred engine / provider voice id if the game has one. */
  voiceId: z.string().max(64).optional(),
});
export type VoiceStyle = z.infer<typeof VoiceStyle>;

/** A generated item (forge.item / forge.loot / forge.armour_set pieces), clamped to the manifest item schema. */
export const ForgedItem = z.object({
  id: Id,
  name: z.string().max(64),
  flavor: z.string().max(240),
  /** Manifest item family (e.g. one of Counterforge's 18 weapon families) or armour slot. */
  family: z.string().max(32).optional(),
  slot: z.string().max(32).optional(),
  rarity: z.string().max(24).optional(),
  element: z.string().max(24).optional(),
  /** Stats per the manifest item schema (each clamped to its min/max, total within budget). */
  stats: z.record(z.string(), z.number()),
  tags: z.array(z.string()).default([]),
  blueprint: Blueprint,
  vfx: VfxRecipe.optional(),
  /** Set when the item restyles a developer asset instead of / as well as a blueprint. */
  variant: Variant.optional(),
  /** Hyper3D (or other 3D provider) upgrade job, if requested and enabled. Poll GET /v1/forge/jobs/:id or wait for forge.ready. */
  mesh: z.object({ jobId: z.string(), state: z.enum(["queued", "generating", "done", "failed"]), url: z.string().optional() }).optional(),
  /** 0-1: how far the forge stretched the request (Counterforge creativity rules). */
  creativity: z.number().min(0).max(1).optional(),
  /** Text prompt used for a 3D mesh job. */
  meshPrompt: z.string().max(400).optional(),
});
export type ForgedItem = z.infer<typeof ForgedItem>;

export const QuestObjective = z.object({
  id: z.string().max(48),
  /** One of the manifest quest schema objectiveTypes (e.g. kill, fetch, talk, escort, explore, deliver, survive). */
  type: z.string().max(32),
  /** Target id (npc / item / zone / enemy type). */
  target: z.string().max(64),
  count: z.number().int().min(1).optional(),
  description: z.string().max(200),
  optional: z.boolean().optional(),
  /** Optional DSL completion condition (else the game / quests module completes it from signals). */
  condition: z.string().max(200).optional(),
});
export type QuestObjective = z.infer<typeof QuestObjective>;

export const QuestReward = z.object({
  /** One of the manifest rewardTypes (gold, item, xp, reputation, unlock, title ...). */
  type: z.string().max(32),
  id: z.string().max(64).optional(),
  amount: z.number().optional(),
  description: z.string().max(120).optional(),
  /** A generated reward item. */
  item: ForgedItem.optional(),
});
export type QuestReward = z.infer<typeof QuestReward>;

export const Quest = z.object({
  id: Id,
  title: z.string().max(80),
  summary: z.string().max(400),
  giver: z.string().max(64).optional(),
  objectives: z.array(QuestObjective).min(1).max(8),
  rewards: z.array(QuestReward).max(6),
  /** Giver lines (voiced via Persona). */
  dialogue: z.object({ offer: z.string().max(400).optional(), accept: z.string().max(300).optional(), complete: z.string().max(300).optional() }).optional(),
  expiresInSec: z.number().positive().optional(),
  /** What caused it (moment id, rumour id, world state) - shown in the dashboard. */
  origin: z.object({ kind: z.enum(["moment", "rumour", "world", "designer", "npc"]), ref: z.string().max(64).optional() }).optional(),
  tags: z.array(z.string()).optional(),
});
export type Quest = z.infer<typeof Quest>;

export const Achievement = z.object({
  id: Id,
  title: z.string().max(64),
  description: z.string().max(200),
  icon: z.object({
    /** Glyph name the SDK can draw ("skull", "coin", "flame" ...). */
    glyph: z.string().max(32).optional(),
    color: Hex.optional(),
    blueprint: Blueprint.optional(),
    vfx: VfxRecipe.optional(),
  }),
  /** Trait-rule DSL condition that unlocked it (see dsl.ts). */
  condition: z.string().max(300),
  rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]).default("common"),
  /** true = generated for this player (vs designer-declared in the manifest). */
  personal: z.boolean().default(true),
  unlockedAt: Timestamp.optional(),
});
export type Achievement = z.infer<typeof Achievement>;

export const Rumour = z.object({
  id: Id,
  content: z.string().max(280),
  /** 0 = pure fabrication, 1 = exactly true. Mutations lower it. */
  truthfulness: z.number().min(0).max(1),
  /** 0-1 how hot / widely repeated it is; decays over time. */
  heat: z.number().min(0).max(1),
  origin: z.object({ kind: z.enum(["moment", "memory", "designer", "event", "npc"]), ref: z.string().max(64).optional(), npc: z.string().max(64).optional() }),
  about: z.object({ player: z.string().optional(), npc: z.string().optional(), faction: z.string().optional() }).optional(),
  /** NPC ids that know it. */
  knownBy: z.array(z.string()).default([]),
  createdAt: Timestamp,
  mutations: z.number().int().min(0).default(0),
  /** Previous wording (latest first) - the spread graph shows how it drifted. */
  history: z.array(z.string()).optional(),
});
export type Rumour = z.infer<typeof Rumour>;

/** Built-in moment kinds (spec §3.1); manifest `moments` adds designer ones. */
export const BUILTIN_MOMENTS = [
  "near_death_escape", "flawless_phase", "comeback", "betrayal", "absurd_purchase", "first_kill_of_type", "broken_promise",
] as const;

export const Moment = z.object({
  id: Id,
  kind: z.string().max(48),
  ts: Timestamp,
  /** Human-readable evidence ("hp 3% -> fled", "bought a 900g hat"). */
  evidence: z.array(z.string()).default([]),
  data: Bag.optional(),
  /** 0-1 how notable; drives rumours / quests / barks. */
  salience: z.number().min(0).max(1).default(0.5),
});
export type Moment = z.infer<typeof Moment>;

// Signals: fire-and-forget facts the game reports (spec §2.1). Every signal becomes an event in the log.
import { z } from "zod";
import { Bag, Id, Timestamp } from "./common.js";

/** Signal type: dotted lowercase, at least one dot ("combat.dodged", "magic.raise_dead"). */
export const SignalType = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, 'signal types are dotted lowercase, e.g. "combat.dodged"');

export const Signal = z.object({
  type: SignalType,
  /** Payload; see BUILTIN_SIGNALS for the documented fields of built-in types. */
  data: Bag.default({}),
  /** Client time (ms epoch). The server also stamps its own receive time on the stored event. */
  ts: Timestamp,
  player: Id,
  world: Id,
  /** Play session (SDK generates one per run). Defaults to "default". */
  session: Id.optional(),
});
export type Signal = z.infer<typeof Signal>;
export type SignalInput = z.input<typeof Signal>;

/** Field types used to document built-in signals and to declare custom signals in the manifest. */
export type FieldType = "string" | "number" | "boolean" | "string[]" | "object";

export interface SignalDoc {
  description: string;
  /** Documented data fields. A trailing "?" in the key marks an optional field. */
  data: Record<string, FieldType>;
}

/**
 * The built-in vocabulary (spec §2.1). Observer traits / moments and every rules fast-path read these fields, so
 * games should send them with these names. Extra fields are allowed and stored.
 */
export const BUILTIN_SIGNALS = {
  // ---- combat
  "combat.hit": { description: "The player hit something.", data: { target: "string", "target_type?": "string", damage: "number", "weapon?": "string", "element?": "string", "range?": "number", "crit?": "boolean" } },
  "combat.hurt": { description: "The player took damage. hp = remaining fraction 0-1.", data: { source: "string", "source_type?": "string", damage: "number", hp: "number", "attack?": "string", "element?": "string" } },
  "combat.dodged": { description: "The player dodged an attack.", data: { "source?": "string", "attack?": "string", "direction?": "string" } },
  "combat.blocked": { description: "The player blocked an attack.", data: { "source?": "string", "attack?": "string", "prevented?": "number" } },
  "combat.parried": { description: "The player parried an attack.", data: { "source?": "string", "attack?": "string" } },
  "combat.killed": { description: "The player killed something.", data: { target: "string", target_type: "string", "weapon?": "string", "elite?": "boolean", "boss?": "boolean" } },
  "combat.died": { description: "The player died.", data: { "killer?": "string", "killer_type?": "string" } },
  "combat.ability_used": { description: "The player used an ability / spell / skill.", data: { ability: "string", "target?": "string", "cost?": "number", "element?": "string" } },
  // ---- economy
  "economy.gold": { description: "The player's gold balance changed. amount = new balance.", data: { amount: "number", "delta?": "number", "currency?": "string" } },
  "economy.bought": { description: "The player bought something.", data: { item: "string", price: "number", "vendor?": "string", "currency?": "string" } },
  "economy.sold": { description: "The player sold something.", data: { item: "string", price: "number", "vendor?": "string" } },
  "economy.stole": { description: "The player stole something.", data: { from: "string", "item?": "string", "value?": "number", "seen?": "boolean" } },
  // ---- social
  "social.said": { description: "The player said something (typed or STT).", data: { text: "string", "to?": "string" } },
  "social.talked_to": { description: "The player started a conversation.", data: { npc: "string" } },
  "social.gave": { description: "The player gave something.", data: { to: "string", "item?": "string", "gold?": "number" } },
  "social.lied": { description: "The player lied (game-detected, e.g. a dialogue choice).", data: { to: "string", "about?": "string" } },
  "social.threatened": { description: "The player threatened someone.", data: { target: "string" } },
  "social.approach": { description: "The player walked up to an NPC to interact (Persona prefetches a greeting).", data: { npc: "string" } },
  // ---- movement
  "movement.entered_zone": { description: "The player entered a zone.", data: { zone: "string", "kind?": "string" } },
  "movement.explored": { description: "The player discovered something / somewhere new.", data: { "zone?": "string", "discovery?": "string" } },
  "movement.fled": { description: "The player ran from a fight.", data: { "from?": "string", "hp?": "number" } },
  "movement.near_npc": { description: "The player came within talking range of an NPC (Persona prefetches a greeting).", data: { npc: "string", "distance?": "number" } },
  // ---- gear
  "gear.equipped": { description: "The player equipped an item.", data: { item: "string", slot: "string", "name?": "string", "tags?": "string[]", "value?": "number" } },
  "gear.unequipped": { description: "The player unequipped an item.", data: { item: "string", slot: "string" } },
  // ---- quests
  "quest.accepted": { description: "The player accepted a quest.", data: { quest: "string", "giver?": "string" } },
  "quest.completed": { description: "The player completed a quest.", data: { quest: "string" } },
  "quest.failed": { description: "The player failed / abandoned a quest.", data: { quest: "string", "reason?": "string" } },
  // ---- world
  "world.destroyed": { description: "The player destroyed something in the world.", data: { object: "string", "zone?": "string", "owner?": "string" } },
  "world.helped": { description: "The player helped an NPC.", data: { npc: "string", "how?": "string" } },
  "world.time": { description: "World clock. hour 0-24; phase dawn|day|dusk|night.", data: { hour: "number", "day?": "number", "phase?": "string" } },
} as const satisfies Record<string, SignalDoc>;

export type BuiltinSignalType = keyof typeof BUILTIN_SIGNALS;
export const BUILTIN_SIGNAL_TYPES = Object.keys(BUILTIN_SIGNALS) as BuiltinSignalType[];
export const SIGNAL_NAMESPACES = ["combat", "economy", "social", "movement", "gear", "quest", "world"] as const;

export const isBuiltinSignal = (type: string): type is BuiltinSignalType => type in BUILTIN_SIGNALS;

/** POST /v1/signals body. */
export const SignalBatch = z.object({ signals: z.array(Signal).min(1).max(500) });
export type SignalBatch = z.infer<typeof SignalBatch>;

export const SignalBatchResult = z.object({
  accepted: z.number().int(),
  /** Per-index rejections (unknown custom type, bad shape, moderation). Accepted signals are not rolled back. */
  rejected: z.array(z.object({ index: z.number().int(), code: z.string(), message: z.string() })),
  /** Highest event seq written by this batch (for snapshot / admin cursors). */
  lastSeq: z.number().int().nullable(),
});
export type SignalBatchResult = z.infer<typeof SignalBatchResult>;

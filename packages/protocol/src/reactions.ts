// Reaction Library (R1): the catalogue of ready-made reaction recipes a manifest switches on with one line
// (`reactions: { library: [outfit_comments, ...] }`), the shapes every library reaction carries on the wire
// (`reaction` info on npc.bark, `custom.reaction` args) and the per-player ledger projection
// ("world.reaction_ledger") the dashboard reads. The server implements the recipes (modules/world/reactions-lib);
// this file is the shared contract (names are fixed: games and SDKs rely on them).
import { z } from "zod";
import { Bag, Timestamp } from "./common.js";
import { MoveSpec } from "./moves.js";

/** Weather words for `world.time.weather`. */
export const WEATHERS = ["clear", "rain", "storm", "snow", "fog", "heat"] as const;
export type Weather = (typeof WEATHERS)[number];

/** Time-of-day buckets (derived from world.time.hour when phase is omitted). */
export const DAY_PHASES = ["dawn", "day", "dusk", "night"] as const;
export type DayPhase = (typeof DAY_PHASES)[number];

/** hour 0-24 -> dawn (5-8) / day (8-18) / dusk (18-21) / night. */
export function dayPhaseOf(hour: number): DayPhase {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 5 && h < 8) return "dawn";
  if (h >= 8 && h < 18) return "day";
  if (h >= 18 && h < 21) return "dusk";
  return "night";
}

export type ReactionArea = "npc" | "social" | "economy" | "boss" | "world";

export interface RecipeParamDoc {
  type: "number" | "boolean" | "string" | "string[]" | "npc" | "record";
  default?: unknown;
  description: string;
}

export interface ReactionRecipeDoc {
  id: string;
  title: string;
  area: ReactionArea;
  description: string;
  /** Signals the recipe reacts to (built-in vocabulary). */
  signals: readonly string[];
  /** Directive kinds it may emit (custom.reaction effects are listed in `effects`). */
  directives: readonly string[];
  /** `custom.reaction` payload.effect values the game may handle. */
  effects: readonly string[];
  /** Recipe-specific params (on top of COMMON_RECIPE_PARAMS). */
  params: Record<string, RecipeParamDoc>;
}

/** Params every recipe accepts. */
export const COMMON_RECIPE_PARAMS: Record<string, RecipeParamDoc> = {
  enabled: { type: "boolean", default: true, description: "false switches the recipe off without removing the line." },
  cooldownSec: { type: "number", description: "Seconds before the same speaker reacts with this recipe again (per player). Each recipe has its own default." },
  chance: { type: "number", default: 1, description: "0-1 probability that a reaction fires when its conditions hold (seeded, so replays match)." },
  when: { type: "string", description: "Extra trait-rule DSL gate, e.g. \"stat(zone) == \\\"courtyard\\\"\". The recipe only fires while it is true." },
  speakers: { type: "string[]", description: "Persona ids allowed to voice this recipe (default: personas in the player's zone, else any)." },
  ai: { type: "boolean", default: true, description: "Let the LLM write fresh variants for this recipe in the background (keyed servers only)." },
};

/** The top 20 recipes (the other 30 of the 50 are planned). Ids are fixed. */
export const REACTION_RECIPES = [
  {
    id: "outfit_comments", title: "Outfit comments", area: "npc",
    description: "NPCs notice what you wear (item names, colours, style tags) and comment, differently for every combination.",
    signals: ["appearance.outfit", "gear.equipped"], directives: ["npc.bark"], effects: [],
    params: { maxSpeakers: { type: "number", default: 2, description: "NPCs that comment on one outfit change." } },
  },
  {
    id: "appearance_state", title: "Bloodied, wet, burnt, muddy", area: "npc",
    description: "NPCs react to how you look right now: blood, soaking clothes, scorch marks, mud.",
    signals: ["appearance.state"], directives: ["npc.bark", "custom.reaction"], effects: ["concern"],
    params: {
      threshold: { type: "number", default: 0.5, description: "0-1 level at which a state is noticed." },
      healer: { type: "npc", description: "Persona who offers to patch you up when bloodied (custom.reaction effect concern)." },
    },
  },
  {
    id: "deed_nicknames", title: "Deed nicknames", area: "social",
    description: "NPCs coin a nickname from your deeds, reuse it in barks, and the nickname spreads as a rumour.",
    signals: ["lf.observer.moment", "combat.killed", "combat.boss_attempt", "combat.phase_flawless", "combat.fled", "economy.stole", "world.property_damaged", "social.gave"],
    directives: ["npc.bark", "rumour.heard", "custom.reaction"], effects: ["nickname"],
    params: { minGapSec: { type: "number", default: 300, description: "Minimum seconds before a new deed can replace the nickname." } },
  },
  {
    id: "lies_caught", title: "Lies caught", area: "social",
    description: "False claims (or claims a rumour contradicts) drop trust; the NPC calls you out and word gets around.",
    signals: ["social.claim", "social.lied"], directives: ["npc.bark", "rumour.heard", "custom.reaction"], effects: ["lie_caught"],
    params: {
      trustDrop: { type: "number", default: 0.2, description: "Attitude the NPC loses toward you per caught lie." },
      reputationDrop: { type: "number", default: 0.05, description: "Reputation lost with the NPC's faction." },
    },
  },
  {
    id: "promises_remembered", title: "Promises remembered", area: "social",
    description: "NPCs remember promises: reminders before they're due, thanks when kept, cold shoulders (and rumours) when broken.",
    signals: ["social.promise", "social.promise_kept", "social.promise_broken"], directives: ["npc.bark", "custom.reaction"], effects: ["promise_made", "promise_reminder", "promise_kept", "promise_broken"],
    params: {
      defaultDueSec: { type: "number", default: 900, description: "Due time for promises without one." },
      remindBeforeSec: { type: "number", default: 120, description: "Seconds before the due time when the NPC reminds you." },
      attitudeKept: { type: "number", default: 0.2, description: "Attitude gained when a promise is kept." },
      attitudeBroken: { type: "number", default: 0.3, description: "Attitude lost when a promise is broken (or runs out)." },
    },
  },
  {
    id: "town_mood", title: "Town mood", area: "world",
    description: "A streak of kind or rude acts shifts the whole town: barks, attitudes and prices follow.",
    signals: ["social.gave", "world.helped", "social.promise_kept", "quest.completed", "social.threatened", "economy.stole", "social.lied", "world.property_damaged"],
    directives: ["npc.bark", "custom.reaction"], effects: ["town_mood"],
    params: {
      streak: { type: "number", default: 3, description: "Kind (or rude) acts in a row that turn the mood." },
      priceShift: { type: "number", default: 0.1, description: "Price multiplier shift when the town warms (-) or cools (+)." },
      reputationShift: { type: "number", default: 0.05, description: "Reputation change with every faction when the mood turns." },
    },
  },
  {
    id: "rich_attention", title: "Rich attention", area: "economy",
    description: "Flash wealth and the town notices: pickpockets, beggars, price gouging and the tax collector, never the same twice in a row.",
    signals: ["economy.gold", "economy.bought", "movement.entered_zone", "movement.visited"], directives: ["npc.action", "npc.bark", "custom.reaction"],
    effects: ["pickpocket", "beggar", "price_gouge", "tax"],
    params: {
      gold: { type: "number", default: 500, description: "Gold that counts as rich (or the Observer trait rich above `trait`)." },
      trait: { type: "number", default: 0.6, description: "Observer trait(rich) threshold." },
      pickpocket: { type: "npc", description: "Persona who steals (npc.action steal when declared; else custom.reaction pickpocket)." },
      beggar: { type: "npc", description: "Persona who begs (else a nameless beggar via custom.reaction)." },
      merchant: { type: "npc", description: "Persona who gouges prices." },
      taxCollector: { type: "npc", description: "Persona who collects tax." },
      stealGold: { type: "number", default: 50, description: "Gold a pickpocket takes." },
      taxPct: { type: "number", default: 10, description: "Tax as % of gold." },
    },
  },
  {
    id: "broke_support", title: "Broke support", area: "economy",
    description: "Run out of money and someone helps: charity, or a loan shark's offer with a debt that comes back to bite.",
    signals: ["economy.gold", "social.promise", "social.promise_kept", "social.promise_broken"], directives: ["npc.bark", "custom.reaction"],
    effects: ["charity", "loan_offer", "debt_due", "debt_collector"],
    params: {
      gold: { type: "number", default: 20, description: "Gold at or below which the player counts as broke." },
      charityGold: { type: "number", default: 10, description: "Gold a kind soul gives." },
      loanShark: { type: "npc", description: "Persona who offers loans (accepting = social.promise {to: them, ref: <offer ref>})." },
      loanAmount: { type: "number", default: 100, description: "Loan size." },
      interestPct: { type: "number", default: 25, description: "Interest on the loan." },
      dueSec: { type: "number", default: 900, description: "Seconds until the debt is due." },
    },
  },
  {
    id: "collector_interest", title: "Collector interest", area: "economy",
    description: "A legendary or rare forged item draws a collector's offer, and if you refuse, a theft attempt.",
    signals: ["appearance.outfit", "gear.equipped"], directives: ["npc.bark", "custom.reaction"], effects: ["collector_offer", "theft_attempt"],
    params: {
      tags: { type: "string[]", default: ["legendary", "rare", "epic", "unique", "artifact"], description: "Item tags that count as collectable." },
      collector: { type: "npc", description: "Persona who makes offers (else a nameless collector)." },
      thief: { type: "npc", description: "Persona who tries to steal it." },
      offerGold: { type: "number", default: 400, description: "Base offer in gold." },
      theftAfterSec: { type: "number", default: 300, description: "Seconds after the offer before a theft attempt (if still carried)." },
    },
  },
  {
    id: "haggle_memory", title: "Haggle memory", area: "economy",
    description: "Merchants remember how you haggle: hard bargainers find prices padded, good sports get a wink and a discount.",
    signals: ["economy.haggled"], directives: ["npc.bark", "custom.reaction"], effects: ["price_adjust"],
    params: { step: { type: "number", default: 0.05, description: "Price multiplier change per remembered haggle." } },
  },
  {
    id: "boss_attempt_memory", title: "Boss attempt memory", area: "boss",
    description: "Bosses remember your attempts: gloating after deaths, grudging respect after many tries, a hint when you're stuck.",
    signals: ["combat.boss_attempt"], directives: ["boss.adapt", "custom.reaction"], effects: ["boss_line"],
    params: {
      hintAfter: { type: "number", default: 3, description: "Deaths before the boss lets a hint slip." },
      respectAfter: { type: "number", default: 5, description: "Attempts before gloating turns to respect." },
      hints: { type: "string[]", description: "Designer hints (default: generic, by weakness)." },
    },
  },
  {
    id: "dodge_bait", title: "Dodge bait", area: "boss",
    description: "Bosses learn your favourite dodge direction, bias their moves to punish it, and taunt you about it.",
    signals: ["combat.boss_attempt", "combat.dodged"], directives: ["boss.move_added", "boss.adapt", "custom.reaction"], effects: ["dodge_bait"],
    params: {
      minShare: { type: "number", default: 0.45, description: "Share of dodges one way that counts as a habit." },
      minDodges: { type: "number", default: 6, description: "Dodges needed before the boss reads you." },
    },
  },
  {
    id: "flawless_secret_phase", title: "Flawless secret phase", area: "boss",
    description: "Clear a phase without a scratch and the boss, cornered, unlocks a secret desperate phase with a new move.",
    signals: ["combat.phase_flawless"], directives: ["boss.move_added", "boss.adapt", "custom.reaction"], effects: ["secret_phase"],
    params: { once: { type: "boolean", default: true, description: "Unlock at most once per boss per player." } },
  },
  {
    id: "coward_rumour", title: "Coward rumour", area: "social",
    description: "Flee too often and the town calls you a coward, and a bounty hunter comes to test you.",
    signals: ["combat.fled", "movement.fled"], directives: ["npc.bark", "rumour.heard", "custom.reaction"], effects: ["coward", "challenger"],
    params: {
      flees: { type: "number", default: 3, description: "Flights (within windowMin) before the rumour starts." },
      windowMin: { type: "number", default: 30, description: "Window for counting flights." },
      challenger: { type: "string", default: "a bounty hunter", description: "Who comes to test you." },
      challengerUnit: { type: "string", default: "bounty_hunter", description: "Unit type the game spawns for the challenger." },
    },
  },
  {
    id: "companion_grief", title: "Companion grief", area: "social",
    description: "When a companion dies, allies grieve in their own words and someone offers you revenge.",
    signals: ["companion.died"], directives: ["npc.bark", "quest.offer", "rumour.heard", "custom.reaction"], effects: ["grief"],
    params: { giver: { type: "npc", description: "Persona who offers the revenge quest (default: a friend of the companion)." }, revengeQuest: { type: "boolean", default: true, description: "Offer a revenge quest when the killer is known." } },
  },
  {
    id: "time_weather_barks", title: "Time and weather", area: "world",
    description: "Day, night and weather colour barks and behaviour: lamps at dusk, shelter from storms, sleepy dawns.",
    signals: ["world.time"], directives: ["npc.bark", "custom.reaction"], effects: ["behaviour"],
    params: {},
  },
  {
    id: "inn_regular", title: "Regular", area: "world",
    description: "Visit a place often and you become a regular: familiar greetings, the usual, a small discount.",
    signals: ["movement.visited"], directives: ["npc.bark", "custom.reaction"], effects: ["regular"],
    params: {
      visits: { type: "number", default: 3, description: "Visits (on different days or sessions) to become a regular." },
      kinds: { type: "string[]", default: ["inn", "shop", "tavern"], description: "Place kinds that can have regulars." },
      owners: { type: "record", description: "place id -> persona id who greets regulars (default: a persona whose zone is that place)." },
      discount: { type: "number", default: 0.1, description: "Regulars' discount." },
    },
  },
  {
    id: "absence_recap", title: "Absence recap", area: "world",
    description: "Come back after a long absence: your companion recaps, NPCs say you've been gone, and the world has moved on.",
    signals: ["session.started"], directives: ["npc.bark", "custom.reaction"], effects: ["absence"],
    params: {
      minHours: { type: "number", default: 6, description: "Hours away that count as a long absence." },
      companion: { type: "npc", description: "Persona who recaps (default: the first persona)." },
    },
  },
  {
    id: "property_damage", title: "Property damage", area: "world",
    description: "Break something and its owner reacts: a bill, a repair quest, and the guards if you keep at it.",
    signals: ["world.property_damaged", "world.destroyed"], directives: ["npc.bark", "npc.action", "quest.offer", "custom.reaction"],
    effects: ["compensation", "repair_quest", "guards"],
    params: {
      guardsAfter: { type: "number", default: 3, description: "Damaged objects (within 30 minutes) before the guards come." },
      repairQuest: { type: "boolean", default: true, description: "Offer a repair quest instead of a bill for big damage." },
      repairOver: { type: "number", default: 50, description: "Value above which a repair quest is offered." },
    },
  },
  {
    id: "avoided_area", title: "Avoided area", area: "world",
    description: "Areas you never visit (or fled from) grow rumours, and someone asks you to go and look.",
    signals: ["movement.visited", "movement.entered_zone", "combat.fled", "session.started"], directives: ["npc.bark", "rumour.heard", "quest.offer", "custom.reaction"],
    effects: ["avoided_area"],
    params: {
      afterMin: { type: "number", default: 20, description: "Minutes of play before an unvisited area counts as avoided." },
      zones: { type: "string[]", description: "Areas to watch (default: every manifest zone)." },
      giver: { type: "npc", description: "Persona who asks you to go and look." },
    },
  },
] as const satisfies readonly ReactionRecipeDoc[];

export type ReactionRecipeId = (typeof REACTION_RECIPES)[number]["id"];
export const REACTION_RECIPE_IDS = REACTION_RECIPES.map((r) => r.id) as ReactionRecipeId[];
export const isReactionRecipe = (id: string): id is ReactionRecipeId => (REACTION_RECIPE_IDS as string[]).includes(id);
export const recipeDoc = (id: string): ReactionRecipeDoc | undefined => (REACTION_RECIPES as readonly ReactionRecipeDoc[]).find((r) => r.id === id);

// ------------------------------------------------------------------ wire shapes

/** Why a library reaction happened: the recipe + the context fingerprint it was chosen for. */
export const ReactionInfo = z.object({
  recipe: z.string().max(48),
  /** Stable hash of the context facets (same facets -> same fingerprint). */
  fingerprint: z.string().max(24),
  /** "kind:key" facets, strongest first, e.g. ["gear:crimson", "weather:rain", "trait:rich"]. */
  facets: z.array(z.string().max(64)).max(16).default([]),
  /** Readable context sentence (what the AI upgrade was told). */
  sentence: z.string().max(400).optional(),
  /** Which variant of the recipe's line pool was used (novelty ledger). */
  variant: z.number().int().optional(),
});
export type ReactionInfo = z.infer<typeof ReactionInfo>;

/**
 * `custom.reaction` directive args: a game-specific effect of a library recipe. `payload.effect` names the effect
 * (see REACTION_RECIPES[].effects and docs/reactions.md); `target` mirrors the directive target.
 */
export const ReactionDirectiveArgs = z.object({
  recipe: z.string().max(48),
  target: z.string().max(96),
  payload: Bag.default({}),
  /** Spoken line that goes with it (also sent as npc.bark when an NPC speaks). */
  line: z.string().max(300).optional(),
  reaction: ReactionInfo.optional(),
});
export type ReactionDirectiveArgs = z.infer<typeof ReactionDirectiveArgs>;

// ------------------------------------------------------------------ projection "world.reaction_ledger" (player)

const LedgerLine = z.object({
  ts: Timestamp,
  line: z.string(),
  recipe: z.string(),
  fingerprint: z.string().default(""),
  variant: z.number().int().default(-1),
});

const Promise_ = z.object({
  ref: z.string(),
  to: z.string(),
  text: z.string(),
  made: Timestamp,
  due: Timestamp.nullable(),
  status: z.enum(["open", "kept", "broken"]),
  resolvedAt: Timestamp.optional(),
  reminded: z.boolean().default(false),
  /** A loan taken from broke_support (amount owed). */
  debt: z.number().optional(),
});

const BossMemory = z.object({
  attempts: z.number().int().default(0),
  deaths: z.number().int().default(0),
  wins: z.number().int().default(0),
  flees: z.number().int().default(0),
  lastResult: z.string().default(""),
  lastPhase: z.number().default(0),
  dodge: z.object({ left: z.number(), right: z.number(), back: z.number(), fwd: z.number() }).default({ left: 0, right: 0, back: 0, fwd: 0 }),
  flawless: z.array(z.number()).default([]),
  secret: MoveSpec.nullable().default(null),
  ts: Timestamp.default(0),
});

export const ReactionLedger = z.object({
  appearance: z.object({ wet: z.number(), bloodied: z.number(), burnt: z.number(), muddy: z.number(), ts: Timestamp }).default({ wet: 0, bloodied: 0, burnt: 0, muddy: 0, ts: 0 }),
  outfit: z.object({
    slots: z.record(z.string(), z.object({ id: z.string(), name: z.string(), tags: z.array(z.string()), colors: z.array(z.string()) })),
    styleTags: z.array(z.string()),
    ts: Timestamp,
  }).nullable().default(null),
  time: z.object({ hour: z.number(), day: z.number(), weather: z.string(), phase: z.string(), ts: Timestamp }).nullable().default(null),
  zone: z.string().default(""),
  firstTs: Timestamp.default(0),
  lastEventTs: Timestamp.default(0),
  session: z.object({ startedAt: Timestamp, absenceMs: z.number(), count: z.number().int() }).default({ startedAt: 0, absenceMs: 0, count: 0 }),
  nickname: z.object({ name: z.string(), deed: z.string(), ts: Timestamp }).nullable().default(null),
  promises: z.array(Promise_).default([]),
  claims: z.array(z.object({ to: z.string(), text: z.string(), truth: z.boolean().nullable(), ts: Timestamp, caught: z.boolean().default(false) })).default([]),
  haggles: z.record(z.string(), z.object({ count: z.number().int(), won: z.number().int(), lost: z.number().int(), lastDeltaPct: z.number(), ts: Timestamp })).default({}),
  bosses: z.record(z.string(), BossMemory).default({}),
  flees: z.array(z.object({ ts: Timestamp, from: z.string() })).default([]),
  companions: z.array(z.object({ companion: z.string(), killer: z.string(), ts: Timestamp })).default([]),
  visits: z.record(z.string(), z.object({ kind: z.string(), count: z.number().int(), sessions: z.number().int(), lastSession: z.number().int(), firstTs: Timestamp, lastTs: Timestamp })).default({}),
  damage: z.array(z.object({ owner: z.string(), object: z.string(), value: z.number(), ts: Timestamp })).default([]),
  mood: z.object({ streak: z.number().int(), kind: z.number().int(), rude: z.number().int(), turned: z.string(), ts: Timestamp }).default({ streak: 0, kind: 0, rude: 0, turned: "neutral", ts: 0 }),
  /** Items a collector has asked about: item id -> {offeredAt, refused}. */
  collected: z.record(z.string(), z.object({ name: z.string(), offeredAt: Timestamp, theftAt: Timestamp.nullable() })).default({}),
  /** Novelty ledger: speaker -> recent lines (newest last). */
  ledger: z.record(z.string(), z.array(LedgerLine)).default({}),
  /** recipe|speaker -> last fired ts (cooldowns). */
  cooldowns: z.record(z.string(), Timestamp).default({}),
  /** recipe|pool|speaker|fingerprint -> times used (seeded variant choice). */
  counts: z.record(z.string(), z.number().int()).default({}),
  /** Last fired reactions (newest last, <= 60) for the dashboard "Reactions" panel. */
  fired: z.array(z.object({
    ts: Timestamp,
    recipe: z.string(),
    speaker: z.string(),
    line: z.string().optional(),
    effect: z.string().optional(),
    fingerprint: z.string(),
    facets: z.array(z.string()),
    sentence: z.string().optional(),
    why: z.string(),
    directives: z.array(z.string()).default([]),
  })).default([]),
});
export type ReactionLedger = z.infer<typeof ReactionLedger>;

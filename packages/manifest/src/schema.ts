// liveforge.yaml schema (spec §2.5). Everything a designer controls: lore, personas, factions, rules, schemas,
// clamps, safety, budgets, model tiering and module toggles. Most sections are optional with sensible defaults so
// a minimal manifest is just `liveforge: 1` + `game`.
import { z } from "zod";
import { DEFAULT_ELEMENTS, MOVE_SHAPES } from "@liveforge/protocol";

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_\-]*$/, "ids are lowercase letters, digits, _ and - (e.g. \"old_tom\")");
const dsl = z.string().min(1).max(400);
const fieldType = z.enum(["string", "number", "boolean", "string[]", "object"]);

export const VoiceSchema = z.object({
  pitch: z.number().min(0.5).max(2).optional(),
  rate: z.number().min(0.5).max(2).optional(),
  accent: z.string().max(32).optional(),
  style: z.string().max(64).optional(),
  voiceId: z.string().max(64).optional(),
});

export const PersonaSchema = z.object({
  id,
  name: z.string().min(1).max(64),
  role: z.string().min(1).max(64),
  faction: id.optional(),
  /** 1-3 sentences of personality (injected into every prompt for this NPC). */
  personality: z.string().min(1).max(800),
  voice: VoiceSchema.default({}),
  /** What this NPC knows about (topics / facts); used to refuse out-of-scope questions in character. */
  knowledge: z.array(z.string().max(200)).default([]),
  /** Things the NPC only reveals with the `reveal` action / high attitude. */
  secrets: z.array(z.string().max(300)).default([]),
  likes: z.array(z.string().max(80)).default([]),
  dislikes: z.array(z.string().max(80)).default([]),
  /** Subset of manifest actions this NPC may take (default: every declared action). */
  allowedActions: z.array(z.string()).optional(),
  /** Where the NPC usually is (zone id) - proximity groups for rumour spread. */
  zone: z.string().max(64).optional(),
  /** Seed bark pool (instant answers before the AI refills it). */
  barks: z.array(z.string().max(200)).default([]),
  greeting: z.string().max(200).optional(),
  /** Developer asset id (forge.npc_look restyles it). */
  asset: z.string().max(128).optional(),
});
export type PersonaConfig = z.infer<typeof PersonaSchema>;

export const FactionSchema = z.object({
  id,
  name: z.string().min(1).max(64),
  description: z.string().max(400).optional(),
  /** Default attitude toward a new player, -1..1. */
  attitude: z.number().min(-1).max(1).default(0),
  /** Other faction id -> stance -1..1. */
  relations: z.record(z.string(), z.number().min(-1).max(1)).default({}),
  /** Price multiplier range applied by reputation (e.g. [0.8, 1.5]). */
  priceRange: z.tuple([z.number().positive(), z.number().positive()]).default([0.8, 1.5]),
});
export type FactionConfig = z.infer<typeof FactionSchema>;

export const RelationshipSchema = z.object({
  a: id,
  b: id,
  kind: z.enum(["rival", "family", "ally", "friend", "lover", "mentor", "enemy", "employer"]),
  /** 0-1 */
  strength: z.number().min(0).max(1).default(0.5),
  note: z.string().max(200).optional(),
});

export const ActionArgSchema = z.object({
  type: z.enum(["string", "number", "boolean"]),
  min: z.number().optional(),
  max: z.number().optional(),
  enum: z.array(z.string()).optional(),
  required: z.boolean().default(false),
  description: z.string().max(200).optional(),
});

export const ActionSchema = z.object({
  description: z.string().max(300).default(""),
  args: z.record(z.string(), ActionArgSchema).default({}),
  /** Who may perform it: npc (persona replies / npc.action directives), director, world (reaction rules). */
  by: z.array(z.enum(["npc", "director", "world"])).default(["npc"]),
});
export type ActionConfig = z.infer<typeof ActionSchema>;

export const CustomSignalSchema = z.object({
  description: z.string().max(300).default(""),
  /** Field -> type. Append "?" to the field name for optional fields. */
  data: z.record(z.string(), fieldType).default({}),
});

export const ReactionSchema = z.object({
  id,
  /** Trait-rule DSL over the player model, e.g. "rich & stat(zone) == \"town\"". */
  when: dsl,
  then: z.object({
    kind: z.string().min(1),
    target: z.string().min(1),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  /** Seconds before the rule can fire again for the same player. */
  cooldown: z.number().min(0).default(300),
  /** Fire at most once per player (default false = repeat after the cooldown). 0 cooldown = fire on each false->true edge. */
  once: z.boolean().default(false),
  /** Let the LLM flavour it (named NPC, bark, plan). */
  flavour: z.boolean().default(false),
  description: z.string().max(300).optional(),
});

export const StatSchema = z.object({ min: z.number(), max: z.number(), default: z.number().optional() });

export const ItemSchemaConfig = z.object({
  /** Item families (e.g. Counterforge's 18 weapon families) - forge picks one per item. */
  families: z.array(z.string().min(1)).min(1),
  slots: z.array(z.string().min(1)).default(["weapon", "offhand", "head", "chest", "hands", "legs", "feet", "trinket"]),
  rarities: z.array(z.string()).default(["common", "uncommon", "rare", "epic", "legendary"]),
  /** Stat name -> bounds. Every forged stat is clamped here. */
  stats: z.record(z.string(), StatSchema),
  /** Sum of stats (after normalising each to 0-1 of its range) allowed per rarity tier index; scalar = flat budget. */
  budget: z.union([z.number().positive(), z.array(z.number().positive())]).default(2),
  /** Tags the forge may attach (elements, traits ...). */
  tags: z.array(z.string()).default([]),
  /** Creativity rules: how far a prompt may stretch power (0 = only plain items, 1 = anything goes within budget). */
  creativity: z.object({ max: z.number().min(0).max(1).default(0.7), rawPowerPenalty: z.boolean().default(true) }).default({ max: 0.7, rawPowerPenalty: true }),
  /** Developer assets forge.look may restyle. */
  assets: z.array(z.object({ id: z.string(), kind: z.string().optional(), slots: z.array(z.string()).optional() })).default([]),
});

export const QuestSchemaConfig = z.object({
  objectiveTypes: z.array(z.string()).default(["kill", "fetch", "talk", "explore", "deliver", "escort", "survive", "defeat_boss"]),
  rewardTypes: z.array(z.string()).default(["gold", "item", "xp", "reputation", "title"]),
  maxObjectives: z.number().int().min(1).max(8).default(3),
  maxActive: z.number().int().min(1).max(20).default(3),
  /** Persona ids allowed to give quests (default: all). */
  givers: z.array(z.string()).optional(),
  /** Reward bounds. */
  rewards: z.object({ goldMax: z.number().min(0).default(500), xpMax: z.number().min(0).default(1000) }).default({ goldMax: 500, xpMax: 1000 }),
});

export const EngineMoveSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().max(300).optional(),
  /** Grammar shape it resembles (lets the Director reason about it). */
  shape: z.enum(MOVE_SHAPES).optional(),
  /** Tunable params with bounds. */
  params: z.record(z.string(), z.object({ min: z.number(), max: z.number(), default: z.number().optional() })).default({}),
});

export const MoveSchemaConfig = z.object({
  /** Allow invented grammar moves (else only engine moves with params). */
  grammar: z.boolean().default(true),
  /** Restrict grammar shapes. */
  shapes: z.array(z.enum(MOVE_SHAPES)).optional(),
  /** Scale every damage cap (protocol MOVE_BUDGET is tuned for ~100 HP players). */
  damageScale: z.number().positive().default(1),
  engine: z.array(EngineMoveSchema).default([]),
});

export const BossSchema = z.object({
  id,
  name: z.string().min(1).max(64),
  /** Persona id that voices its taunts (optional). */
  persona: id.optional(),
  description: z.string().max(600).default(""),
  phases: z.number().int().min(1).max(9).default(3),
  /** Engine move ids it starts with. */
  moves: z.array(z.string()).default([]),
  /** Gear tags / habits it is allowed to counter. */
  counters: z.array(z.string()).default([]),
  /** Invented moves kept in rotation at once. */
  maxInvented: z.number().int().min(0).max(6).default(3),
  asset: z.string().max(128).optional(),
});

export const ProgressionSchema = z.object({
  unlocks: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string().default("ability"), condition: dsl.optional() })).default([]),
  levels: z.object({ max: z.number().int().min(1), xpCurve: z.enum(["linear", "quadratic", "exponential"]).default("quadratic") }).optional(),
});

export const AchievementDeclSchema = z.object({
  id,
  title: z.string().max(64),
  description: z.string().max(200),
  condition: dsl,
  glyph: z.string().max(32).optional(),
  rarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]).default("common"),
});

export const ClampsSchema = z.object({
  difficulty: z.object({
    mode: z.enum(["hidden", "assist", "off"]).default("hidden"),
    aggressionMin: z.number().min(0).max(1).default(0.2),
    aggressionMax: z.number().min(0).max(1).default(0.9),
    /** Max change per adjustment. */
    maxStep: z.number().min(0).max(1).default(0.15),
  }).prefault({}),
  pacing: z.object({
    maxSpawnPerMin: z.number().int().min(0).default(12),
    maxWaveSize: z.number().int().min(1).default(8),
    breatherSec: z.tuple([z.number().min(0), z.number().min(0)]).default([8, 30]),
    lootPerMin: z.number().min(0).default(2),
  }).prefault({}),
  forge: z.object({
    maxParts: z.number().int().min(1).max(64).default(24),
    maxPerMinPerPlayer: z.number().int().min(1).default(6),
    /** Allow Hyper3D mesh jobs (also needs HYPER3D_API_KEY). */
    meshJobs: z.boolean().default(false),
  }).prefault({}),
  npc: z.object({
    maxReplyChars: z.number().int().min(40).max(1200).default(400),
    /** Trade price multiplier bounds. */
    priceMultiplier: z.tuple([z.number().positive(), z.number().positive()]).default([0.5, 2]),
  }).prefault({}),
});

export const SafetySchema = z.object({
  /** E (everyone) / T (teen) / M (mature) preset for moderation + prompt guidance. */
  rating: z.enum(["E", "T", "M"]).default("T"),
  /** Extra blocked words / phrases (input + output). */
  blocked: z.array(z.string()).default([]),
  /** Topics personas refuse in character. */
  refusedTopics: z.array(z.string()).default(["real-world politics", "real people", "the player's personal data"]),
  /** Refuse out-of-world topics in character (spec §3.2). */
  inWorldOnly: z.boolean().default(true),
});

const BudgetWindow = z.object({
  tokensPerMin: z.number().int().positive(),
  usdPerDay: z.number().positive(),
});
export const BudgetsSchema = z.object({
  game: BudgetWindow.default({ tokensPerMin: 200_000, usdPerDay: 20 }),
  player: BudgetWindow.default({ tokensPerMin: 20_000, usdPerDay: 1 }),
});

export const ModelsSchema = z.object({
  /** Tier -> model id. Env LIVEFORGE_MODEL_FAST / LIVEFORGE_MODEL_RICH override. */
  fast: z.string().default("claude-haiku-4-5"),
  rich: z.string().default("claude-sonnet-5-5"),
  /** Per ask kind / module task override: { "npc.reply": "rich", "observer.profile": "rich" }. */
  overrides: z.record(z.string(), z.enum(["fast", "rich"])).default({}),
});

const ModuleToggle = z.union([z.boolean(), z.object({ enabled: z.boolean().default(true), options: z.record(z.string(), z.unknown()).default({}) })]);
export const MODULE_IDS = ["observer", "persona", "world", "director", "forge", "quests"] as const;
export type ModuleId = (typeof MODULE_IDS)[number];
export const ModulesSchema = z.object({
  observer: ModuleToggle.default(true),
  persona: ModuleToggle.default(true),
  world: ModuleToggle.default(true),
  director: ModuleToggle.default(true),
  forge: ModuleToggle.default(true),
  quests: ModuleToggle.default(true),
}).catchall(ModuleToggle);

export const ManifestSchema = z.object({
  /** Manifest format version. */
  liveforge: z.literal(1),
  game: z.object({
    id,
    name: z.string().min(1).max(80),
    description: z.string().max(1000).optional(),
  }),
  lore: z.object({
    /** The lore bible: world facts every prompt may rely on. Markdown allowed. */
    bible: z.string().min(1).max(20_000),
    /** Tone words: "wry, grim, warm". */
    tone: z.string().max(300).default("neutral"),
    /** Name -> one-line definition. */
    glossary: z.record(z.string(), z.string()).default({}),
  }),
  /** Elements used by items / moves (default physical, fire, ice, lightning). */
  elements: z.array(z.string().min(1)).default([...DEFAULT_ELEMENTS]),
  zones: z.array(z.object({ id, name: z.string(), kind: z.string().default("area"), neighbours: z.array(z.string()).default([]) })).default([]),
  personas: z.array(PersonaSchema).default([]),
  factions: z.array(FactionSchema).default([]),
  relationships: z.array(RelationshipSchema).default([]),
  /** Designer traits: name -> DSL (score = 1 when true, decays like built-ins). */
  traits: z.record(z.string(), dsl).default({}),
  /** Designer moments: name -> DSL. */
  moments: z.record(z.string(), dsl).default({}),
  /** Custom signal types (e.g. "magic.raise_dead"). */
  signals: z.record(z.string(), CustomSignalSchema).default({}),
  /** Accept undeclared custom signal types (stored, flagged in the dashboard). Default false: rejected. */
  allowUndeclaredSignals: z.boolean().default(false),
  /** Action schema: the only actions NPCs / directives may perform. */
  actions: z.record(z.string(), ActionSchema).default({}),
  /** Reactive rules: when <player-model condition> then <directive>. */
  reactions: z.array(ReactionSchema).default([]),
  items: ItemSchemaConfig.optional(),
  quests: QuestSchemaConfig.prefault({}),
  moves: MoveSchemaConfig.prefault({}),
  bosses: z.array(BossSchema).default([]),
  progression: ProgressionSchema.prefault({}),
  achievements: z.array(AchievementDeclSchema).default([]),
  clamps: ClampsSchema.prefault({}),
  safety: SafetySchema.prefault({}),
  budgets: BudgetsSchema.prefault({}),
  models: ModelsSchema.prefault({}),
  modules: ModulesSchema.prefault({}),
});

/** Parsed + defaulted manifest (what the server and modules read). */
export type Manifest = z.infer<typeof ManifestSchema>;
/** What a designer writes (defaults optional). */
export type ManifestInput = z.input<typeof ManifestSchema>;

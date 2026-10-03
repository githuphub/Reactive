// Move grammar v1 (spec §3.4), ported from Counterforge (packages/pipeline/src/moveGrammar.ts) and generalised:
// elements come from the manifest, and a move may map to an engine-native move (`engine.moveId` + params) instead of
// (or as well as) the grammar primitives. Browser-safe: SDKs re-validate every move they receive with clampMove and
// can fall back to composeMove locally.
import { z } from "zod";
import { cleanText, clampNum, isObj, mulberry32, oneOf } from "./common.js";

export const MOVE_SHAPES = ["slam", "beam", "projectile", "ring", "spikes", "meteor", "grab", "summon"] as const;
export const MOVE_PATTERNS = ["single", "fan", "line", "spiral", "burst", "ring"] as const;
/** Player statuses a move may apply (no hard stun-lock is ever authored by the Director). */
export const MOVE_STATUSES = ["none", "burning", "chilled", "charged", "wet", "oiled", "poisoned", "slowed"] as const;
/** Fan / sweep bias toward the player's habitual dodge side. */
export const MOVE_BIASES = ["none", "left", "right"] as const;
/** Default element list when the manifest declares none. */
export const DEFAULT_ELEMENTS = ["physical", "fire", "ice", "lightning"] as const;

export type MoveShape = (typeof MOVE_SHAPES)[number];
export type MovePattern = (typeof MOVE_PATTERNS)[number];
export type MoveStatus = (typeof MOVE_STATUSES)[number];
export type MoveBias = (typeof MOVE_BIASES)[number];

/** An engine-native move the game already implements, with designer-bounded parameters (manifest `moves.engine`). */
export const EngineMoveRef = z.object({
  moveId: z.string().min(1).max(64),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
});
export type EngineMoveRef = z.infer<typeof EngineMoveRef>;

export const MoveSpec = z.object({
  /** Display name, announced before first use (<= 32 chars). */
  name: z.string().min(1).max(32),
  /** One-line announcement (<= 90 chars), persona-voiced. */
  taunt: z.string().max(90),
  shape: z.enum(MOVE_SHAPES),
  /** One of the manifest's elements (default physical / fire / ice / lightning). */
  element: z.string().min(1).max(24),
  pattern: z.enum(MOVE_PATTERNS),
  /** Emitters / waves (1-8, capped per shape). */
  count: z.number().int().min(1).max(8),
  /** Telegraph seconds (0.6-1.6). */
  telegraph: z.number(),
  /** Speed multiplier (0.6-1.8). */
  speed: z.number(),
  /** Size multiplier (0.6-1.8). */
  size: z.number(),
  /** Damage per hit, clamped to the shape's budget for this count (moveDamageCap). */
  damage_budget: z.number(),
  status: z.enum(MOVE_STATUSES),
  bias: z.enum(MOVE_BIASES),
  /** Optional engine-native mapping: run this engine move with these params instead of the grammar primitives. */
  engine: EngineMoveRef.optional(),
});
export type MoveSpec = z.infer<typeof MoveSpec>;

export const MOVE_LIMITS = {
  count: [1, 8],
  telegraph: [0.6, 1.6],
  speed: [0.6, 1.8],
  size: [0.6, 1.8],
  damage: [5, 26],
  nameMax: 32,
  tauntMax: 90,
  /** Invented moves kept in a boss rotation at once. */
  maxInvented: 3,
} as const;

/** Per-shape damage budget: per-hit cap, total budget spread over sqrt(count), max count. */
export const MOVE_BUDGET: Readonly<Record<MoveShape, { perHit: number; total: number; maxCount: number }>> = {
  slam: { perHit: 22, total: 40, maxCount: 4 },
  beam: { perHit: 18, total: 34, maxCount: 4 },
  projectile: { perHit: 12, total: 40, maxCount: 8 },
  ring: { perHit: 16, total: 34, maxCount: 4 },
  spikes: { perHit: 16, total: 48, maxCount: 8 },
  meteor: { perHit: 18, total: 50, maxCount: 8 },
  grab: { perHit: 24, total: 34, maxCount: 2 },
  summon: { perHit: 8, total: 20, maxCount: 4 },
};

export interface MoveClampOptions {
  /** Allowed elements (manifest `elements`); default DEFAULT_ELEMENTS. Matching is case-insensitive. */
  elements?: readonly string[];
  /** Scale every damage cap (manifest `moves.damageScale`, e.g. 4 for a game with 400 HP players). Default 1. */
  damageScale?: number;
  /** Allowed engine move ids (manifest `moves.engine[].id`); an unknown engine ref is dropped. */
  engineMoves?: readonly string[];
}

/** Highest legal per-hit damage for a shape at a count (before damageScale). */
export function moveDamageCap(shape: MoveShape, count: number): number {
  const b = MOVE_BUDGET[shape];
  return Math.max(MOVE_LIMITS.damage[0], Math.min(b.perHit, MOVE_LIMITS.damage[1], b.total / Math.sqrt(Math.max(1, count))));
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Validates + clamps an untrusted move. Null when a required enum is missing / unknown or the name is empty. */
export function clampMove(raw: unknown, opts: MoveClampOptions = {}): MoveSpec | null {
  if (!isObj(raw)) return null;
  const elements = opts.elements?.length ? opts.elements : DEFAULT_ELEMENTS;
  const scale = opts.damageScale && opts.damageScale > 0 ? opts.damageScale : 1;
  const shape = oneOf(MOVE_SHAPES, raw.shape);
  const elRaw = typeof raw.element === "string" ? raw.element.toLowerCase() : "";
  const element = elements.find((e) => e.toLowerCase() === elRaw);
  let pattern = oneOf(MOVE_PATTERNS, raw.pattern);
  const name = cleanText(raw.name, MOVE_LIMITS.nameMax);
  if (!shape || !element || !pattern || !name) return null;
  const b = MOVE_BUDGET[shape];
  let count = Math.round(clampNum(raw.count, MOVE_LIMITS.count[0], MOVE_LIMITS.count[1], 3));
  count = Math.min(count, b.maxCount);
  if (shape === "grab") pattern = "single"; // a lunge has no spread; count = chained lunges
  if (shape === "summon" && pattern !== "ring" && pattern !== "burst") pattern = "burst";
  const cap = moveDamageCap(shape, count) * scale;
  // accept Counterforge's `damage` field too
  const dmgRaw = raw.damage_budget ?? raw.damage;
  const damage = Math.round(clampNum(dmgRaw, MOVE_LIMITS.damage[0] * scale, cap, cap * 0.8));
  const taunt = cleanText(raw.taunt, MOVE_LIMITS.tauntMax) || `Behold: ${name}.`;
  const out: MoveSpec = {
    name,
    taunt,
    shape,
    element,
    pattern,
    count,
    telegraph: round2(clampNum(raw.telegraph, MOVE_LIMITS.telegraph[0], MOVE_LIMITS.telegraph[1], 1)),
    speed: round2(clampNum(raw.speed, MOVE_LIMITS.speed[0], MOVE_LIMITS.speed[1], 1)),
    size: round2(clampNum(raw.size, MOVE_LIMITS.size[0], MOVE_LIMITS.size[1], 1)),
    damage_budget: Math.min(damage, Math.round(cap)),
    status: oneOf(MOVE_STATUSES, raw.status) ?? "none",
    bias: oneOf(MOVE_BIASES, raw.bias) ?? "none",
  };
  if (isObj(raw.engine) && typeof raw.engine.moveId === "string") {
    const ok = !opts.engineMoves || opts.engineMoves.includes(raw.engine.moveId);
    if (ok) {
      const params: Record<string, number | string | boolean> = {};
      if (isObj(raw.engine.params)) {
        for (const [k, v] of Object.entries(raw.engine.params).slice(0, 16)) {
          if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") params[k.slice(0, 32)] = v;
        }
      }
      out.engine = { moveId: raw.engine.moveId.slice(0, 64), params };
    }
  }
  return out;
}

// ---------------------------------------------------------------- habits (what the Director reads)

/** Player combat habits (measured by the game or derived from signals by the Observer). All values clamped by cleanHabits. */
export interface MoveHabits {
  /** Fraction of time at close / mid / long range (sum ~1). */
  range: { close: number; mid: number; long: number };
  /** Share of dodges to the player's LEFT (relative to the boss), 0.5 = balanced. */
  dodgeLeft: number;
  /** Dodges per minute. */
  dodgeRate: number;
  /** Fraction of incoming attacks blocked or parried. */
  blockRate: number;
  /** Jumps per minute. */
  jumpRate: number;
  /** Fraction of time standing (nearly) still. */
  stationary: number;
  /** Attacks per second (button mashing). */
  spam: number;
  /** Fraction of time with cover between player and boss. */
  coverShare: number;
  /** Forges / item swaps per minute. */
  forgeRate: number;
  /** Player HP fraction 0..1. */
  playerHp: number;
  /** Player deaths this session. */
  deaths: number;
}

const c01 = (v: unknown, d = 0) => clampNum(v, 0, 1, d);

/** Whitelists + clamps habits from an untrusted body. */
export function cleanHabits(v: unknown): MoveHabits {
  const h = isObj(v) ? v : {};
  const r = isObj(h.range) ? h.range : {};
  return {
    range: { close: c01(r.close), mid: c01(r.mid, 1), long: c01(r.long) },
    dodgeLeft: c01(h.dodgeLeft, 0.5),
    dodgeRate: clampNum(h.dodgeRate, 0, 120, 0),
    blockRate: c01(h.blockRate),
    jumpRate: clampNum(h.jumpRate, 0, 120, 0),
    stationary: c01(h.stationary),
    spam: clampNum(h.spam, 0, 10, 0),
    coverShare: c01(h.coverShare),
    forgeRate: clampNum(h.forgeRate, 0, 30, 0),
    playerHp: c01(h.playerHp, 1),
    deaths: Math.round(clampNum(h.deaths, 0, 99, 0)),
  };
}

export interface ComposeMoveRequest {
  phase: number;
  habits: MoveHabits;
  /** Names already in the rotation (avoid duplicates). */
  existing: string[];
  /** Current attunement (null = none). */
  attune: string | null;
  /** Deterministic seed for the rules composer. */
  seed: number;
}

// ---------------------------------------------------------------- keyless rules composer

const ADJ: Record<string, readonly string[]> = {
  fire: ["Cinder", "Magma", "Ember", "Slag", "Furnace", "Scorch"],
  ice: ["Frost", "Rime", "Glacier", "Hoarfrost", "Shiver", "Winter"],
  lightning: ["Thunder", "Storm", "Volt", "Arc", "Static", "Tempest"],
  physical: ["Iron", "Anvil", "Granite", "Rubble", "Hammer", "Basalt"],
};
const ADJ_ANY = ["Grim", "Hollow", "Dread", "Wild", "Ashen", "Shadow"];
const NOUN: Record<MoveShape, readonly string[]> = {
  slam: ["Pound", "Fist", "Quake", "Stomp"],
  beam: ["Lance", "Glare", "Ray", "Scythe"],
  projectile: ["Volley", "Hail", "Salvo", "Spit"],
  ring: ["Halo", "Pulse", "Ripple", "Bloom"],
  spikes: ["Thorns", "Teeth", "Lattice", "Fangs"],
  meteor: ["Fall", "Rain", "Comet", "Judgement"],
  grab: ["Talon", "Clutch", "Snare", "Grasp"],
  summon: ["Brood", "Litter", "Swarm", "Spawn"],
};
const STATUS_FOR: Record<string, MoveStatus> = { fire: "burning", ice: "chilled", lightning: "charged", physical: "none" };

interface Plan { shape: MoveShape; pattern: MovePattern; count: number; bias: MoveBias; habit: string; speed: number; size: number }

/**
 * Keyless Director: composes a move that punishes the player's strongest habit (ranged camping -> gap-closer,
 * side-dodging -> fan biased that way, hugging -> rings, turtling -> meteors from above, standing still -> spiral
 * rain, hopping -> spikes, mashing -> burst). Deterministic for a seed. Always passes clampMove.
 * Returns the move plus the habit it answers (use it as the `why`).
 */
export function composeMove(req: ComposeMoveRequest, opts: MoveClampOptions = {}): { move: MoveSpec; habit: string } {
  const rng = mulberry32((req.seed ^ 0x9e3779b9) >>> 0);
  const h = cleanHabits(req.habits);
  const ph = Math.max(1, Math.min(5, Math.round(req.phase)));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length) % xs.length];
  const plans: { score: number; plan: Plan }[] = [];
  const add = (score: number, plan: Plan) => plans.push({ score, plan });

  add(h.range.long * 1.6, rng() < 0.5
    ? { shape: "grab", pattern: "single", count: ph >= 2 ? 2 : 1, bias: "none", habit: "hiding at range", speed: 1.5, size: 1 }
    : { shape: "spikes", pattern: "line", count: 6 + ph, bias: "none", habit: "hiding at range", speed: 1.5, size: 1 });
  const side = Math.abs(h.dodgeLeft - 0.5) * 2 * Math.min(1, h.dodgeRate / 6);
  if (side > 0) {
    const left = h.dodgeLeft > 0.5;
    add(side * 1.5, { shape: rng() < 0.5 ? "spikes" : "projectile", pattern: "fan", count: 4 + ph, bias: left ? "left" : "right",
      habit: `dodging ${left ? "left" : "right"}`, speed: 1.2, size: 1 });
  }
  add(h.range.close * 1.3, { shape: "ring", pattern: "ring", count: 1 + ph, bias: "none", habit: "hugging my ankles", speed: 1.1, size: 1.2 });
  add(h.blockRate * 1.8, { shape: "meteor", pattern: "burst", count: 4 + ph, bias: "none", habit: "turtling behind a shield", speed: 1, size: 1 });
  add(h.stationary * 1.4, { shape: "meteor", pattern: "spiral", count: 5 + ph, bias: "none", habit: "standing still", speed: 1.1, size: 0.9 });
  add(Math.min(1, h.jumpRate / 10) * 1.2, { shape: "spikes", pattern: "ring", count: 5 + ph, bias: "none", habit: "hopping about", speed: 1.2, size: 1 });
  add(Math.min(1, h.spam / 1.5) * 1.1, { shape: "slam", pattern: "burst", count: 2 + ph, bias: "none", habit: "mashing buttons", speed: 1.1, size: 1.1 });
  add(h.coverShare * 1.5, { shape: "meteor", pattern: "line", count: 4 + ph, bias: "none", habit: "cowering behind rocks", speed: 1, size: 1.1 });
  add(0.35 + rng() * 0.2, { shape: pick(["projectile", "beam", "summon"] as const), pattern: pick(["fan", "spiral", "burst"] as const),
    count: 3 + ph, bias: "none", habit: "getting comfortable", speed: 1, size: 1 });
  plans.sort((a, b) => b.score - a.score);
  const plan = plans[0].plan;

  const elements = opts.elements?.length ? opts.elements : DEFAULT_ELEMENTS;
  const nonPhysical = elements.filter((e) => e.toLowerCase() !== "physical");
  const attune = req.attune && elements.find((e) => e.toLowerCase() === req.attune!.toLowerCase());
  const element = attune || pick(nonPhysical.length ? nonPhysical : elements);
  const adj = ADJ[element.toLowerCase()] ?? ADJ_ANY;
  const taken = new Set(req.existing.map((s) => s.toLowerCase()));
  let name = "";
  for (let i = 0; i < 8 && (!name || taken.has(name.toLowerCase())); i++) name = `${pick(adj)} ${pick(NOUN[plan.shape])}`;
  if (taken.has(name.toLowerCase())) name = `${name} ${["II", "III", "IV"][Math.floor(rng() * 3)]}`;
  const taunts = [
    `You keep ${plan.habit}. Meet the ${name}.`,
    `I noticed you ${plan.habit}. ${name}!`,
    `${plan.habit[0].toUpperCase()}${plan.habit.slice(1)}? Then learn ${name}.`,
  ];
  const count = Math.min(plan.count, MOVE_BUDGET[plan.shape].maxCount);
  const scale = opts.damageScale && opts.damageScale > 0 ? opts.damageScale : 1;
  const move = clampMove({
    name,
    taunt: pick(taunts),
    shape: plan.shape,
    element,
    pattern: plan.pattern,
    count,
    telegraph: 1.25 - 0.15 * Math.min(2, ph - 1),
    speed: plan.speed + 0.12 * Math.min(2, ph - 1),
    size: plan.size,
    damage_budget: moveDamageCap(plan.shape, count) * scale * (0.75 + 0.1 * Math.min(2, ph - 1)),
    status: STATUS_FOR[element.toLowerCase()] ?? "none",
    bias: plan.bias,
  }, { ...opts, elements })!;
  return { move, habit: plan.habit };
}

// ---------------------------------------------------------------- structured-output schema

const str = { type: "string" } as const;
const num = { type: "number" } as const;
const enumOf = (values: readonly string[]) => ({ type: "string", enum: [...values] });

/**
 * Anthropic structured-output schema for one invented move (additionalProperties false, every property required,
 * no min/max: clampMove clamps). Pass the manifest's elements.
 */
export function moveJsonSchema(elements: readonly string[] = DEFAULT_ELEMENTS) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      name: str,
      taunt: str,
      shape: enumOf(MOVE_SHAPES),
      element: enumOf(elements),
      pattern: enumOf(MOVE_PATTERNS),
      count: num,
      telegraph: num,
      speed: num,
      size: num,
      damage_budget: num,
      status: enumOf(MOVE_STATUSES),
      bias: enumOf(MOVE_BIASES),
    },
    required: ["name", "taunt", "shape", "element", "pattern", "count", "telegraph", "speed", "size", "damage_budget", "status", "bias"],
  } as const;
}

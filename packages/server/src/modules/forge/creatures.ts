// Creatures and props (forge.creature, forge.prop). Keyless: Counterforge's ally / arena-object archetypes, the object
// library (summon models) and a seeded generic object for any other noun. The LLM upgrade designs a compact part
// list (the Counterforge "shape" format) that is clamped and stood on the ground.
import { ANIM_KINDS, BLUEPRINT_ROLES, BLUEPRINT_SHAPES, PARTICLE_KINDS, cleanText, type Creature, type Prop } from "@liveforge/protocol";
import type { ForgeEnv } from "./env.js";
import { pickArchetype, keywordName, contentWords } from "./keywords.js";
import { expandShape, findDesign, headNoun, summonBlueprint, summonDesignFor, type SummonBehaviour, SUMMON_BEHAVIOURS } from "./library/objects.js";
import { applyStyle, proceduralBlueprint } from "./procedural.js";
import { groundGuard } from "./guards.js";
import { isPhysical } from "./elements.js";
import { buildVfx } from "./vfx.js";
import { resolveElement } from "./items.js";
import type { StatRange } from "./schema.js";
import { clampN, clampRawModel, finOr, hashString, isObj, mulberry32, scaleModel, toBlueprint, type RawModel } from "./model.js";

export const CREATURE_ROLES = ["minion", "elite", "boss", "critter", "mount", "summon"] as const;
export type CreatureRole = (typeof CREATURE_ROLES)[number];

/** Ordered behaviour cues (first match wins), ported from Counterforge summon.ts. */
const BEHAVIOUR_RULES: Array<[SummonBehaviour, RegExp]> = [
  ["ride", /\b(?:ride|rides|riding|rideable|ridable|mount|mountable|saddle|steed|hop on)\b/i],
  ["platform", /\b(?:platform|lift|lifts|elevator|hovers?|hovering|stand on|carr(?:y|ies) me)\b/i],
  ["heal_zone", /\b(?:heal|heals|healing|cure|cures|cleanse|cleanses|mend|mends|restore|restores|regenerat\w*|medic|nurse)\b/i],
  ["bomb", /\b(?:explode|explodes|exploding|explosion|bomb|blows? up|detonat\w*|kamikaze|kaboom)\b/i],
  ["rain", /\b(?:rain|rains|raining|downpour|shower|showers|hail)\b/i],
  ["trap", /\b(?:trap|traps|snare|ensnares?|roots?)\b/i],
  ["wall", /\b(?:blocks|protects?|guards|shields? me|cover|barrier)\b/i],
  ["decoy", /\b(?:decoy|distracts?|lures?|taunts?|bait|dummy|clone)\b/i],
  ["turret", /\b(?:shoot|shoots|shooting|fires|fires? at|snipes?|lasers?|spits?)\b/i],
  ["orbit", /\b(?:orbit|orbits|orbiting|circles?|circling|around me|swirls?|follows? me|flutters?)\b/i],
  ["charge", /\b(?:drives?|driving|charges?|charging|rams?|ramming|attacks?|attacking|runs? over|stampedes?|tackles?|bites?|stomps?|chases?)\b/i],
];

/** Behaviour a prompt asks for, or null. */
export function promptBehaviour(text: string): SummonBehaviour | null {
  for (const [b, re] of BEHAVIOUR_RULES) if (re.test(text)) return b;
  return null;
}

const ROLE_WORDS: Array<[CreatureRole, RegExp]> = [
  ["boss", /\b(boss|overlord|tyrant|titan|colossus|king|queen|lord|ancient|elder)\b/i],
  ["elite", /\b(elite|champion|captain|alpha|veteran|brute|knight|warlord)\b/i],
  ["mount", /\b(mount|steed|ride|rideable|saddle)\b/i],
  ["critter", /\b(critter|tiny|little|small|rat|mouse|frog|bird|butterfly|bug|beetle)\b/i],
  ["summon", /\b(summon|summoned|conjured|familiar|spirit)\b/i],
];
export function promptRole(text: string): CreatureRole {
  for (const [r, re] of ROLE_WORDS) if (re.test(text)) return r;
  return "minion";
}

const ROLE_SIZE: Record<CreatureRole, number> = { critter: 0.5, minion: 1.2, summon: 1.2, mount: 2, elite: 1.8, boss: 3 };
const ROLE_POWER: Record<CreatureRole, number> = { critter: 0.12, minion: 0.3, summon: 0.4, mount: 0.4, elite: 0.6, boss: 0.92 };
const ROLE_BEHAVIOUR: Record<CreatureRole, SummonBehaviour> = { critter: "orbit", minion: "charge", summon: "orbit", mount: "ride", elite: "charge", boss: "charge" };

/** Map a behaviour onto the game's behaviour list (forge options creatureBehaviours) when it declares one. */
export function gameBehaviour(env: ForgeEnv, b: string): string {
  const list = env.options.creatureBehaviours;
  if (!list?.length) return b;
  return list.find((x) => x === b) ?? list[0];
}

/** Creature stats: options.creatureStats ranges at the role's power, seeded noise. */
export function creatureStats(ranges: Record<string, StatRange>, role: CreatureRole, seed: number, override?: unknown): Record<string, number> {
  const rnd = mulberry32(seed ^ 0x3c6ef372);
  const src = isObj(override) ? override : {};
  const out: Record<string, number> = {};
  for (const [k, r] of Object.entries(ranges)) {
    const speedy = /speed|agility|move/i.test(k);
    const p = clampN(ROLE_POWER[role] * (speedy ? (role === "boss" ? 0.5 : 1) : 1) * (0.85 + rnd() * 0.3), 0, 1);
    const want = typeof src[k] === "number" && Number.isFinite(src[k]) ? clampN(src[k] as number, r.min, r.max) : r.min + p * (r.max - r.min);
    // the LLM may not exceed the role's power by more than 25 % of the range
    const cap = r.min + Math.min(1, p + 0.25) * (r.max - r.min);
    const v = Math.min(want, cap);
    out[k] = Number.isInteger(r.min) && Number.isInteger(r.max) ? Math.round(v) : Math.round(v * 100) / 100;
  }
  return out;
}

const CREATURE_FLAVORS = ["It has opinions about trespassers.", "Smells worse than it looks.", "Hungry, mostly.", "Born of the wrong kind of magic.", "It was here first."];

function creatureModel(text: string, element: string, behaviour: SummonBehaviour, seed: number): { model: RawModel; name: string } {
  const ally = pickArchetype(text, "ally");
  if (ally) return { model: proceduralBlueprint(ally, element, seed), name: ally.name };
  const design = findDesign(text) ?? summonDesignFor(text, behaviour);
  return { model: summonBlueprint(design, element, seed), name: design.name };
}

/** Keyless creature. */
export function forgeCreatureRules(env: ForgeEnv, req: { prompt: string; role?: CreatureRole; seed: number }): Creature {
  const text = req.prompt.trim();
  const role = req.role ?? promptRole(text);
  const element = resolveElement(env, text);
  const behaviour = promptBehaviour(text) ?? ROLE_BEHAVIOUR[role];
  const { model, name: baseName } = creatureModel(text, element, behaviour, req.seed);
  delete model.trail;
  scaleModel(model, ROLE_SIZE[role]);
  groundGuard(model);
  const name = cleanText(keywordName(text), 64) || baseName;
  const rnd = mulberry32(req.seed);
  const creature: Creature = {
    id: `crt_${hashString(`${req.seed}|${text}`).toString(36)}`,
    name,
    flavor: CREATURE_FLAVORS[Math.floor(rnd() * CREATURE_FLAVORS.length)],
    role,
    blueprint: toBlueprint(model, { kind: "creature", frame: "object", name, maxParts: env.maxParts, source: "procedural", seed: req.seed, tags: [element, role] }),
    stats: creatureStats(env.options.creatureStats, role, req.seed),
    behaviour: gameBehaviour(env, behaviour),
    tags: [element, role, ...contentWords(headNoun(text)).slice(0, 1)],
  };
  if (!isPhysical(element) || role === "boss" || role === "elite") {
    creature.vfx = buildVfx({ intent: "aura", element, scale: ROLE_SIZE[role] * 0.5, density: role === "boss" ? 1.2 : 0.6, attach: "vfx_core", seed: req.seed, name: `${name} aura` });
  }
  return creature;
}

/** The LLM's compact creature / prop shape -> a grounded model (null when unusable). */
export function shapedModel(raw: unknown, element: string, style: unknown, length: number): RawModel | null {
  const sh = expandShape(raw, element);
  let m = sh ? clampRawModel(sh, BLUEPRINT_ROLES, BLUEPRINT_SHAPES, ANIM_KINDS, PARTICLE_KINDS) : null;
  if (!m) return null;
  if (isObj(style)) m = applyStyle(m, { ...style, p: [], x: [] }, length);
  delete m.trail;
  return m;
}

/** LLM creature answer -> Creature (clamped; the role's power caps the stats). */
export function creatureFromLlm(env: ForgeEnv, raw: unknown, req: { prompt: string; role?: CreatureRole; seed: number }, fallback: Creature): Creature | null {
  if (!isObj(raw)) return null;
  const role = req.role ?? (CREATURE_ROLES.includes(raw.role as CreatureRole) ? (raw.role as CreatureRole) : fallback.role);
  const element = typeof raw.element === "string" ? resolveElement(env, req.prompt, raw.element) : resolveElement(env, req.prompt);
  const name = cleanText(raw.name, 64) || fallback.name;
  let model = shapedModel(raw.shape, element, raw.style, ROLE_SIZE[role]);
  let source: "llm" | "procedural" = "llm";
  if (!model) {
    model = creatureModel(`${name} ${req.prompt}`, element, (SUMMON_BEHAVIOURS as readonly string[]).includes(String(raw.behaviour)) ? (raw.behaviour as SummonBehaviour) : "charge", req.seed).model;
    source = "procedural";
  }
  scaleModel(model, ROLE_SIZE[role]);
  groundGuard(model);
  const behaviourRaw = typeof raw.behaviour === "string" ? raw.behaviour.trim().toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 32) : "";
  const creature: Creature = {
    id: fallback.id,
    name,
    flavor: cleanText(raw.flavor, 240) || fallback.flavor,
    role,
    blueprint: toBlueprint(model, { kind: "creature", frame: "object", name, maxParts: env.maxParts, source, seed: req.seed, tags: [element, role] }),
    stats: creatureStats(env.options.creatureStats, role, req.seed, raw.stats),
    behaviour: gameBehaviour(env, behaviourRaw || fallback.behaviour),
    tags: [element, role],
  };
  if (fallback.vfx) creature.vfx = buildVfx({ intent: "aura", element, scale: ROLE_SIZE[role] * 0.5, attach: "vfx_core", seed: req.seed, name: `${name} aura` });
  return creature;
}

// ------------------------------------------------------------------------------------------------ props

const INTERACTABLE = /\b(chest|door|lever|switch|button|altar|shrine|anvil|forge|chair|bench|table|bed|crate|barrel|well|portal|gate|book|lectern|sign|bell|cart|boat|statue)s?\b/i;

/** Keyless prop: an arena-object archetype, a library object, or a seeded generic object. Stands on y = 0. */
export function forgePropRules(env: ForgeEnv, req: { prompt: string; seed: number }): Prop {
  const text = req.prompt.trim();
  const element = resolveElement(env, text);
  const arena = pickArchetype(text, "arena_object");
  let model: RawModel;
  let baseName: string;
  let size = 1.2;
  if (arena) {
    model = proceduralBlueprint(arena, element, req.seed);
    baseName = arena.name;
    size = arena.baseLength;
  } else {
    const design = findDesign(text) ?? summonDesignFor(text, "wall");
    model = summonBlueprint(design, element, req.seed);
    baseName = design.name;
  }
  delete model.trail;
  scaleModel(model, size * (/\b(huge|giant|massive|big|large)\b/i.test(text) ? 1.6 : /\b(tiny|small|little)\b/i.test(text) ? 0.6 : 1));
  groundGuard(model);
  const name = cleanText(keywordName(text), 64) || baseName;
  const prop: Prop = {
    id: `prp_${hashString(`${req.seed}|${text}`).toString(36)}`,
    name,
    blueprint: toBlueprint(model, { kind: "prop", frame: "object", name, maxParts: env.maxParts, source: "procedural", seed: req.seed, tags: [element] }),
    tags: [element, ...contentWords(headNoun(text)).slice(0, 1)],
    interactable: INTERACTABLE.test(text),
  };
  if (!isPhysical(element)) prop.vfx = buildVfx({ intent: "ambient", element, scale: size * 0.6, density: 0.5, attach: "vfx_core", seed: req.seed, light: true });
  return prop;
}

/** LLM prop answer -> Prop. */
export function propFromLlm(env: ForgeEnv, raw: unknown, req: { prompt: string; seed: number }, fallback: Prop): Prop | null {
  if (!isObj(raw)) return null;
  const element = typeof raw.element === "string" ? resolveElement(env, req.prompt, raw.element) : resolveElement(env, req.prompt);
  const name = cleanText(raw.name, 64) || fallback.name;
  const size = clampN(finOr(raw.size, 1.2), 0.2, 4);
  const model = shapedModel(raw.shape, element, raw.style, size);
  if (!model) return null;
  scaleModel(model, size);
  groundGuard(model);
  return {
    id: fallback.id,
    name,
    blueprint: toBlueprint(model, { kind: "prop", frame: "object", name, maxParts: env.maxParts, source: "llm", seed: req.seed, tags: [element] }),
    tags: [element, ...(Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string").map((t) => t.slice(0, 32)).slice(0, 4) : [])],
    interactable: typeof raw.interactable === "boolean" ? raw.interactable : fallback.interactable,
    ...(fallback.vfx ? { vfx: fallback.vfx } : {}),
  };
}

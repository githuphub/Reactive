// Items, armour pieces / sets and context loot (forge.item, forge.armour_set, forge.loot). Rules fast path =
// keyword + procedural (Counterforge's keyless forge, generalised to the manifest schema); the LLM upgrade's answer is
// turned into the same ForgedItem by itemFromStyle (compact style + clamps + grip guard).
import { BLUEPRINT_ROLES, BLUEPRINT_SHAPES, ANIM_KINDS, PARTICLE_KINDS, cleanText, type ForgedItem } from "@liveforge/protocol";
import type { ForgeEnv } from "./env.js";
import { archetypeById, type Archetype } from "./library/archetypes.js";
import { armourTemplate } from "./library/armour.js";
import { designFor, ensureHandle, expandShape, findDesign, improvisedBlueprint, shapeParticles } from "./library/objects.js";
import { applyStyle, proceduralBlueprint } from "./procedural.js";
import { centreGuard, gripGuard } from "./guards.js";
import { creativityEstimate, isRawPowerRequest, keywordElement, keywordName, pickArchetype } from "./keywords.js";
import { isPhysical, matchElement } from "./elements.js";
import { colourWords, materialWord } from "./looks.js";
import { buildVfx } from "./vfx.js";
import {
  clampStats, cleanTags, familyArchetype, familyTemplate, isArmourSlot, manifestFamilyFor, pickTags, promptSlotKind,
  rarityIndexOf, rollStats, slotFor, slotKind, type SlotKind,
} from "./schema.js";
import { clampN, clampRawModel, finOr, hashString, isObj, mulberry32, scaleModel, toBlueprint, type RawModel } from "./model.js";

export interface ItemRequest {
  /** Free text (player wish, or a synthesised loot / bake description). */
  prompt: string;
  family?: string;
  slot?: string;
  element?: string;
  /** Force a rarity (name or index), e.g. for loot. */
  rarity?: string | number;
  seed: number;
}

const FLAVORS = [
  "Forged in haste, but it holds an edge.", "Still warm from the anvil.", "It hums when nobody is listening.",
  "Somebody's masterpiece. Possibly yours.", "Heavier than it looks, lighter than it should be.",
  "The maker's mark has been scratched off.", "It remembers the hand that shaped it.",
];
const ARMOUR_FLAVORS = [
  "Fits like it was waiting for you.", "Dented in all the right places.", "Smells faintly of the forge.",
  "Someone polished this with care.", "Light enough to run in. Mostly.",
];

const title = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const idFor = (prefix: string, seed: number, salt = "") => `${prefix}_${(hashString(`${seed}|${salt}`) >>> 0).toString(36)}`;

/** Pick an element: the request's (matched to the manifest), else the prompt's, else the plain element. */
export function resolveElement(env: ForgeEnv, text: string, wanted?: string): string {
  return (wanted && matchElement(wanted, env.elements)) || keywordElement(text, env.elements);
}

/** Rarity index from creativity (raw-power requests stay at the bottom), clamped to the manifest's rarities. */
function rarityFromCreativity(env: ForgeEnv, creativity: number, rng: () => number): number {
  const n = env.schema.rarities.length;
  const base = creativity * (n - 1) * 0.85 + (rng() - 0.5) * 0.8;
  return Math.round(clampN(base, 0, n - 1));
}

function forcedRarity(env: ForgeEnv, r: string | number | undefined): number | null {
  if (typeof r === "number" && Number.isFinite(r)) return Math.round(clampN(r, 0, env.schema.rarities.length - 1));
  if (typeof r === "string") {
    const i = rarityIndexOf(env.schema, r);
    return i >= 0 ? i : null;
  }
  return null;
}

/** The model of an armour piece for a slot kind: template + element recolour + colour words, centred (worn frame). */
function armourModel(kind: Exclude<SlotKind, "weapon" | "offhand">, text: string, element: string, seed: number): { model: RawModel; arch: Archetype } {
  const arch = armourTemplate(kind, text);
  const model = proceduralBlueprint(arch, element, seed);
  const cols = colourWords(text);
  const mat = materialWord(text);
  const styled = cols.length || mat
    ? applyStyle(model, { p: [cols[0] ?? mat?.color ?? null, cols[1] ?? null, cols[2] ?? null].filter(Boolean), m: mat?.metalness }, arch.baseLength)
    : model;
  delete styled.trail;
  scaleModel(styled, arch.baseLength);
  return { model: centreGuard(styled), arch };
}

/** Infer the manifest slot for a request ("frost crown" -> the manifest's head slot). */
function resolveSlot(env: ForgeEnv, text: string, wanted?: string): { slot: string | undefined; armour: Exclude<SlotKind, "weapon" | "offhand"> | null } {
  const s = env.schema;
  if (wanted) {
    const slot = s.slots.find((x) => x.toLowerCase() === wanted.toLowerCase()) ?? wanted;
    const k = slotKind(slot);
    return { slot, armour: k === "weapon" || k === "offhand" ? null : k };
  }
  const k = promptSlotKind(text);
  if (k && k !== "weapon" && k !== "offhand") return { slot: slotFor(s, k) ?? undefined, armour: k };
  return { slot: undefined, armour: null };
}

/**
 * Keyless forge for one item (any slot). Weapons: the library archetype the prompt names within the manifest's
 * families (head-noun rule), else an improvised weapon when the prompt names a known thing ("a train"), else the
 * family default; armour: the slot template. Stats per the manifest schema and rarity budget, creativity rules
 * applied (raw power requests stay plain).
 */
export function forgeItemRules(env: ForgeEnv, req: ItemRequest): ForgedItem {
  const s = env.schema;
  const rng = mulberry32(req.seed ^ 0x1b873593);
  const text = (req.prompt || [req.element, req.family ?? req.slot ?? "weapon"].filter(Boolean).join(" ")).trim().slice(0, 400);
  const element = resolveElement(env, text, req.element);
  const rawPower = isRawPowerRequest(text);
  const creativity = rawPower && s.creativity.rawPowerPenalty ? 0.05 : Math.min(s.creativity.max, creativityEstimate(text));
  const rarityIndex = forcedRarity(env, req.rarity) ?? (rawPower && s.creativity.rawPowerPenalty ? 0 : rarityFromCreativity(env, creativity, rng));
  const power = 0.6 + 0.4 * creativity;
  const slotInfo = resolveSlot(env, text, req.slot);

  let model: RawModel;
  let family: string | undefined;
  let slot = slotInfo.slot;
  let bias = { damage: 25, speed: 25, range: 25, special: 25 };
  let baseName: string;
  let improvisedNoun: string | null = null;
  let template: string | null = null;
  const armour = !!slotInfo.armour && !(req.family && s.families.includes(req.family));

  if (armour && slotInfo.armour) {
    const a = armourModel(slotInfo.armour, text, element, req.seed);
    model = a.model;
    bias = a.arch.statBias;
    baseName = a.arch.name;
    family = s.families.find((f) => f.toLowerCase() === slotInfo.armour) ?? undefined;
  } else {
    const familyGiven = req.family ? s.families.find((f) => f.toLowerCase() === req.family!.toLowerCase()) : undefined;
    const templates = (familyGiven ? [familyGiven] : s.families).map(familyTemplate);
    let arch = pickArchetype(text, "held", templates);
    // a known everyday thing ("a train", "a chair") with no weapon named becomes an improvised weapon
    const design = !arch && !familyGiven && !pickArchetype(text, "held") ? findDesign(text) : null;
    if (design) {
      family = s.families.find((f) => familyTemplate(f) === design.family) ?? s.families[0];
      template = familyTemplate(family);
      const base = archetypeById(familyArchetype(family).id)!;
      model = improvisedBlueprint(design, element, req.seed, template);
      gripGuard(model, template);
      scaleModel(model, base.baseLength * 1.1);
      bias = base.statBias;
      baseName = design.name;
      improvisedNoun = design.name.toLowerCase();
    } else {
      const fromArch = arch ? manifestFamilyFor(s, arch) : null;
      family = familyGiven ?? fromArch ?? s.families[Math.floor(rng() * s.families.length) % s.families.length];
      template = familyTemplate(family);
      if (!arch || arch.family !== template) arch = familyArchetype(family);
      model = proceduralBlueprint(arch, element, req.seed);
      const cols = colourWords(text);
      const mat = materialWord(text);
      if (cols.length || mat) model = applyStyle(model, { p: [cols[0] ?? mat?.color, cols[1], cols[2]].filter(Boolean), m: mat?.metalness }, arch.baseLength);
      gripGuard(model, template);
      scaleModel(model, arch.baseLength);
      bias = arch.statBias;
      baseName = arch.name;
    }
    if (!slot) {
      const shieldy = template === "shield_small" || template === "shield_large" || template === "focus";
      slot = (shieldy ? slotFor(s, "offhand") : null) ?? slotFor(s, "weapon") ?? s.slots[0];
    }
  }

  const name = cleanText(req.prompt ? keywordName(req.prompt) : "", 64)
    || `${isPhysical(element) ? "" : `${title(element)} `}${baseName}`.trim();
  const stats = rollStats(s, { bias, armour, rarityIndex, power, seed: req.seed });
  const tags = pickTags(s, text, template);
  const flavor = (armour ? ARMOUR_FLAVORS : FLAVORS)[Math.floor(rng() * (armour ? ARMOUR_FLAVORS : FLAVORS).length)];
  const blueprint = toBlueprint(model, {
    kind: armour ? "armour" : "item", frame: armour ? "worn" : "held", name, maxParts: env.maxParts,
    source: "procedural", seed: req.seed, tags: [element, ...(family ? [family] : []), ...(slot ? [slot] : [])],
  });
  const item: ForgedItem = {
    id: idFor("itm", req.seed, text),
    name,
    flavor,
    ...(family ? { family } : {}),
    ...(slot ? { slot } : {}),
    rarity: s.rarities[rarityIndex],
    element,
    stats,
    tags,
    blueprint,
    creativity: Math.round(creativity * 100) / 100,
    meshPrompt: (improvisedNoun ? `${text} (an improvised weapon shaped like a ${improvisedNoun})` : text).slice(0, 400),
  };
  if (!isPhysical(element)) {
    item.vfx = buildVfx({ intent: armour ? "aura" : "ambient", element, scale: 0.35, density: 0.6, attach: "vfx_core", light: false, seed: req.seed, name: `${name} glow` });
  }
  return item;
}

// ------------------------------------------------------------------------------------------------ LLM answer -> item

/**
 * Turn the forge LLM's compact answer (ITEM json schema, untrusted) into a ForgedItem. The model is never
 * LLM-authored geometry for weapons: the archetype's procedural model restyled with the compact style; improvised
 * things use the LLM's compact shape (clamped, put on a handle, grip-guarded). Stats clamped to the manifest schema
 * and rarity budget; creativity capped by the manifest and the raw-power rule. Null when unusable.
 */
export function itemFromLlm(env: ForgeEnv, raw: unknown, req: ItemRequest, fallback: ForgedItem): ForgedItem | null {
  if (!isObj(raw)) return null;
  const s = env.schema;
  const text = req.prompt || fallback.meshPrompt || fallback.name;
  const element = (typeof raw.element === "string" && matchElement(raw.element, env.elements)) || fallback.element || resolveElement(env, text);
  const rawPower = s.creativity.rawPowerPenalty && isRawPowerRequest(text);
  let creativity = clampN(finOr(raw.creativity, fallback.creativity ?? 0.3), 0, s.creativity.max);
  if (rawPower) creativity = Math.min(creativity, 0.1);
  const n = s.rarities.length;
  const forced = forcedRarity(env, req.rarity);
  const wantedRarity = rarityIndexOf(s, raw.rarity);
  const rarityIndex = forced ?? Math.round(clampN(Math.min(wantedRarity < 0 ? 0 : wantedRarity, Math.round(creativity * (n - 1)) + 1, rawPower ? 0 : n - 1), 0, n - 1));
  const name = cleanText(raw.name, 64) || fallback.name;
  const flavor = cleanText(raw.flavor, 240) || fallback.flavor;
  const meshPrompt = cleanText(raw.meshPrompt, 400) || fallback.meshPrompt || text;
  const kind = raw.kind === "armour" || raw.kind === "improvised" ? raw.kind : "weapon";
  const slotRaw = typeof raw.slot === "string" ? s.slots.find((x) => x.toLowerCase() === raw.slot!.toString().toLowerCase()) : undefined;
  const familyRaw = typeof raw.family === "string" ? s.families.find((x) => x.toLowerCase() === raw.family!.toString().toLowerCase()) : undefined;
  const style = isObj(raw.style) ? raw.style : null;

  let model: RawModel;
  let family = familyRaw ?? fallback.family;
  let slot = slotRaw ?? fallback.slot;
  let armour = kind === "armour" || (!!slot && isArmourSlot(slot) && kind !== "improvised");
  let source: "styled" | "improvised" = "styled";
  if (armour) {
    const k = slot ? slotKind(slot) : promptSlotKind(`${name} ${meshPrompt}`) ?? "chest";
    const sk = (k === "weapon" || k === "offhand" ? "chest" : k) as Exclude<SlotKind, "weapon" | "offhand">;
    slot = slot && isArmourSlot(slot) ? slot : slotFor(s, sk) ?? slot;
    const arch = armourTemplate(sk, `${name} ${meshPrompt}`);
    model = proceduralBlueprint(arch, element, req.seed);
    if (style) model = applyStyle(model, style, arch.baseLength);
    delete model.trail;
    scaleModel(model, arch.baseLength);
    centreGuard(model);
  } else {
    family = family ?? s.families[0];
    const template = familyTemplate(family);
    const base = familyArchetype(family);
    let shaped: RawModel | null = null;
    if (kind === "improvised") {
      const sh = expandShape(raw.shape, element);
      shaped = sh ? clampRawModel(sh, BLUEPRINT_ROLES, BLUEPRINT_SHAPES, ANIM_KINDS, PARTICLE_KINDS) : null;
      if (shaped) {
        shaped.particles ??= shapeParticles(element);
        if (style) shaped = applyStyle(shaped, { ...style, p: [], x: [] }, base.baseLength);
        shaped.trail ??= { color: shaped.palette[1] ?? "#ffffff", width: 0.12 };
        ensureHandle(shaped, template);
        source = "improvised";
      } else {
        const noun = typeof raw.noun === "string" && raw.noun !== "none" ? raw.noun : "";
        shaped = improvisedBlueprint(designFor(noun || text), element, req.seed, template);
        source = "improvised";
      }
      model = shaped;
      scaleModel(model, base.baseLength * 1.1);
    } else {
      const named = archetypeById(raw.archetype);
      const arch = named && !named.category && named.family === template
        ? named
        : pickArchetype(`${name} ${meshPrompt}`, "held", [template]) ?? base;
      model = proceduralBlueprint(arch, element, req.seed);
      if (style) model = applyStyle(model, style, arch.baseLength);
      scaleModel(model, arch.baseLength);
    }
    gripGuard(model, template);
    if (!slot || isArmourSlot(slot)) {
      const shieldy = template === "shield_small" || template === "shield_large";
      slot = (shieldy ? slotFor(s, "offhand") : null) ?? slotFor(s, "weapon") ?? s.slots[0];
    }
    armour = false;
  }
  const blueprint = toBlueprint(model, {
    kind: armour ? "armour" : "item", frame: armour ? "worn" : "held", name, maxParts: env.maxParts,
    source, seed: req.seed, tags: [element, ...(family ? [family] : []), ...(slot ? [slot] : [])],
  });
  const item: ForgedItem = {
    id: fallback.id,
    name,
    flavor,
    ...(family && !armour ? { family } : fallback.family && armour ? { family: fallback.family } : {}),
    ...(slot ? { slot } : {}),
    rarity: s.rarities[rarityIndex],
    element,
    stats: clampStats(s, raw.stats, rarityIndex),
    tags: cleanTags(s, raw.tags),
    blueprint,
    creativity: Math.round(creativity * 100) / 100,
    meshPrompt,
  };
  if (!isPhysical(element)) {
    item.vfx = buildVfx({ intent: armour ? "aura" : "ambient", element, colors: style && Array.isArray(style.p) ? [String(style.p[0] ?? ""), String(style.e ?? ""), String(style.p[2] ?? "")] : undefined, scale: 0.35, density: 0.6, attach: "vfx_core", light: false, seed: req.seed, name: `${name} glow` });
  }
  return item;
}

// ------------------------------------------------------------------------------------------------ armour sets

export interface ArmourSet { name: string; pieces: ForgedItem[]; setBonus?: { description: string; stats: Record<string, number> } }

/** The armour slots of the manifest (or the requested ones). */
export function armourSlots(env: ForgeEnv, wanted?: string[]): string[] {
  const all = env.schema.slots.filter(isArmourSlot);
  if (wanted?.length) {
    const picked = wanted.map((w) => env.schema.slots.find((s) => s.toLowerCase() === w.toLowerCase()) ?? w).filter(isArmourSlot);
    if (picked.length) return [...new Set(picked)].slice(0, 8);
  }
  return (all.length ? all : ["head", "chest", "hands", "legs", "feet"]).slice(0, 8);
}

const PIECE_WORD: Record<string, string> = { head: "Helm", chest: "Cuirass", shoulders: "Pauldrons", back: "Cloak", hands: "Gauntlets", legs: "Greaves", feet: "Boots", waist: "Belt", trinket: "Amulet" };

/** Keyless armour set: one themed piece per slot sharing element, palette words and a set name. */
export function forgeArmourSetRules(env: ForgeEnv, prompt: string, slots: string[], seed: number): ArmourSet {
  const text = prompt.trim();
  const element = resolveElement(env, text);
  const theme = keywordName(text.replace(/\b(armou?r|set|suit|of|the|a|an)\b/gi, " ")) || title(element);
  const rarity = Math.min(env.schema.rarities.length - 1, Math.round(creativityEstimate(text) * (env.schema.rarities.length - 1) * 0.7));
  const pieces = slots.map((slot, i) => {
    const kind = slotKind(slot);
    const item = forgeItemRules(env, { prompt: `${text} ${kind === "trinket" ? "amulet" : ""}`.trim(), slot, element, rarity, seed: (seed + i * 7919) >>> 0 });
    item.name = cleanText(`${theme} ${PIECE_WORD[kind] ?? title(slot)}`, 64);
    item.id = idFor("arm", seed, `${slot}|${i}`);
    return item;
  });
  return { name: cleanText(`${theme} Set`, 64), pieces, setBonus: setBonusFor(env, pieces.length, rarity) };
}

/** A small set bonus: +10 % of each stat's range on the strongest two stats, per piece beyond the second. */
export function setBonusFor(env: ForgeEnv, count: number, rarityIndex: number): ArmourSet["setBonus"] {
  const names = Object.keys(env.schema.stats);
  if (count < 2 || !names.length) return undefined;
  const stats: Record<string, number> = {};
  for (const n of names.slice(0, 2)) {
    const r = env.schema.stats[n];
    const v = (r.max - r.min) * 0.05 * (count - 1) * (1 + rarityIndex * 0.25);
    stats[n] = Number.isInteger(r.min) ? Math.max(1, Math.round(v)) : Math.round(v * 100) / 100;
  }
  return { description: `Wear ${count} pieces: ${names.slice(0, 2).join(" and ")} up.`, stats };
}

// ------------------------------------------------------------------------------------------------ loot

export interface LootContext { enemy?: string; zone?: string; moment?: string; elite?: boolean; boss?: boolean; element?: string }

const LOOT_NOUNS = ["blade", "charm", "band", "edge", "fang", "relic", "trophy", "keepsake"];

/** Themed loot description from what was defeated / where / the moment. */
export function lootPrompt(ctx: LootContext, i: number, rng: () => number): string {
  const enemy = (ctx.enemy ?? "").replace(/[_-]+/g, " ").trim();
  const zone = (ctx.zone ?? "").replace(/[_-]+/g, " ").trim();
  const moment = (ctx.moment ?? "").replace(/[_-]+/g, " ").trim();
  const parts = [
    enemy ? `${enemy}'s ${LOOT_NOUNS[(i + Math.floor(rng() * LOOT_NOUNS.length)) % LOOT_NOUNS.length]}` : `${zone || "wanderer"} ${LOOT_NOUNS[i % LOOT_NOUNS.length]}`,
    zone && enemy ? `from the ${zone}` : "",
    moment ? `earned by a ${moment}` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

/**
 * Keyless context loot: `count` items themed on the fight (enemy / zone / moment), rarity boosted for elites and
 * bosses (forge options lootRarityBoost), families and slots spread over the manifest schema.
 */
export function forgeLootRules(env: ForgeEnv, ctx: LootContext, count: number, seed: number): ForgedItem[] {
  const rng = mulberry32(seed ^ 0x6a09e667);
  const n = env.schema.rarities.length;
  const boost = (ctx.boss ? env.options.lootRarityBoost.boss : 0) + (ctx.elite ? env.options.lootRarityBoost.elite : 0);
  const items: ForgedItem[] = [];
  for (let i = 0; i < count; i++) {
    const roll = rng();
    const base = roll < 0.55 ? 0 : roll < 0.82 ? 1 : roll < 0.95 ? 2 : 3;
    const rarity = Math.min(n - 1, base + boost);
    const armourPick = rng() < 0.35 ? armourSlots(env)[Math.floor(rng() * armourSlots(env).length)] : undefined;
    const family = armourPick ? undefined : env.schema.families[Math.floor(rng() * env.schema.families.length)];
    const prompt = lootPrompt(ctx, i, rng);
    const item = forgeItemRules(env, { prompt, family, slot: armourPick, element: ctx.element, rarity, seed: (seed + i * 104729) >>> 0 });
    item.id = idFor("loot", seed, `${i}|${prompt}`);
    items.push(item);
  }
  return items;
}

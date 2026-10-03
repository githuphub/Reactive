// Armour templates per slot kind. Head / chest / shoulders / back reuse the Counterforge armour archetypes (crown,
// helmet, breastplate, pauldron, cape); legs / feet / waist / trinkets / gloves are authored here in the same style.
// Worn frame: centred on the origin (the SDK attaches the piece to the slot's bone / socket).
import type { AnimKind, BlueprintRole, BlueprintShape } from "@liveforge/protocol";
import { ARCHETYPES, archetypeById, type Archetype } from "./archetypes.js";
import { pickArchetype } from "../keywords.js";
import type { SlotKind } from "../schema.js";
import type { RawPart, Vec3 } from "../model.js";

const H = Math.PI / 2;
type Anim = [AnimKind, number, number];
function P(role: BlueprintRole, shape: BlueprintShape, size: Vec3, offset: Vec3, color: string, o: { rot?: Vec3; e?: string; a?: Anim; mx?: "x" | "z"; m?: number } = {}): RawPart {
  const p: RawPart = { role, shape, size: size.map((v) => Math.max(0.01, v)) as Vec3, offset, rotation: o.rot ?? [0, 0, 0], color };
  if (o.e) { p.emissive = o.e; p.emissiveIntensity = 1.2; }
  if (o.a) p.anim = { kind: o.a[0], speed: o.a[1], amount: o.a[2] };
  if (o.mx) p.mirror = o.mx;
  if (o.m !== undefined) p.metalness = o.m;
  return p;
}
const K = { steel: "#c9d2dc", steel2: "#9ba8b6", iron: "#6f7883", leather: "#7b4526", leather2: "#4b2a17", gold: "#f5c542", red: "#d62839", blue: "#2f6fde", cloth: "#8e1b2e" };

function T(id: string, name: string, keywords: string, baseLength: number, parts: RawPart[], palette: string[]): Archetype {
  return {
    id, name, family: "fist", keywords: keywords.split("|"), baseLength, category: "armour",
    defaultBlueprint: { parts, palette }, statBias: { damage: 10, speed: 25, range: 15, special: 50 },
  };
}

/** Extra armour templates (not in the Counterforge library). */
export const EXTRA_ARMOUR: readonly Archetype[] = [
  T("greaves", "Greaves", "greaves|leggings|cuisses|trousers|pants", 0.9, [
    P("greave", "box", [0.13, 0.42, 0.14], [0.11, 0.2, 0], K.steel2, { mx: "x", m: 0.7 }),
    P("greave", "box", [0.12, 0.38, 0.13], [0.11, -0.22, 0.01], K.steel2, { mx: "x", m: 0.7 }),
    P("plate", "sphere", [0.12, 0.1, 0.08], [0.11, 0, 0.07], K.iron, { mx: "x" }),
    P("belt", "box", [0.36, 0.06, 0.18], [0, 0.44, 0], K.leather),
  ], [K.steel2, K.iron, K.gold]),
  T("boots", "Boots", "boots|boot|shoes|sabatons|sandals", 0.4, [
    P("boot", "box", [0.11, 0.26, 0.12], [0.1, 0.1, 0], K.leather, { mx: "x" }),
    P("boot", "box", [0.12, 0.08, 0.24], [0.1, -0.05, 0.06], K.leather2, { mx: "x" }),
    P("trim", "torus", [0.13, 0.13, 0.02], [0.1, 0.22, 0], K.gold, { rot: [H, 0, 0], mx: "x" }),
    P("plate", "box", [0.1, 0.1, 0.03], [0.1, 0.06, 0.07], K.steel2, { mx: "x" }),
  ], [K.leather, K.leather2, K.gold]),
  T("belt", "Belt", "belt|sash|girdle", 0.4, [
    P("belt", "torus", [0.36, 0.3, 0.05], [0, 0, 0], K.leather, { rot: [H, 0, 0] }),
    P("trim", "box", [0.08, 0.07, 0.03], [0, 0, 0.16], K.gold, { m: 0.9 }),
    P("decor", "box", [0.06, 0.1, 0.04], [0.14, -0.05, 0.08], K.leather2, { mx: "x" }),
  ], [K.leather, K.gold, K.leather2]),
  T("amulet", "Amulet", "amulet|necklace|pendant|talisman|charm|brooch|relic", 0.25, [
    P("string", "torus", [0.2, 0.24, 0.01], [0, 0.08, 0], K.gold),
    P("frame", "octahedron", [0.07, 0.09, 0.03], [0, -0.06, 0.01], K.gold, { m: 0.9 }),
    P("gem", "octahedron", [0.05, 0.065, 0.03], [0, -0.06, 0.02], K.red, { e: K.red, a: ["pulse", 2, 0.2] }),
  ], [K.gold, K.red, K.steel]),
  T("ring", "Ring", "ring|band|signet|earring", 0.06, [
    P("ring", "torus", [0.05, 0.05, 0.012], [0, 0, 0], K.gold, { m: 0.95 }),
    P("gem", "octahedron", [0.016, 0.018, 0.012], [0, 0.026, 0], K.blue, { e: K.blue, a: ["pulse", 2, 0.2] }),
  ], [K.gold, K.blue, K.steel]),
  T("gloves", "Gloves", "gloves|glove|bracers|vambraces|mitts", 0.3, [
    P("gauntlet", "box", [0.09, 0.14, 0.05], [0.12, 0, 0], K.leather, { mx: "x" }),
    P("gauntlet", "cylinder", [0.08, 0.12, 0.08], [0.12, -0.12, 0], K.leather2, { mx: "x" }),
    P("plate", "box", [0.08, 0.05, 0.03], [0.12, 0.03, 0.035], K.steel2, { mx: "x" }),
    P("trim", "torus", [0.09, 0.09, 0.015], [0.12, -0.18, 0], K.gold, { rot: [H, 0, 0], mx: "x" }),
  ], [K.leather, K.steel2, K.gold]),
];
const EXTRA_BY_ID = new Map(EXTRA_ARMOUR.map((a) => [a.id, a]));

/** Default template per armour slot kind. */
const SLOT_DEFAULT: Record<Exclude<SlotKind, "weapon" | "offhand">, string> = {
  head: "helmet", chest: "breastplate", shoulders: "pauldron", back: "cape", hands: "gloves", legs: "greaves",
  feet: "boots", waist: "belt", trinket: "amulet",
};

const ALL_ARMOUR: readonly Archetype[] = [...ARCHETYPES.filter((a) => a.category === "armour"), ...EXTRA_ARMOUR];
const KW_SLOT: Record<string, Exclude<SlotKind, "weapon" | "offhand">> = {
  crown: "head", helmet: "head", breastplate: "chest", pauldron: "shoulders", cape: "back", greaves: "legs", boots: "feet",
  belt: "waist", amulet: "trinket", ring: "trinket", gloves: "hands",
};

/**
 * The armour template for a slot: the archetype the prompt names when it fits the slot ("frost crown" on head ->
 * crown), else the slot default.
 */
export function armourTemplate(slot: Exclude<SlotKind, "weapon" | "offhand">, text: string): Archetype {
  const named = pickArchetype(text, "armour");
  if (named && KW_SLOT[named.id] === slot) return named;
  for (const a of EXTRA_ARMOUR) {
    if (KW_SLOT[a.id] === slot && a.keywords.some((k) => new RegExp(`\\b${k}s?\\b`, "i").test(text))) return a;
  }
  const id = SLOT_DEFAULT[slot];
  return archetypeById(id) ?? EXTRA_BY_ID.get(id) ?? ALL_ARMOUR[0];
}

/** Armour / accessory template a free text names (npc accessories: "a horned helm" -> helmet), or null. */
export function accessoryTemplate(text: string): Archetype | null {
  const named = pickArchetype(text, "armour");
  if (named) return named;
  for (const a of EXTRA_ARMOUR) if (a.keywords.some((k) => new RegExp(`\\b${k}s?\\b`, "i").test(text))) return a;
  return null;
}

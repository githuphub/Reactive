// Core rules stubs: a valid, deterministic instant answer for every ask kind, used when the owning module is
// disabled, doesn't implement the kind yet, or its instant() threw. Lanes replace these with real fast-paths.
import {
  cleanHabits, composeMove, hashString, mulberry32,
  type AskKind, type AskParams, type AskResult, type Blueprint, type BlueprintPart, type ForgedItem, type VfxRecipe,
} from "@liveforge/protocol";
import { personaById, type Manifest } from "@liveforge/manifest";

const ELEMENT_COLORS: Record<string, [string, string, string]> = {
  fire: ["#ff7a3d", "#5a2412", "#ffd23f"],
  ice: ["#c9f6ff", "#2c5b85", "#ffffff"],
  lightning: ["#fff4a0", "#3a2f6b", "#9b7bff"],
  physical: ["#d5dee8", "#8e1b2e", "#f5c542"],
};
const paletteFor = (element: string | undefined, rng: () => number): string[] => {
  const p = ELEMENT_COLORS[(element ?? "").toLowerCase()];
  if (p) return [...p];
  const h = Math.floor(rng() * 360);
  const hsl = (hh: number, s: number, l: number) => {
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + hh / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, "0");
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  };
  return [hsl(h, 0.55, 0.6), hsl((h + 30) % 360, 0.4, 0.25), hsl((h + 180) % 360, 0.6, 0.55)];
};

/** A small, valid procedural blueprint (handle + head + guard + gem) for stand-ins. K3 replaces with real forging. */
export function stubBlueprint(kind: Blueprint["kind"], seed: number, element?: string): Blueprint {
  const rng = mulberry32(seed);
  const palette = paletteFor(element, rng);
  const len = 0.6 + rng() * 0.6;
  const parts: BlueprintPart[] =
    kind === "item"
      ? [
          { role: "handle", shape: "cylinder", size: [0.05, 0.3, 0.05], offset: [0, 0.15, 0], rotation: [0, 0, 0], material: { color: palette[1], roughness: 0.8 } },
          { role: "guard", shape: "box", size: [0.25, 0.04, 0.06], offset: [0, 0.32, 0], rotation: [0, 0, 0], material: { color: palette[2], metalness: 0.6 } },
          { role: "blade", shape: "wedge", size: [0.1, len, 0.03], offset: [0, 0.34 + len / 2, 0], rotation: [0, 0, 0], material: { color: palette[0], metalness: 0.5, roughness: 0.3 } },
          { role: "gem", shape: "octahedron", size: [0.05, 0.05, 0.05], offset: [0, 0.32, 0.035], rotation: [0, 0, 0], material: { color: palette[2], emissive: palette[0], emissiveIntensity: 1.2 }, anim: { kind: "pulse", speed: 2, amount: 0.3 } },
        ]
      : kind === "creature"
        ? [
            { role: "torso", shape: "capsule", size: [0.6, 0.9, 0.5], offset: [0, 0.8, 0], rotation: [0, 0, 0], material: { color: palette[0] } },
            { role: "head", shape: "sphere", size: [0.4, 0.4, 0.4], offset: [0, 1.45, 0.05], rotation: [0, 0, 0], material: { color: palette[0] } },
            { role: "eye", shape: "sphere", size: [0.07, 0.07, 0.07], offset: [0.1, 1.5, 0.22], rotation: [0, 0, 0], material: { color: "#ffffff", emissive: palette[2], emissiveIntensity: 1.5 }, mirror: "x" },
            { role: "leg", shape: "cylinder", size: [0.15, 0.5, 0.15], offset: [0.15, 0.25, 0], rotation: [0, 0, 0], material: { color: palette[1] }, mirror: "x" },
          ]
        : [
            { role: "base", shape: "box", size: [0.6, 0.1, 0.6], offset: [0, 0.05, 0], rotation: [0, 0, 0], material: { color: palette[1] } },
            { role: "body", shape: kind === "glyph" ? "torus" : "cylinder", size: [0.4, 0.6, 0.4], offset: [0, 0.4, 0], rotation: [0, 0, 0], material: { color: palette[0] } },
            { role: "crystal", shape: "icosahedron", size: [0.2, 0.2, 0.2], offset: [0, 0.85, 0], rotation: [0, 0, 0], material: { color: palette[2], emissive: palette[2], emissiveIntensity: 1 }, anim: { kind: "float", speed: 1, amount: 0.2 } },
          ];
  return {
    v: 1, kind, parts, palette,
    attachments: kind === "item" ? [{ name: "grip", position: [0, 0.15, 0], kind: "grip" }, { name: "tip", position: [0, 0.34 + len, 0], kind: "tip" }] : [],
    source: "procedural", seed, lod: { detail: "low" },
    ...(element ? { tags: [element] } : {}),
  };
}

export function stubVfx(seed: number, element?: string): VfxRecipe {
  const rng = mulberry32(seed);
  const [c0, , c2] = paletteFor(element, rng);
  return {
    v: 1, name: "ember motes", emitters: [{
      shape: "sphere", radius: 0.2, rate: 16, maxParticles: 48, lifetime: [0.6, 1.2],
      velocity: { dir: [0, 1, 0], speed: [0.2, 0.6], spread: 0.4 }, gravity: -0.5,
      colorRamp: [{ t: 0, color: c2, alpha: 1 }, { t: 1, color: c0, alpha: 0 }],
      sizeCurve: [{ t: 0, size: 0.05 }, { t: 1, size: 0 }], sprite: "mote", blend: "additive",
    }],
    lights: [{ color: c0, intensity: 1, range: 2 }],
  };
}

function stubItem(m: Manifest, seed: number, opts: { family?: string; slot?: string; element?: string; name?: string }): ForgedItem {
  const rng = mulberry32(seed);
  const families = m.items?.families ?? ["sword"];
  const family = opts.family && families.includes(opts.family) ? opts.family : families[Math.floor(rng() * families.length)];
  const element = opts.element ?? m.elements[Math.floor(rng() * m.elements.length)];
  const stats: Record<string, number> = {};
  for (const [k, b] of Object.entries(m.items?.stats ?? { damage: { min: 1, max: 10 } })) {
    const d = (b as { min: number; max: number; default?: number }).default;
    stats[k] = Math.round(d ?? b.min + (b.max - b.min) * (0.3 + rng() * 0.3));
  }
  const adj = ["Plain", "Sturdy", "Worn", "Keen", "Old"][Math.floor(rng() * 5)];
  return {
    id: `item_${seed.toString(36)}`,
    name: opts.name ?? `${adj} ${family.replace(/_/g, " ")}`,
    flavor: "A serviceable piece, forged by rote.",
    family, slot: opts.slot ?? "weapon", rarity: m.items?.rarities[0] ?? "common", element, stats, tags: [element],
    blueprint: stubBlueprint("item", seed, element), creativity: 0,
  };
}

const seedOf = (p: { seed?: number } & Record<string, unknown>, kind: string, player: string) => p.seed ?? hashString(`${kind}:${player}:${JSON.stringify(p)}`);

/** Deterministic rules stub for every ask kind. */
export function fallbackAnswer<K extends AskKind>(kind: K, params: AskParams<K>, m: Manifest, player: string): { result: AskResult<K>; why: string } {
  const p = params as Record<string, unknown> & { seed?: number };
  const seed = seedOf(p, kind, player);
  const rng = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length) % xs.length];
  const r = (result: unknown, why: string) => ({ result: result as AskResult<K>, why });

  switch (kind) {
    case "npc.bark": {
      const persona = personaById(m, String(p.npc));
      const pool = [...(persona?.barks ?? []), ...(persona?.greeting ? [persona.greeting] : [])];
      return r({ npc: p.npc, text: pool.length ? pick(pool) : "Hm.", actions: [], voice: persona?.voice }, "seed bark pool");
    }
    case "npc.reply": {
      const persona = personaById(m, String(p.npc));
      return r({ npc: p.npc, text: persona ? `${persona.greeting ?? "Mm."}` : "...", actions: [], voice: persona?.voice }, "no conversation engine yet: greeting");
    }
    case "director.boss_phase": {
      const boss = m.bosses.find((b) => b.id === p.boss);
      const moves = (boss?.moves ?? []).map((id) => ({ engine: { moveId: id, params: {} }, weight: 1 / Math.max(1, boss!.moves.length) }));
      const d = m.clamps.difficulty;
      return r({ boss: p.boss, phase: p.phase, moves, aggression: Math.min(d.aggressionMax, d.aggressionMin + 0.15 * Number(p.phase)), counters: [] }, "default phase plan from the manifest");
    }
    case "director.boss_move": {
      const { move, habit } = composeMove(
        { phase: Number(p.phase) || 1, habits: cleanHabits(p.habits), existing: (p.existing as string[] | undefined) ?? [], attune: (p.attune as string | null | undefined) ?? null, seed },
        { elements: m.elements, damageScale: m.moves.damageScale },
      );
      return r({ boss: p.boss, move }, `player keeps ${habit}`);
    }
    case "director.encounter": {
      const tactics = ["flank", "rush", "hold", "kite", "surround"];
      const units = (p.units as { id: string }[]) ?? [];
      return r({ assignments: units.map((u, i) => ({ unit: u.id, tactic: tactics[i % tactics.length] })), modifiers: [], aggression: 0.5 }, "round-robin tactics");
    }
    case "director.pacing": {
      const intensity = typeof p.intensity === "number" ? p.intensity : 0.5;
      const action = intensity > 0.8 ? "breather" : intensity < 0.3 ? "spawn" : "hold";
      return r({ tension: intensity, action, directives: [] }, `intensity ${intensity.toFixed(2)} -> ${action}`);
    }
    case "forge.item":
      return r({ item: stubItem(m, seed, { family: p.family as string, slot: p.slot as string, element: p.element as string }) }, "procedural stand-in");
    case "forge.armour_set": {
      const slots = (p.slots as string[] | undefined) ?? ["head", "chest", "hands"];
      return r({ name: "Plain Set", pieces: slots.map((s, i) => ({ ...stubItem(m, seed + i, { slot: s }), blueprint: stubBlueprint("armour", seed + i) })) }, "procedural stand-in set");
    }
    case "forge.look":
      return r({ variant: { v: 1, baseAsset: String(p.asset), materialSwaps: [], recolour: [{ from: "primary", to: paletteFor(undefined, rng)[0] }] } }, "recolour stand-in");
    case "forge.vfx":
      return r({ vfx: stubVfx(seed) }, "default motes");
    case "forge.creature":
      return r({ creature: { id: `creature_${seed.toString(36)}`, name: "Wisp", flavor: "A curious little thing.", role: (p.role as string) ?? "minion", blueprint: stubBlueprint("creature", seed), stats: { hp: 30, damage: 5, speed: 3 }, behaviour: "charge", tags: [] } }, "procedural stand-in");
    case "forge.npc_look":
      return r({ npc: p.npc, accessories: [] }, "no change");
    case "forge.prop":
      return r({ prop: { id: `prop_${seed.toString(36)}`, name: "Curio", blueprint: stubBlueprint("prop", seed), tags: [] } }, "procedural stand-in");
    case "forge.loot": {
      const n = Number(p.count ?? 1);
      return r({ items: Array.from({ length: n }, (_, i) => stubItem(m, seed + i, {})) }, "procedural loot");
    }
    case "quest.offer":
      return r({ quest: null }, "no quest engine yet");
    case "achievement.check":
      return r({ unlocked: [] }, "no achievement engine yet");
    case "world.reactions":
      return r({ rumours: [], directives: [], attitudes: {} }, "no world engine yet");
  }
  return r({}, "unknown kind");
}

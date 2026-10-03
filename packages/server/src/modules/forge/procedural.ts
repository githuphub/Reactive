// Seeded procedural models (ported from Counterforge procedural.ts, MIT): the keyless model for any prompt.
// Same (archetype, element, seed) -> same model; different prompts -> different palettes and decorations. applyStyle
// restyles a model with the forge LLM's compact style (the "fast compact-style" upgrade: ~300 output tokens instead
// of a whole blueprint).
import { ANIM_KINDS, BLUEPRINT_SHAPES, PARTICLE_KINDS, type AnimKind, type BlueprintRole, type BlueprintShape } from "@liveforge/protocol";
import { archetypeById, type Archetype } from "./library/archetypes.js";
import { elementPalettes, elementParticles, isPhysical } from "./elements.js";
import {
  clampN, finOr, hexOrNull, HEX_RE as HEX, isObj, mixHex, mulberry32, oneOfS, partHalfExtents, partHalfHeight, r3, round3,
  type RawModel as ItemBlueprint, type RawPart as BlueprintPart, type Vec3,
} from "./model.js";

/** Accent roles the forge LLM may add through its style (style.x[].r). */
export const STYLE_ACCENT_ROLES = ["gem", "spike", "rune", "ring", "shard", "orb", "decor"] as const;
export type StyleAccentRole = (typeof STYLE_ACCENT_ROLES)[number];
/** Colour slots an accent may use: the three palette colours or the emissive colour. */
export const STYLE_COLOR_SLOTS = ["p0", "p1", "p2", "e"] as const;


/** Role groups (Counterforge roles + the Blueprint v1 armour / creature / prop roles). */
const PRIMARY: ReadonlySet<BlueprintRole> = new Set([
  "blade", "head", "spike", "barrel", "shard", "limb", "body", "plate", "helm", "pauldron", "gauntlet", "greave", "boot",
  "torso", "horn", "claw", "wing", "tail", "fin", "leg", "arm", "panel", "lid", "base",
]);
const GRIP: ReadonlySet<BlueprintRole> = new Set(["handle", "stock", "cloth", "belt", "cape"]);
const ACCENT: ReadonlySet<BlueprintRole> = new Set(["guard", "pommel", "rim", "ring", "decor", "trim", "visor", "frame"]);
const GLOW: ReadonlySet<BlueprintRole> = new Set(["gem", "orb", "rune", "eye", "crystal", "flame"]);

const MAX_PARTS = 24;
const BLUEPRINT_MAX_OFFSET = 2;

// ------------------------------------------------------------------------------------------------ proceduralBlueprint

interface Box { min: Vec3; max: Vec3 }
function partsBox(parts: BlueprintPart[]): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const r = Math.max(p.size[0], p.size[1], p.size[2]) / 2;
    for (let i = 0; i < 3; i++) {
      // rotated parts: use the half-diagonal on the non-axial axes (cheap, conservative)
      const h = p.rotation.some((v) => Math.abs(v) > 0.05) ? r : p.size[i] / 2;
      min[i] = Math.min(min[i], p.offset[i] - h);
      max[i] = Math.max(max[i], p.offset[i] + h);
      if (p.mirror === "x" && i === 0) { min[0] = Math.min(min[0], -p.offset[0] - h); max[0] = Math.max(max[0], -p.offset[0] + h); }
      if (p.mirror === "z" && i === 2) { min[2] = Math.min(min[2], -p.offset[2] - h); max[2] = Math.max(max[2], -p.offset[2] + h); }
    }
  }
  return { min, max };
}



/**
 * A coloured, animated variation of an archetype's default blueprint, fully determined by (archetype, element, seed):
 * palette from the element (one of several variants), role-based recolouring + emissive edges, and seeded extras
 * (gem, runes, orbiting shards, a spinning ring, spikes), particles and a trail. Never exceeds 24 parts.
 */
export function proceduralBlueprint(archetype: Archetype | string, element: string, seed: number): ItemBlueprint {
  const arch = typeof archetype === "string" ? archetypeById(archetype) ?? archetypeById("arming_sword")! : archetype;
  const rnd = mulberry32(seed ^ 0x9e3779b9);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length) % list.length];
  const chance = (p: number) => rnd() < p;
  const range = (lo: number, hi: number) => lo + (hi - lo) * rnd();

  const pal = pick(elementPalettes(element));
  const elemental = !isPhysical(element);
  const src: BlueprintPart[] = JSON.parse(JSON.stringify(arch.defaultBlueprint.parts));
  const tier2 = !!arch.category;
  const L = arch.baseLength;

  // 1. recolour by role (keep a little of the authored colour so the archetype stays recognisable)
  const kMetal = elemental ? range(0.35, 0.6) : range(0.25, 0.6);
  const kGrip = range(0.55, 0.85);
  const kAccent = range(0.5, 0.85);
  const edgeGlow = elemental ? range(0.5, 0.95) : chance(0.6) ? range(0.12, 0.3) : 0;
  const thick = range(0.92, 1.12);
  const parts: BlueprintPart[] = src.map((p) => {
    const q = { ...p, size: [...p.size] as Vec3, offset: [...p.offset] as Vec3, rotation: [...p.rotation] as Vec3 };
    if (PRIMARY.has(q.role)) {
      q.color = mixHex(q.color, pal.metal, kMetal);
      if (edgeGlow > 0 && !q.emissive && (q.role === "blade" || q.role === "head" || q.role === "shard")) {
        q.emissive = pal.glow;
        q.emissiveIntensity = round3(edgeGlow);
      }
      if (q.role === "blade" && q.shape === "wedge") { q.size[0] *= thick; q.size[2] *= thick; }
    } else if (GRIP.has(q.role)) {
      q.color = mixHex(q.color, pal.grip, kGrip);
    } else if (ACCENT.has(q.role)) {
      q.color = mixHex(q.color, pal.accent, kAccent);
    } else if (GLOW.has(q.role)) {
      q.color = mixHex(q.color, pal.glow, 0.7);
      q.emissive = pal.glow;
      q.emissiveIntensity = round3(range(1.2, 2.2));
      q.anim ??= { kind: chance(0.5) ? "pulse" : "flicker", speed: round3(range(1.5, 4)), amount: round3(range(0.12, 0.3)) };
    }
    q.size = r3(q.size);
    return q;
  });

  // 2. seeded extras, anchored on the archetype's own geometry
  const box = partsBox(parts);
  const tipY = box.max[1];
  const span = Math.max(box.max[1] - box.min[1], box.max[0] - box.min[0], 0.2);
  const guard = parts.find((p) => p.role === "guard") ?? parts.find((p) => p.role === "pommel");
  const blade = parts.filter((p) => p.role === "blade").sort((a, b) => b.size[1] - a.size[1])[0];
  const handle = parts.find((p) => p.role === "handle");
  const glowO = (ei: number) => ({ emissive: pal.glow, emissiveIntensity: round3(ei) });
  const room = () => parts.length < MAX_PARTS - 1;
  const s = (v: number) => round3(Math.max(0.012, v * Math.min(1.6, Math.max(0.5, L))));

  if (!tier2 && guard && room() && chance(0.75)) {
    const g = s(range(0.035, 0.055));
    parts.push({
      role: "gem", shape: pick(["octahedron", "icosahedron", "sphere"] as const), size: [g, g * 1.2, g * 0.6],
      offset: r3([guard.offset[0], guard.offset[1], guard.size[2] / 2 + g * 0.2]), rotation: [0, 0, 0],
      color: mixHex(pal.glow, "#ffffff", 0.25), ...glowO(range(1.4, 2.4)), mirror: "z",
      anim: { kind: "pulse", speed: round3(range(2, 4)), amount: round3(range(0.15, 0.3)) },
    });
  }
  if (blade && blade.size[1] > 0.12 && room() && chance(0.65)) {
    const n = 2 + Math.floor(rnd() * 2);
    for (let i = 0; i < n && room(); i++) {
      const y = blade.offset[1] - blade.size[1] * 0.3 + (blade.size[1] * 0.55 * i) / Math.max(1, n - 1);
      const w = Math.max(0.01, Math.min(blade.size[0] * 0.45, 0.05));
      parts.push({
        role: "rune", shape: pick(["octahedron", "box", "torus"] as const), size: r3([w, w * 1.3, 0.006]),
        offset: r3([blade.offset[0], y, blade.size[2] / 2 + 0.002]), rotation: blade.rotation.slice() as Vec3,
        color: pal.glow, ...glowO(range(1.5, 2.6)), mirror: "z",
        anim: { kind: chance(0.5) ? "pulse" : "flicker", speed: round3(range(2, 6)), amount: round3(range(0.2, 0.4)) },
      });
    }
  }
  if (room() && chance(tier2 ? 0.35 : 0.5)) {
    const n = 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < n && room(); i++) {
      const r = round3(span * range(0.14, 0.22));
      const sz = s(range(0.035, 0.06));
      parts.push({
        role: "shard", shape: pick(["octahedron", "icosahedron", "prism"] as const), size: [sz, sz * 1.8, sz],
        offset: r3([r, box.min[1] + (tipY - box.min[1]) * range(0.65, 0.95), 0]), rotation: [0, 0, 0],
        color: mixHex(pal.glow, pal.accent, 0.3), ...glowO(range(1.2, 2)),
        anim: { kind: "orbit", speed: round3(range(1.5, 3)), amount: r },
      });
    }
  }
  // A ring only around an axial handle (swords, shafts), never around a pistol grip.
  const axial = handle && handle.size[1] >= Math.max(handle.size[0], handle.size[2]) && handle.rotation.every((r) => Math.abs(r) < 0.05);
  if (!tier2 && handle && axial && room() && chance(0.4)) {
    const d = round3(Math.max(handle.size[0], handle.size[2]) * range(2.2, 3));
    parts.push({
      role: "ring", shape: "torus", size: [d, d, round3(Math.max(0.008, d * 0.12))],
      offset: r3([handle.offset[0], handle.offset[1] + handle.size[1] * range(0.1, 0.4), handle.offset[2]]), rotation: [Math.PI / 2, 0, 0],
      color: pal.accent, ...glowO(range(0.8, 1.6)),
      anim: { kind: chance(0.5) ? "spin" : "float", speed: round3(range(1.5, 3)), amount: round3(range(0.02, 0.05)) },
    });
  }
  const head = parts.find((p) => p.role === "head" || p.role === "guard");
  if (!tier2 && head && room() && chance(0.3)) {
    const c = s(range(0.03, 0.05));
    parts.push({
      role: "spike", shape: "cone", size: [c, c * 2.4, c], offset: r3([head.size[0] / 2 + c, head.offset[1], 0]),
      rotation: [0, 0, -Math.PI / 2], color: mixHex(pal.metal, "#ffffff", 0.2), mirror: "x",
      ...(elemental ? glowO(0.4) : {}),
    });
  }

  // 3. palette, particles, trail
  for (const p of parts) p.size = p.size.map((v) => Math.max(0.01, v)) as Vec3; // validator minimum
  const blueprint: ItemBlueprint = { parts: parts.slice(0, MAX_PARTS), palette: [pal.metal, pal.glow, pal.accent, pal.dark, pal.grip] };
  const baseTrail = arch.defaultBlueprint.trail;
  if (baseTrail || !tier2) blueprint.trail = { color: pal.glow, width: baseTrail?.width ?? round3(Math.min(0.3, 0.06 + L * 0.05)) };
  const baseParticles = arch.defaultBlueprint.particles;
  if (elemental || baseParticles || chance(0.4)) {
    blueprint.particles = {
      kind: elemental ? elementParticles(element) : baseParticles?.kind ?? "motes",
      color: pal.glow,
      rate: Math.round(elemental ? range(8, 16) : range(4, 9)),
    };
  }
  return blueprint;
}

// ------------------------------------------------------------------------------------------------ applyStyle


/** Clamp ranges for an LLM style (applyStyle). */
export const STYLE_LIMITS = { maxAccents: 4, minAccent: 0.02, maxEmissive: 3, maxSpeed: 10 } as const;

/** Roles whose animation the style's `an` / `sp` set (plus every accent the style adds). */
const STYLE_ANIM_ROLES: ReadonlySet<BlueprintRole> = new Set(["gem", "orb", "ring", "shard"]);
/** Roles that always glow (the style's `e` / `i` set their emissive). */
const STYLE_GLOW_ROLES: ReadonlySet<BlueprintRole> = new Set(["gem", "orb", "rune", "shard", "ring"]);
/** Roles the style's metalness applies to. */
const METAL_ROLES: ReadonlySet<BlueprintRole> = new Set([...PRIMARY, ...ACCENT]);
const ACCENT_SHAPE: Record<StyleAccentRole, BlueprintShape> = {
  gem: "octahedron", spike: "cone", rune: "box", ring: "torus", shard: "octahedron", orb: "sphere", decor: "box",
};

/** Animation amount for `kind` on `part` (the builder's units: orbit radius / float amplitude in metres, else 0-1). */
function styleAnimAmount(kind: AnimKind, part: BlueprintPart, length: number): number {
  switch (kind) {
    case "spin": return 0;
    case "pulse": return 0.25;
    case "float": return round3(clampN(0.04 * length, 0.01, 0.1));
    case "orbit":
      if (part.anim?.kind === "orbit" && part.anim.amount > 0.01) return part.anim.amount;
      return round3(clampN(Math.max(Math.hypot(part.offset[0], part.offset[2]), 0.08 * length), 0.05, 0.6));
    case "flicker": return 0.4;
    case "wobble": return 0.3;
  }
}

/**
 * Half width (X) / depth (Z) about the Y axis of the model's body at height y: the parts whose exact rotated AABB
 * (partHalfExtents) spans y, except floating satellites (orbiting parts and shards, which may have been restyled
 * from orbit to a static anim); 0 when none does. |offset| covers mirrored copies.
 */
export function sectionAt(parts: readonly BlueprintPart[], y: number): { hw: number; hd: number } {
  let hw = 0;
  let hd = 0;
  for (const p of parts) {
    if (p.anim?.kind === "orbit" || p.role === "shard") continue;
    const h = partHalfExtents(p);
    if (y < p.offset[1] - h[1] || y > p.offset[1] + h[1]) continue;
    hw = Math.max(hw, Math.abs(p.offset[0]) + h[0]);
    hd = Math.max(hd, Math.abs(p.offset[2]) + h[2]);
  }
  return { hw, hd };
}

/**
 * Restyles a (procedural) blueprint with the forge LLM's compact style (ItemStyle, untrusted). Pure + deterministic:
 * never mutates `base`, never throws, hostile input is clamped or ignored field by field (a missing / invalid field
 * keeps the base look).
 * - p[0..2] recolour by role: p0 main (blade / head / body / spike / barrel / limb / shard), p1 grip (handle / stock /
 *   cloth), p2 trim (guard / pommel / rim / ring / decor); only valid "#rrggbb" slots apply.
 * - e / i: glow colour + intensity 0-3 of the glowing roles (gem / orb / rune / shard / ring); other already-glowing
 *   parts (edge glow) take e at 0.4 x i (max 1). i = 0 turns the glow off.
 * - m: metalness 0-1 of the metal roles. pk: particle kind ("none" = no particles), coloured e (else p2).
 * - an / sp: animation kind + speed 0-10 of the gem / orb / ring / shard parts and of every accent ("none" = static);
 *   rings and parts on the Y axis never orbit (they spin instead), so a ring around a handle stays on it.
 * - x: up to 4 accents appended at y (0..1) along the model's own exact Y extent (= y x length for items modelled
 *   from y = 0 to the tip), on the +Y axis, against the exact rotated cross-section there (sectionAt): gems / runes /
 *   decor on both faces, spikes out to both sides, rings snug around the axis, shards / orbs beside it (an orb at
 *   y >= 0.9 caps the tip, at most at offset 2); no accent reaches below the grip end.
 *   Size z is clamped to 0.02 - 0.3 x length (0.06 - 0.6 m). The result never exceeds 24 parts.
 */
export function applyStyle(base: ItemBlueprint, style: unknown, length: number): ItemBlueprint {
  const bp: ItemBlueprint = JSON.parse(JSON.stringify(base));
  if (!isObj(style) || !Array.isArray(bp.parts)) return bp;
  const len = clampN(finOr(length, 1), 0.2, 3);
  const L = STYLE_LIMITS;

  const given = (Array.isArray(style.p) ? style.p.slice(0, 3) : []).map(hexOrNull);
  const [p0, p1, p2] = [given[0] ?? null, given[1] ?? null, given[2] ?? null];
  const e = hexOrNull(style.e);
  const i = typeof style.i === "number" && Number.isFinite(style.i) ? clampN(style.i, 0, L.maxEmissive) : null;
  const m = typeof style.m === "number" && Number.isFinite(style.m) ? clampN(style.m, 0, 1) : null;
  const an = style.an === "none" ? "none" : oneOfS(ANIM_KINDS, style.an);
  const sp = round3(clampN(finOr(style.sp, 2), 0, L.maxSpeed));
  const pk = style.pk === "none" ? "none" : oneOfS(PARTICLE_KINDS, style.pk);

  // base colours for each slot (procedural palette = [metal, glow, accent, dark, grip])
  const pal = bp.palette ?? [];
  const slot = {
    p0: p0 ?? pal[0] ?? "#b8c0c8",
    p1: p1 ?? pal[4] ?? pal[3] ?? pal[0] ?? "#5a3a22",
    p2: p2 ?? pal[2] ?? pal[0] ?? "#f5c542",
    e: e ?? pal[1] ?? pal[0] ?? "#ffffff",
  };

  const setGlow = (q: BlueprintPart, colour: string, intensity: number) => {
    if (intensity <= 0) { delete q.emissive; delete q.emissiveIntensity; return; }
    q.emissive = colour;
    q.emissiveIntensity = round3(intensity);
  };
  const setAnim = (q: BlueprintPart, kind: AnimKind | "none") => {
    if (kind === "none") { delete q.anim; return; }
    // rings and parts on the Y axis cannot orbit visibly (radius ~0): they spin instead
    const onAxis = Math.hypot(q.offset[0], q.offset[2]) < 0.01;
    const k: AnimKind = kind === "orbit" && (q.role === "ring" || onAxis) ? "spin" : kind;
    q.anim = { kind: k, speed: sp, amount: styleAnimAmount(k, q, len) };
  };

  // 1. recolour, glow, metalness, animation of the existing parts
  for (const q of bp.parts) {
    if (PRIMARY.has(q.role) && p0) q.color = mixHex(q.color, p0, 0.8);
    else if (GRIP.has(q.role) && p1) q.color = mixHex(q.color, p1, 0.75);
    else if (ACCENT.has(q.role) && p2) q.color = mixHex(q.color, p2, 0.8);
    if (STYLE_GLOW_ROLES.has(q.role)) {
      if (e) q.color = mixHex(e, "#ffffff", 0.2);
      if (e || i !== null) setGlow(q, e ?? q.emissive ?? slot.e, i ?? q.emissiveIntensity ?? 1.5);
    } else if (q.emissive && (e || i !== null)) {
      setGlow(q, e ?? q.emissive, i !== null ? Math.min(1, i * 0.4) : q.emissiveIntensity ?? 0.5);
    }
    if (m !== null && METAL_ROLES.has(q.role)) q.metalness = round3(m);
    if (an && STYLE_ANIM_ROLES.has(q.role)) setAnim(q, an);
  }

  // 2. accents along the +Y axis, placed against the model's own cross-section at that height
  const statics = bp.parts.slice();
  // exact rotated Y extent of the model (lo = the grip end for bottom-held items)
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of statics) {
    const hy = partHalfHeight(p);
    lo = Math.min(lo, p.offset[1] - hy);
    hi = Math.max(hi, p.offset[1] + hy);
  }
  if (!(Number.isFinite(lo) && Number.isFinite(hi) && hi > lo)) { lo = 0; hi = len; }
  const maxAccent = clampN(0.3 * len, 0.06, 0.6);
  const accents = Array.isArray(style.x) ? style.x.slice(0, L.maxAccents) : [];
  for (const a of accents) {
    if (bp.parts.length >= MAX_PARTS) break;
    if (!isObj(a)) continue;
    const role: StyleAccentRole = oneOfS(STYLE_ACCENT_ROLES, a.r) ?? "decor";
    const shape: BlueprintShape = role === "ring" ? "torus" : oneOfS(BLUEPRINT_SHAPES, a.s) ?? ACCENT_SHAPE[role];
    const glowy = STYLE_GLOW_ROLES.has(role);
    const cSlot = oneOfS(STYLE_COLOR_SLOTS, a.c) ?? (glowy ? "e" : "p2");
    const z = round3(clampN(finOr(a.z, 0.08), L.minAccent, maxAccent));
    const Y = lo + clampN(finOr(a.y, 0.5), 0, 1) * (hi - lo);
    const { hw, hd } = sectionAt(statics, Y);
    let q: BlueprintPart;
    switch (role) {
      case "spike":
        q = { role, shape, size: [z * 0.4, z, z * 0.4], offset: [hw + z * 0.45, Y, 0], rotation: [0, 0, -Math.PI / 2], color: slot[cSlot], mirror: "x" };
        break;
      case "ring": {
        // snug around the section: radius = section + 0.3 z, tube <= 0.4 z
        const d = Math.max(2 * Math.max(hw, hd) + 0.6 * z, z);
        q = { role, shape, size: [d, d, Math.max(0.01, Math.min(d * 0.12, z * 0.4))], offset: [0, Y, 0], rotation: [Math.PI / 2, 0, 0], color: slot[cSlot] };
        break;
      }
      case "shard":
        q = { role, shape, size: [z * 0.55, z, z * 0.55], offset: [hw + z * 0.8, Y, 0], rotation: [0, 0, 0], color: slot[cSlot] };
        break;
      case "orb":
        q = Y >= lo + 0.9 * (hi - lo)
          // capped at the +-2 offset limit so clampBlueprint never moves it
          ? { role, shape, size: [z, z, z], offset: [0, Math.min(hi + z * 0.4, BLUEPRINT_MAX_OFFSET), 0], rotation: [0, 0, 0], color: slot[cSlot] }
          : { role, shape, size: [z, z, z], offset: [hw + z * 0.6, Y, 0], rotation: [0, 0, 0], color: slot[cSlot] };
        break;
      case "rune":
        q = { role, shape, size: [z, z * 1.3, 0.006], offset: [0, Y, hd + 0.004], rotation: [0, 0, 0], color: slot[cSlot], mirror: "z" };
        break;
      case "gem":
        q = { role, shape, size: [z, z * 1.2, z * 0.6], offset: [0, Y, hd + z * 0.2], rotation: [0, 0, 0], color: slot[cSlot], mirror: "z" };
        break;
      default: // decor
        q = { role, shape, size: [z, z * 0.5, z * 0.3], offset: [0, Y, hd + z * 0.1], rotation: [0, 0, 0], color: slot[cSlot], mirror: "z" };
    }
    q.size = q.size.map((v) => round3(clampN(v, 0.01, 1.5))) as Vec3;
    q.offset = r3(q.offset);
    // never below the model's grip end (keeps the authored grip / bottom-at-y=0 conventions)
    const floor = lo + partHalfHeight(q);
    if (q.offset[1] < floor) q.offset[1] = Math.ceil(floor * 1000) / 1000;
    q.rotation = r3(q.rotation);
    if (glowy || cSlot === "e") setGlow(q, slot.e, (i ?? 1.6) * (role === "ring" ? 0.7 : 1));
    if (m !== null && METAL_ROLES.has(role)) q.metalness = round3(m);
    if (an) setAnim(q, an);
    bp.parts.push(q);
  }

  // 3. particles, trail, palette
  if (pk === "none") delete bp.particles;
  else if (pk) bp.particles = { kind: pk, color: e ?? p2 ?? bp.particles?.color ?? slot.e, rate: bp.particles?.rate ?? 10 };
  else if (bp.particles && e) bp.particles.color = e;
  if (bp.trail && e) bp.trail.color = e;
  const palette: string[] = [];
  for (const c of [p0, e, p2, p1, ...pal]) if (c && HEX.test(c) && !palette.includes(c)) palette.push(c);
  while (palette.length < 2) palette.push(palette.includes("#ffffff") ? "#202020" : "#ffffff");
  bp.palette = palette.slice(0, 5);
  return bp;
}


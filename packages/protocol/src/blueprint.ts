// Blueprint v1 (spec §3.5): an engine-neutral procedural model made of primitive parts. Evolved from Counterforge's
// ItemBlueprint (packages/pipeline/src/schema.ts): same part model (role / shape / size / offset / rotation / colour /
// anim / mirror) generalised with materials, attachment points, palette, LOD hint and a `kind`.
//
// Conventions (every SDK builder follows these):
//  - Units are metres, right-handed, +Y up. For held items +Y runs grip -> tip and the grip sits at the origin.
//  - `size` is the part's full extents; the primitive is scaled to fill it (see SHAPE_NOTES).
//  - `rotation` is Euler XYZ in radians, applied about the part's own centre, then translated by `offset`.
//  - `mirror` builds a second copy reflected across the YZ ("x") or XY ("z") plane.
//  - Never trust the wire: run clampBlueprint on anything an LLM or a client produced.
import { z } from "zod";
import { Hex, Vec3, clampNum, cleanText, isObj, oneOf, type Vec3 as Vec3T } from "./common.js";
import { VfxRecipe } from "./vfx.js";

export const BLUEPRINT_VERSION = 1 as const;

export const BLUEPRINT_KINDS = ["item", "armour", "creature", "prop", "npc_accessory", "glyph"] as const;
export type BlueprintKind = (typeof BLUEPRINT_KINDS)[number];

/** Semantic part roles (drive default materials and recolouring). Counterforge roles + armour / creature / prop. */
export const BLUEPRINT_ROLES = [
  // Counterforge item roles
  "blade", "head", "handle", "guard", "pommel", "limb", "string", "barrel", "stock", "body", "rim",
  "gem", "spike", "ring", "rune", "shard", "orb", "cloth", "decor",
  // armour
  "plate", "helm", "visor", "pauldron", "gauntlet", "greave", "boot", "belt", "cape", "trim",
  // creature
  "torso", "eye", "horn", "wing", "tail", "claw", "fin", "leg", "arm",
  // prop
  "base", "frame", "panel", "lid", "leaf", "flame", "crystal",
] as const;
export type BlueprintRole = (typeof BLUEPRINT_ROLES)[number];

export const BLUEPRINT_SHAPES = [
  "box", "wedge", "cylinder", "cone", "sphere", "torus", "octahedron", "icosahedron", "capsule", "crescent", "prism",
] as const;
export type BlueprintShape = (typeof BLUEPRINT_SHAPES)[number];

/**
 * How each primitive fills its `size` box (unit primitive scaled by size), matching Counterforge's three.js builder:
 * box/sphere/octahedron/icosahedron: unit primitive of extent 1; cylinder/cone: radius 0.5, height 1 along Y (10
 * radial segments suggested); prism: 3-sided cylinder rotated 90° about Y; wedge: blade outline in XY, tip at +Y,
 * diamond cross-section; crescent: moon arc in XY bulging to +Y, extruded along Z; torus: ring in XY, tube =
 * min(z, 0.45x)/2; capsule: radius min(x,z)/2, total height y.
 */
export const SHAPE_NOTES: Record<BlueprintShape, string> = {
  box: "unit cube", wedge: "blade outline in XY, tip +Y, diamond cross-section", cylinder: "r0.5 h1 along Y",
  cone: "r0.5 h1 along Y, apex +Y", sphere: "r0.5", torus: "ring in XY, tube=min(z,0.45x)/2", octahedron: "r0.5",
  icosahedron: "r0.5", capsule: "r=min(x,z)/2, height y", crescent: "arc in XY bulging +Y, extruded Z", prism: "3-sided cylinder",
};

export const ANIM_KINDS = ["spin", "pulse", "float", "orbit", "flicker", "wobble"] as const;
export type AnimKind = (typeof ANIM_KINDS)[number];
export const PARTICLE_KINDS = ["embers", "frost", "sparks", "motes", "smoke", "bubbles"] as const;
export type ParticleKind = (typeof PARTICLE_KINDS)[number];

export const Material = z.object({
  color: Hex,
  /** 0-1 */
  metalness: z.number().min(0).max(1).optional(),
  /** 0-1 */
  roughness: z.number().min(0).max(1).optional(),
  emissive: Hex.optional(),
  /** 0-3 */
  emissiveIntensity: z.number().min(0).max(3).optional(),
  /** 0-1 (1 = opaque) */
  opacity: z.number().min(0).max(1).optional(),
  /** Low-poly faceted look (default true). */
  flatShading: z.boolean().optional(),
});
export type Material = z.infer<typeof Material>;

export const PartAnim = z.object({
  kind: z.enum(ANIM_KINDS),
  /** 0-10 */
  speed: z.number().min(0).max(10),
  /** 0-1 */
  amount: z.number().min(0).max(1),
});
export type PartAnim = z.infer<typeof PartAnim>;

export const BlueprintPart = z.object({
  /** Optional stable id (Variants toggle parts by id or role). */
  id: z.string().max(32).optional(),
  role: z.enum(BLUEPRINT_ROLES),
  shape: z.enum(BLUEPRINT_SHAPES),
  /** Full extents in metres (each 0.01-limits.maxSize). */
  size: Vec3,
  /** Centre position (each ±limits.maxOffset). */
  offset: Vec3,
  /** Euler XYZ radians (±PI). */
  rotation: Vec3,
  /** Inline material, or the name of an entry in `Blueprint.materials`. */
  material: z.union([Material, z.string().max(32)]),
  anim: PartAnim.optional(),
  mirror: z.enum(["x", "z"]).optional(),
  /** Attachment point name this part hangs from (default: blueprint root). */
  parent: z.string().max(32).optional(),
});
export type BlueprintPart = z.infer<typeof BlueprintPart>;

export const AttachmentPoint = z.object({
  /** e.g. "grip", "tip", "socket_back", "vfx_core", "mount". "grip" is the hand socket for held items. */
  name: z.string().min(1).max(32),
  position: Vec3,
  rotation: Vec3.optional(),
  kind: z.enum(["grip", "tip", "socket", "vfx", "mount", "other"]).default("other"),
});
export type AttachmentPoint = z.infer<typeof AttachmentPoint>;

export const LodHint = z.object({
  /** Suggested detail tier for builders (segments / particle density). */
  detail: z.enum(["low", "medium", "high"]),
  /** Builders may drop parts with these roles at distance (e.g. ["rune", "decor"]). */
  dropRolesFar: z.array(z.enum(BLUEPRINT_ROLES)).optional(),
  /** Distance (m) beyond which a builder may use a single-colour impostor of `palette[0]`. */
  impostorDistance: z.number().positive().optional(),
});
export type LodHint = z.infer<typeof LodHint>;

export const Blueprint = z.object({
  v: z.literal(BLUEPRINT_VERSION),
  kind: z.enum(BLUEPRINT_KINDS),
  name: z.string().max(64).optional(),
  /** 1-limits.maxParts parts. */
  parts: z.array(BlueprintPart).min(1),
  /** 2-5 colours; palette[0] = main, [1] = grip/secondary, [2] = trim, [3+] = accents. */
  palette: z.array(Hex).min(1).max(8),
  /** Named reusable materials (parts may reference them by name). */
  materials: z.record(z.string(), Material).optional(),
  attachments: z.array(AttachmentPoint).default([]),
  lod: LodHint.optional(),
  /** Swing / projectile trail (width 0.02-0.5 m). Counterforge-compatible quick FX. */
  trail: z.object({ color: Hex, width: z.number() }).optional(),
  /** Simple ambient particles (rate 0-60 / s). Counterforge-compatible quick FX; use `vfx` for full recipes. */
  particles: z.object({ kind: z.enum(PARTICLE_KINDS), color: Hex, rate: z.number() }).optional(),
  /** Full VFX recipes attached to this model (each recipe's `attach` names an attachment point). */
  vfx: z.array(VfxRecipe).optional(),
  /** Provenance: procedural (seeded rules), styled (rules + LLM style), improvised (LLM-shaped), designer, llm. */
  source: z.enum(["procedural", "styled", "improvised", "designer", "llm", "bake"]).optional(),
  seed: z.number().int().optional(),
  /** Free tags (element, family, slot ...). */
  tags: z.array(z.string()).optional(),
});
export type Blueprint = z.infer<typeof Blueprint>;
export type BlueprintInput = z.input<typeof Blueprint>;

// ------------------------------------------------------------------------------------------------ clamping

export const BLUEPRINT_LIMITS = {
  minParts: 1, maxParts: 32, minSize: 0.01, maxSize: 3, maxOffset: 4, maxRotation: Math.PI,
  maxEmissive: 3, maxSpeed: 10, maxAmount: 1, minTrail: 0.02, maxTrail: 0.5, maxRate: 60, maxPalette: 8,
  maxAttachments: 12,
  /** Raw parts inspected at most (a 500-part answer costs no more than this). */
  scanParts: 64,
} as const;
export type BlueprintLimits = { -readonly [K in keyof typeof BLUEPRINT_LIMITS]: number };

const HEX = /^#[0-9a-f]{6}$/i;
const hexOr = (v: unknown, fb: string): string => (typeof v === "string" && HEX.test(v.trim()) ? v.trim().toLowerCase() : fb);
const fin = (v: unknown, fb: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fb);
function vec3(v: unknown, lo: number, hi: number, fb: number): Vec3T {
  const a = Array.isArray(v) ? v : [];
  return [clampNum(fin(a[0], fb), lo, hi, fb), clampNum(fin(a[1], fb), lo, hi, fb), clampNum(fin(a[2], fb), lo, hi, fb)];
}

function clampMaterial(m: unknown, fallbackColor: string, L: BlueprintLimits): Material {
  const o = isObj(m) ? m : {};
  const out: Material = { color: hexOr(o.color, fallbackColor) };
  if (typeof o.metalness === "number") out.metalness = clampNum(o.metalness, 0, 1, 0.2);
  if (typeof o.roughness === "number") out.roughness = clampNum(o.roughness, 0, 1, 0.6);
  const em = typeof o.emissive === "string" && HEX.test(o.emissive) ? o.emissive.toLowerCase() : null;
  if (em && em !== "#000000") {
    out.emissive = em;
    out.emissiveIntensity = clampNum(o.emissiveIntensity, 0, L.maxEmissive, 1);
  }
  if (typeof o.opacity === "number") out.opacity = clampNum(o.opacity, 0.05, 1, 1);
  if (typeof o.flatShading === "boolean") out.flatShading = o.flatShading;
  return out;
}

/**
 * Validates + clamps an untrusted blueprint (LLM output, client upload). Unknown roles become "decor", unknown shapes
 * "box", numbers are clamped, bad colours fall back to the palette. Returns null when nothing usable is left.
 * Accepts Counterforge ItemBlueprint parts too (top-level color / metalness / emissive on the part).
 */
export function clampBlueprint(raw: unknown, limits: Partial<BlueprintLimits> = {}): Blueprint | null {
  if (!isObj(raw)) return null;
  const L: BlueprintLimits = { ...BLUEPRINT_LIMITS, ...limits };
  const palette = (Array.isArray(raw.palette) ? raw.palette : [])
    .filter((c): c is string => typeof c === "string" && HEX.test(c))
    .map((c) => c.toLowerCase())
    .slice(0, L.maxPalette);
  if (palette.length === 0) palette.push("#b8c0c8", "#5a3a22", "#d4af37");
  const materials: Record<string, Material> = {};
  if (isObj(raw.materials)) {
    for (const [k, m] of Object.entries(raw.materials).slice(0, 16)) materials[k.slice(0, 32)] = clampMaterial(m, palette[0], L);
  }
  const parts: BlueprintPart[] = [];
  const rawParts = Array.isArray(raw.parts) ? raw.parts.slice(0, L.scanParts) : [];
  for (const p of rawParts) {
    if (!isObj(p) || parts.length >= L.maxParts) continue;
    const matRaw = p.material ?? p; // Counterforge parts carry colour fields inline
    const material: Material | string =
      typeof matRaw === "string" && materials[matRaw] ? matRaw : clampMaterial(matRaw, palette[parts.length % palette.length], L);
    const part: BlueprintPart = {
      role: oneOf(BLUEPRINT_ROLES, p.role) ?? "decor",
      shape: oneOf(BLUEPRINT_SHAPES, p.shape) ?? "box",
      size: vec3(p.size, L.minSize, L.maxSize, 0.1),
      offset: vec3(p.offset, -L.maxOffset, L.maxOffset, 0),
      rotation: vec3(p.rotation, -L.maxRotation, L.maxRotation, 0),
      material,
    };
    if (typeof p.id === "string" && p.id) part.id = p.id.slice(0, 32);
    if (typeof p.parent === "string" && p.parent) part.parent = p.parent.slice(0, 32);
    if (isObj(p.anim)) {
      const kind = oneOf(ANIM_KINDS, p.anim.kind);
      if (kind) part.anim = { kind, speed: clampNum(p.anim.speed, 0, L.maxSpeed, 1), amount: clampNum(p.anim.amount, 0, L.maxAmount, 0.1) };
    }
    const mirror = oneOf(["x", "z"] as const, p.mirror);
    if (mirror) part.mirror = mirror;
    parts.push(part);
  }
  if (parts.length < L.minParts) return null;
  const attachments = (Array.isArray(raw.attachments) ? raw.attachments : [])
    .filter(isObj)
    .slice(0, L.maxAttachments)
    .map((a) => ({
      name: cleanText(a.name, 32).replace(/\s+/g, "_") || "point",
      position: vec3(a.position, -L.maxOffset, L.maxOffset, 0),
      ...(Array.isArray(a.rotation) ? { rotation: vec3(a.rotation, -L.maxRotation, L.maxRotation, 0) } : {}),
      kind: oneOf(["grip", "tip", "socket", "vfx", "mount", "other"] as const, a.kind) ?? "other",
    }));
  const bp: Blueprint = {
    v: 1,
    kind: oneOf(BLUEPRINT_KINDS, raw.kind) ?? "item",
    parts,
    palette,
    attachments,
  };
  if (typeof raw.name === "string") bp.name = cleanText(raw.name, 64);
  if (Object.keys(materials).length) bp.materials = materials;
  if (isObj(raw.lod)) bp.lod = { detail: oneOf(["low", "medium", "high"] as const, raw.lod.detail) ?? "medium" };
  if (isObj(raw.trail)) bp.trail = { color: hexOr(raw.trail.color, palette[0]), width: clampNum(raw.trail.width, L.minTrail, L.maxTrail, 0.1) };
  if (isObj(raw.particles)) {
    const kind = oneOf(PARTICLE_KINDS, raw.particles.kind);
    if (kind) bp.particles = { kind, color: hexOr(raw.particles.color, palette[0]), rate: clampNum(raw.particles.rate, 0, L.maxRate, 12) };
  }
  const src = oneOf(["procedural", "styled", "improvised", "designer", "llm", "bake"] as const, raw.source);
  if (src) bp.source = src;
  if (typeof raw.seed === "number" && Number.isInteger(raw.seed)) bp.seed = raw.seed;
  if (Array.isArray(raw.tags)) bp.tags = raw.tags.filter((t): t is string => typeof t === "string").slice(0, 16);
  return bp;
}

/** Resolve a part's material (inline or named). */
export function partMaterial(bp: Blueprint, part: BlueprintPart): Material {
  if (typeof part.material !== "string") return part.material;
  return bp.materials?.[part.material] ?? { color: bp.palette[0] };
}

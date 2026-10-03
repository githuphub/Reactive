// Internal model format of the forge's procedural libraries: Counterforge's ItemBlueprint part model (colour fields
// inline on each part). Everything the forge builds is authored in this format and converted to protocol Blueprint v1
// at the very end (toBlueprint), where it is clamped against the manifest limits.
import {
  clampBlueprint, hashString, mulberry32,
  type AnimKind, type Blueprint, type BlueprintKind, type BlueprintRole, type BlueprintShape, type ParticleKind,
} from "@liveforge/protocol";

export { hashString, mulberry32 };

export type Vec3 = [number, number, number];

/** One primitive part (Counterforge ItemBlueprint part: inline colour + optional glow / metalness / anim / mirror). */
export interface RawPart {
  role: BlueprintRole;
  shape: BlueprintShape;
  /** Full extents in metres. */
  size: Vec3;
  /** Centre position (metres). */
  offset: Vec3;
  /** Euler XYZ radians. */
  rotation: Vec3;
  /** "#rrggbb" */
  color: string;
  emissive?: string;
  emissiveIntensity?: number;
  metalness?: number;
  roughness?: number;
  anim?: { kind: AnimKind; speed: number; amount: number };
  mirror?: "x" | "z";
}

/** A model made of RawParts (Counterforge ItemBlueprint). */
export interface RawModel {
  parts: RawPart[];
  /** 2-5 colours: [main, glow, accent, dark, grip] for procedural models. */
  palette: string[];
  trail?: { color: string; width: number };
  particles?: { kind: ParticleKind; color: string; rate: number };
}

/** Four-way stat bias of a template (sum 100); mapped onto the manifest's stat names by statsFromBias. */
export interface StatBias {
  damage: number;
  speed: number;
  range: number;
  special: number;
}

export const round3 = (v: number) => Math.round(v * 1000) / 1000;
export const r3 = (v: Vec3): Vec3 => [round3(v[0]), round3(v[1]), round3(v[2])];
export const clampN = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const finOr = (v: unknown, fb: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fb);
export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const oneOfS = <T extends string>(list: readonly T[], v: unknown): T | undefined =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined;
export const HEX_RE = /^#[0-9a-f]{6}$/i;
export const hexOrNull = (v: unknown): string | null => (typeof v === "string" && HEX_RE.test(v.trim()) ? v.trim().toLowerCase() : null);

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0");
const parseHex = (c: string): [number, number, number] => {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
/** Linear mix of two "#rrggbb" colours (k = 0 -> a, 1 -> b). */
export function mixHex(a: string, b: string, k: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  return `#${hex2(x[0] + (y[0] - x[0]) * k)}${hex2(x[1] + (y[1] - x[1]) * k)}${hex2(x[2] + (y[2] - x[2]) * k)}`;
}
/** HSL (0-1 each) -> "#rrggbb". */
export function hslHex(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Deep copy. */
export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ------------------------------------------------------------------------------------------------ geometry

/**
 * Half-extents of a part's exact rotated AABB (about its own centre): for each axis i, sum_j |R_ij| * size_j / 2,
 * with R the Euler XYZ rotation matrix (three.js order).
 */
export function partHalfExtents(p: Pick<RawPart, "rotation" | "size">): Vec3 {
  const [x, y, z] = p.rotation;
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
  const [sx, sy, sz] = p.size;
  const R = [
    [c * e, -c * f, d],
    [a * f + b * e * d, a * e - b * f * d, -b * c],
    [b * f - a * e * d, b * e + a * f * d, a * c],
  ];
  return R.map((r) => (Math.abs(r[0]) * sx + Math.abs(r[1]) * sy + Math.abs(r[2]) * sz) / 2) as Vec3;
}

export const partHalfHeight = (p: Pick<RawPart, "rotation" | "size">): number => partHalfExtents(p)[1];

/** Exact AABB of the parts (mirrors and orbits included). */
export function partsBounds(parts: readonly RawPart[]): { min: Vec3; max: Vec3 } {
  if (!parts.length) return { min: [0, 0, 0], max: [0, 0, 0] };
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const h = partHalfExtents(p);
    const orbit = p.anim?.kind === "orbit" ? p.anim.amount : 0;
    for (let i = 0; i < 3; i++) {
      const o = i === 1 ? 0 : orbit;
      const lo = p.offset[i] - h[i] - o, hi = p.offset[i] + h[i] + o;
      const mirrored = (p.mirror === "x" && i === 0) || (p.mirror === "z" && i === 2);
      min[i] = Math.min(min[i], lo, mirrored ? -hi : lo);
      max[i] = Math.max(max[i], hi, mirrored ? -lo : hi);
    }
  }
  return { min, max };
}

/** Longest axis extent of a model (metres). */
export function modelExtent(parts: readonly RawPart[]): number {
  const b = partsBounds(parts);
  return Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
}

/** Uniformly rescale a model so its longest extent is `target` metres (about the origin). Mutates and returns it. */
export function scaleModel(m: RawModel, target: number): RawModel {
  const e = modelExtent(m.parts);
  if (!(e > 0) || !(target > 0)) return m;
  const f = target / e;
  for (const p of m.parts) {
    p.size = r3(p.size.map((v) => Math.max(0.01, v * f)) as Vec3);
    p.offset = r3(p.offset.map((v) => v * f) as Vec3);
    if (p.anim && (p.anim.kind === "orbit" || p.anim.kind === "float")) p.anim.amount = round3(p.anim.amount * f);
  }
  if (m.trail) m.trail.width = round3(clampN(m.trail.width * f, 0.02, 0.5));
  return m;
}

// ------------------------------------------------------------------------------------------------ -> Blueprint v1

export interface ToBlueprintOptions {
  kind: BlueprintKind;
  name?: string;
  /** Manifest clamps.forge.maxParts. */
  maxParts: number;
  source?: Blueprint["source"];
  seed?: number;
  tags?: string[];
  /**
   * Attachment frame. "held": grip at the origin, tip at the top of the model (Blueprint conventions); "object":
   * stands on y = 0, "mount" on top and "vfx_core" at the centre; "worn": centred, "socket" at the origin.
   */
  frame: "held" | "object" | "worn";
}

/**
 * Converts an internal RawModel to a clamped protocol Blueprint v1 (materials inline, attachment points by frame,
 * LOD hint). Never returns null for a model with at least one part: a fallback cube is used otherwise.
 */
export function toBlueprint(m: RawModel, o: ToBlueprintOptions): Blueprint {
  const parts = m.parts.slice(0, o.maxParts);
  const b = partsBounds(parts);
  const cx = round3((b.min[0] + b.max[0]) / 2), cy = round3((b.min[1] + b.max[1]) / 2), cz = round3((b.min[2] + b.max[2]) / 2);
  const attachments: Array<{ name: string; position: Vec3; kind: string }> = [];
  if (o.frame === "held") {
    attachments.push({ name: "grip", position: [0, 0, 0], kind: "grip" });
    attachments.push({ name: "tip", position: [cx, round3(b.max[1]), cz], kind: "tip" });
    attachments.push({ name: "vfx_core", position: [cx, round3(b.min[1] + (b.max[1] - b.min[1]) * 0.7), cz], kind: "vfx" });
  } else if (o.frame === "object") {
    attachments.push({ name: "base", position: [cx, round3(b.min[1]), cz], kind: "socket" });
    attachments.push({ name: "mount", position: [cx, round3(b.max[1]), cz], kind: "mount" });
    attachments.push({ name: "vfx_core", position: [cx, cy, cz], kind: "vfx" });
  } else {
    attachments.push({ name: "socket", position: [0, 0, 0], kind: "socket" });
    attachments.push({ name: "vfx_core", position: [cx, cy, cz], kind: "vfx" });
  }
  const extent = modelExtent(parts);
  const raw = {
    v: 1,
    kind: o.kind,
    name: o.name,
    parts: parts.map((p) => ({
      role: p.role, shape: p.shape, size: p.size, offset: p.offset, rotation: p.rotation, mirror: p.mirror, anim: p.anim,
      material: {
        color: p.color, emissive: p.emissive, emissiveIntensity: p.emissiveIntensity, metalness: p.metalness, roughness: p.roughness,
      },
    })),
    palette: m.palette,
    attachments,
    lod: { detail: parts.length > 16 ? "high" : parts.length > 8 ? "medium" : "low" },
    trail: m.trail,
    particles: m.particles,
    source: o.source,
    seed: o.seed,
    tags: o.tags,
  };
  const bp = clampBlueprint(raw, { maxParts: o.maxParts, maxOffset: 4, maxSize: 3 })
    ?? clampBlueprint({ v: 1, kind: o.kind, parts: [{ role: "body", shape: "box", size: [0.3, 0.3, 0.3], offset: [0, 0.15, 0], rotation: [0, 0, 0], material: { color: "#888888" } }], palette: ["#888888", "#ffffff"] })!;
  if (bp.lod) {
    bp.lod.dropRolesFar = ["rune", "decor"];
    bp.lod.impostorDistance = Math.round(clampN(extent * 40, 10, 200));
  }
  return bp;
}

// ------------------------------------------------------------------------------------------------ untrusted raw models

/** Clamp ranges for untrusted raw models (Counterforge v2 §0.2 limits). */
export const RAW_LIMITS = { minParts: 3, maxParts: 24, minSize: 0.01, maxSize: 1.5, maxOffset: 2, maxEmissive: 3, maxSpeed: 10, maxExtent: 3, scanParts: 64 } as const;

const vec3c = (v: unknown, lo: number, hi: number, fb: number): Vec3 => {
  const a = Array.isArray(v) ? v : [];
  return [clampN(finOr(a[0], fb), lo, hi), clampN(finOr(a[1], fb), lo, hi), clampN(finOr(a[2], fb), lo, hi)];
};

/**
 * Validates + clamps an untrusted RawModel (an LLM shape expanded by expandShape, or a client upload). Ported from
 * Counterforge clampBlueprint: unknown roles become "decor", unknown shapes "box", numbers clamped, bad colours fall
 * back to the palette, at most 24 parts, a model longer than 3 m is scaled down. Null with fewer than 3 usable parts.
 */
export function clampRawModel(raw: unknown, roles: readonly string[], shapes: readonly string[], anims: readonly string[], particles: readonly string[]): RawModel | null {
  if (!isObj(raw) || !Array.isArray(raw.parts)) return null;
  const L = RAW_LIMITS;
  const palette: string[] = [];
  for (const c of Array.isArray(raw.palette) ? raw.palette.slice(0, 16) : []) {
    const h = hexOrNull(c);
    if (h && !palette.includes(h)) palette.push(h);
  }
  const fallback = palette[0] ?? "#b8c0c8";
  const parts: RawPart[] = [];
  for (const p of raw.parts.slice(0, L.scanParts)) {
    if (parts.length >= L.maxParts) break;
    if (!isObj(p)) continue;
    const part: RawPart = {
      role: (oneOfS(roles, p.role) ?? "decor") as RawPart["role"],
      shape: (oneOfS(shapes, p.shape) ?? "box") as RawPart["shape"],
      size: vec3c(p.size, L.minSize, L.maxSize, 0.1),
      offset: vec3c(p.offset, -L.maxOffset, L.maxOffset, 0),
      rotation: vec3c(p.rotation, -Math.PI, Math.PI, 0),
      color: hexOrNull(p.color) ?? fallback,
    };
    const em = hexOrNull(p.emissive);
    const ei = clampN(finOr(p.emissiveIntensity, 1), 0, L.maxEmissive);
    if (em && em !== "#000000" && ei > 0) { part.emissive = em; part.emissiveIntensity = ei; }
    if (typeof p.metalness === "number" && Number.isFinite(p.metalness)) part.metalness = clampN(p.metalness, 0, 1);
    if (typeof p.roughness === "number" && Number.isFinite(p.roughness)) part.roughness = clampN(p.roughness, 0, 1);
    if (isObj(p.anim)) {
      const kind = oneOfS(anims, p.anim.kind);
      if (kind) part.anim = { kind: kind as NonNullable<RawPart["anim"]>["kind"], speed: clampN(finOr(p.anim.speed, 1), 0, L.maxSpeed), amount: clampN(finOr(p.anim.amount, 0.1), 0, 1) };
    }
    const mirror = oneOfS(["x", "z"] as const, p.mirror);
    if (mirror) part.mirror = mirror;
    parts.push(part);
  }
  if (parts.length < L.minParts) return null;
  for (const p of parts) {
    if (palette.length >= 2) break;
    if (!palette.includes(p.color)) palette.push(p.color);
  }
  while (palette.length < 2) palette.push(palette.includes("#ffffff") ? "#202020" : "#ffffff");
  const m: RawModel = { parts, palette: palette.slice(0, 5) };
  if (modelExtent(parts) > L.maxExtent) scaleModel(m, L.maxExtent);
  if (isObj(raw.particles)) {
    const kind = oneOfS(particles, raw.particles.kind);
    const rate = Math.round(clampN(finOr(raw.particles.rate, 0), 0, 60));
    if (kind && rate > 0) m.particles = { kind: kind as NonNullable<RawModel["particles"]>["kind"], color: hexOrNull(raw.particles.color) ?? m.palette[1], rate };
  }
  if (isObj(raw.trail)) {
    const color = hexOrNull(raw.trail.color);
    const width = finOr(raw.trail.width, 0);
    if (color && width > 0) m.trail = { color, width: clampN(width, 0.02, 0.5) };
  }
  return m;
}

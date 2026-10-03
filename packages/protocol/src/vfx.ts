// VFX recipe v1 (spec §3.5): engine-neutral particle / trail / aura / light description. SDK builders map it to
// three.js (instanced points / meshes) and Godot (GPUParticles3D + ParticleProcessMaterial, Trail, OmniLight3D).
import { z } from "zod";
import { Hex, Vec3, clampNum, cleanText, isObj, oneOf } from "./common.js";

export const EMITTER_SHAPES = ["point", "sphere", "box", "cone", "ring", "line"] as const;
export const PARTICLE_SPRITES = ["spark", "ember", "smoke", "mote", "shard", "bubble", "ring", "glyph", "flame", "snow", "leaf"] as const;
export const BLEND_MODES = ["additive", "alpha"] as const;

/** One stop of a colour ramp over particle life (t 0 = birth, 1 = death). */
export const ColorStop = z.object({ t: z.number().min(0).max(1), color: Hex, alpha: z.number().min(0).max(1).default(1) });
export type ColorStop = z.infer<typeof ColorStop>;
/** One key of a size curve over particle life (size in metres). */
export const SizeKey = z.object({ t: z.number().min(0).max(1), size: z.number().min(0) });
export type SizeKey = z.infer<typeof SizeKey>;

export const Emitter = z.object({
  shape: z.enum(EMITTER_SHAPES),
  /** sphere / cone / ring radius (m). */
  radius: z.number().min(0).optional(),
  /** box extents / line length on x (m). */
  extents: Vec3.optional(),
  /** cone half-angle (degrees). */
  angle: z.number().min(0).max(180).optional(),
  /** Particles per second (0-limits.maxRate). 0 with `burst` = one-shot. */
  rate: z.number().min(0),
  /** One-shot burst count at start. */
  burst: z.number().int().min(0).optional(),
  /** Live particle cap (builders size buffers from this). */
  maxParticles: z.number().int().min(1),
  /** Seconds [min, max]. */
  lifetime: z.tuple([z.number().min(0), z.number().min(0)]),
  velocity: z.object({
    /** Main direction (normalised by builders). */
    dir: Vec3,
    /** m/s [min, max]. */
    speed: z.tuple([z.number(), z.number()]),
    /** 0 = straight along dir, 1 = any direction. */
    spread: z.number().min(0).max(1),
  }),
  /** m/s² along -Y (negative floats up). */
  gravity: z.number().optional(),
  /** 0-1 velocity damping per second. */
  drag: z.number().min(0).max(1).optional(),
  colorRamp: z.array(ColorStop).min(1).max(8),
  sizeCurve: z.array(SizeKey).min(1).max(8),
  /** radians / s */
  spin: z.number().optional(),
  sprite: z.enum(PARTICLE_SPRITES),
  blend: z.enum(BLEND_MODES).default("additive"),
  offset: Vec3.optional(),
  /** true = particles move with the emitter (local space). */
  local: z.boolean().optional(),
});
export type Emitter = z.infer<typeof Emitter>;

export const Trail = z.object({
  /** Width in metres at the head. */
  width: z.number().min(0),
  /** Seconds a trail point lives. */
  lifetime: z.number().min(0),
  colorRamp: z.array(ColorStop).min(1).max(8),
  blend: z.enum(BLEND_MODES).default("additive"),
  /** Attachment point to follow (default "tip"). */
  attach: z.string().optional(),
});
export type Trail = z.infer<typeof Trail>;

export const Aura = z.object({
  shape: z.enum(["sphere", "ring", "column", "ground_decal"]),
  radius: z.number().min(0),
  height: z.number().min(0).optional(),
  color: Hex,
  /** 0-3 */
  intensity: z.number().min(0).max(3),
  pulse: z.object({ speed: z.number().min(0), amount: z.number().min(0).max(1) }).optional(),
});
export type Aura = z.infer<typeof Aura>;

export const VfxLight = z.object({
  color: Hex,
  /** 0-10 */
  intensity: z.number().min(0).max(10),
  /** metres */
  range: z.number().min(0),
  /** 0-1 random flicker. */
  flicker: z.number().min(0).max(1).optional(),
  offset: Vec3.optional(),
});
export type VfxLight = z.infer<typeof VfxLight>;

export const VfxRecipe = z.object({
  v: z.literal(1),
  name: z.string().max(64).optional(),
  /** Seconds; omitted / null = loops until removed. */
  duration: z.number().min(0).nullable().optional(),
  /** Attachment point on the host blueprint / node (e.g. "tip", "vfx_core"). */
  attach: z.string().max(32).optional(),
  emitters: z.array(Emitter).max(6).default([]),
  trails: z.array(Trail).max(2).optional(),
  auras: z.array(Aura).max(3).optional(),
  lights: z.array(VfxLight).max(2).optional(),
  /** Hints: element, mood, "hit" / "aura" / "cast" ... */
  tags: z.array(z.string()).optional(),
});
export type VfxRecipe = z.infer<typeof VfxRecipe>;
export type VfxRecipeInput = z.input<typeof VfxRecipe>;

export const VFX_LIMITS = {
  maxEmitters: 6, maxRate: 200, maxParticles: 512, maxLifetime: 6, maxSpeed: 30, maxSize: 3, maxRadius: 8,
  maxDuration: 30, maxLights: 2, maxLightIntensity: 10, maxLightRange: 20,
} as const;

const HEX = /^#[0-9a-f]{6}$/i;
const hexOr = (v: unknown, fb: string) => (typeof v === "string" && HEX.test(v) ? v.toLowerCase() : fb);
const v3 = (v: unknown, lo: number, hi: number, d: number): [number, number, number] => {
  const a = Array.isArray(v) ? v : [];
  return [clampNum(a[0], lo, hi, d), clampNum(a[1], lo, hi, d), clampNum(a[2], lo, hi, d)];
};
function ramp(v: unknown, fb: string): ColorStop[] {
  const a = (Array.isArray(v) ? v : []).filter(isObj).slice(0, 8);
  const out = a.map((s) => ({ t: clampNum(s.t, 0, 1, 0), color: hexOr(s.color, fb), alpha: clampNum(s.alpha, 0, 1, 1) }));
  return out.length ? out.sort((x, y) => x.t - y.t) : [{ t: 0, color: fb, alpha: 1 }, { t: 1, color: fb, alpha: 0 }];
}

/** Validates + clamps an untrusted VFX recipe. Null when nothing renderable is left. */
export function clampVfx(raw: unknown, fallbackColor = "#ffd23f"): VfxRecipe | null {
  if (!isObj(raw)) return null;
  const L = VFX_LIMITS;
  const emitters: Emitter[] = (Array.isArray(raw.emitters) ? raw.emitters : []).filter(isObj).slice(0, L.maxEmitters).map((e) => {
    const vel = isObj(e.velocity) ? e.velocity : {};
    const sp = Array.isArray(vel.speed) ? vel.speed : [];
    const lt = Array.isArray(e.lifetime) ? e.lifetime : [];
    const sizes = (Array.isArray(e.sizeCurve) ? e.sizeCurve : []).filter(isObj).slice(0, 8)
      .map((k) => ({ t: clampNum(k.t, 0, 1, 0), size: clampNum(k.size, 0, L.maxSize, 0.05) }));
    const em: Emitter = {
      shape: oneOf(EMITTER_SHAPES, e.shape) ?? "point",
      rate: clampNum(e.rate, 0, L.maxRate, 10),
      maxParticles: Math.round(clampNum(e.maxParticles, 1, L.maxParticles, 64)),
      lifetime: [clampNum(lt[0], 0, L.maxLifetime, 0.5), clampNum(lt[1], 0, L.maxLifetime, 1)],
      velocity: {
        dir: v3(vel.dir, -1, 1, 0),
        speed: [clampNum(sp[0], -L.maxSpeed, L.maxSpeed, 0.5), clampNum(sp[1], -L.maxSpeed, L.maxSpeed, 1)],
        spread: clampNum(vel.spread, 0, 1, 0.3),
      },
      colorRamp: ramp(e.colorRamp, fallbackColor),
      sizeCurve: sizes.length ? sizes.sort((x, y) => x.t - y.t) : [{ t: 0, size: 0.05 }, { t: 1, size: 0 }],
      sprite: oneOf(PARTICLE_SPRITES, e.sprite) ?? "spark",
      blend: oneOf(BLEND_MODES, e.blend) ?? "additive",
    };
    if (typeof e.radius === "number") em.radius = clampNum(e.radius, 0, L.maxRadius, 0.2);
    if (Array.isArray(e.extents)) em.extents = v3(e.extents, 0, L.maxRadius, 0.2);
    if (typeof e.angle === "number") em.angle = clampNum(e.angle, 0, 180, 25);
    if (typeof e.burst === "number") em.burst = Math.round(clampNum(e.burst, 0, L.maxParticles, 0));
    if (typeof e.gravity === "number") em.gravity = clampNum(e.gravity, -20, 20, 0);
    if (typeof e.drag === "number") em.drag = clampNum(e.drag, 0, 1, 0);
    if (typeof e.spin === "number") em.spin = clampNum(e.spin, -20, 20, 0);
    if (Array.isArray(e.offset)) em.offset = v3(e.offset, -4, 4, 0);
    if (typeof e.local === "boolean") em.local = e.local;
    return em;
  });
  const out: VfxRecipe = { v: 1, emitters };
  if (typeof raw.name === "string") out.name = cleanText(raw.name, 64);
  if (typeof raw.duration === "number") out.duration = clampNum(raw.duration, 0, L.maxDuration, 1);
  if (typeof raw.attach === "string") out.attach = raw.attach.slice(0, 32);
  if (Array.isArray(raw.trails)) {
    out.trails = raw.trails.filter(isObj).slice(0, 2).map((t) => ({
      width: clampNum(t.width, 0.01, 1, 0.1), lifetime: clampNum(t.lifetime, 0.05, 2, 0.3),
      colorRamp: ramp(t.colorRamp, fallbackColor), blend: oneOf(BLEND_MODES, t.blend) ?? "additive",
      ...(typeof t.attach === "string" ? { attach: t.attach.slice(0, 32) } : {}),
    }));
  }
  if (Array.isArray(raw.auras)) {
    out.auras = raw.auras.filter(isObj).slice(0, 3).map((a) => ({
      shape: oneOf(["sphere", "ring", "column", "ground_decal"] as const, a.shape) ?? "sphere",
      radius: clampNum(a.radius, 0, L.maxRadius, 0.5), color: hexOr(a.color, fallbackColor), intensity: clampNum(a.intensity, 0, 3, 1),
      ...(typeof a.height === "number" ? { height: clampNum(a.height, 0, L.maxRadius, 1) } : {}),
      ...(isObj(a.pulse) ? { pulse: { speed: clampNum(a.pulse.speed, 0, 10, 1), amount: clampNum(a.pulse.amount, 0, 1, 0.2) } } : {}),
    }));
  }
  if (Array.isArray(raw.lights)) {
    out.lights = raw.lights.filter(isObj).slice(0, L.maxLights).map((l) => ({
      color: hexOr(l.color, fallbackColor), intensity: clampNum(l.intensity, 0, L.maxLightIntensity, 1),
      range: clampNum(l.range, 0, L.maxLightRange, 3),
      ...(typeof l.flicker === "number" ? { flicker: clampNum(l.flicker, 0, 1, 0) } : {}),
      ...(Array.isArray(l.offset) ? { offset: v3(l.offset, -4, 4, 0) } : {}),
    }));
  }
  if (Array.isArray(raw.tags)) out.tags = raw.tags.filter((t): t is string => typeof t === "string").slice(0, 8);
  const empty = !out.emitters.length && !out.trails?.length && !out.auras?.length && !out.lights?.length;
  return empty ? null : out;
}

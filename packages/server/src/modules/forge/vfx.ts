// VFX recipes (spec §3.5): engine-neutral emitters / trails / auras / lights built from an intent + element +
// colours. The keyless path detects the intent from the prompt; the LLM upgrade fills a compact VFX style
// (VFX_STYLE_JSON_SCHEMA) that buildVfx expands, then clampVfx clamps everything.
import { PARTICLE_SPRITES, clampVfx, type VfxRecipe } from "@liveforge/protocol";
import { elementPalettes, elementSprite, isPhysical } from "./elements.js";
import { clampN, finOr, hexOrNull, isObj, mixHex, mulberry32, oneOfS } from "./model.js";
import { keywordRe } from "./keywords.js";

export const VFX_INTENTS = ["aura", "trail", "burst", "hit", "cast", "rain", "ambient", "explosion", "smoke", "shield", "beam", "heal"] as const;
export type VfxIntent = (typeof VFX_INTENTS)[number];

const INTENT_WORDS: Array<[VfxIntent, string[]]> = [
  ["explosion", ["explosion", "explode", "blast", "boom", "detonation", "kaboom", "nova"]],
  ["hit", ["hit", "impact", "strike", "slash", "smash", "crit", "critical"]],
  ["trail", ["trail", "streak", "swoosh", "afterimage", "wake", "tail"]],
  ["rain", ["rain", "snowfall", "snow", "hail", "shower", "downpour", "meteor shower"]],
  ["heal", ["heal", "healing", "regen", "regeneration", "mend", "cure", "restore"]],
  ["shield", ["shield", "barrier", "ward", "bubble", "dome", "protection"]],
  ["beam", ["beam", "laser", "ray", "lance of light"]],
  ["cast", ["cast", "casting", "spell", "charge up", "charging", "channel", "summoning circle"]],
  ["smoke", ["smoke", "fog", "mist", "steam", "smog", "dust"]],
  ["burst", ["burst", "pop", "puff", "sparkle burst", "confetti", "flash"]],
  ["aura", ["aura", "glow", "halo", "radiance", "flames around", "surrounding", "cloak of"]],
  ["ambient", ["ambient", "fireflies", "motes", "sparkles", "embers", "particles", "floating"]],
];
const INTENT_RES = INTENT_WORDS.map(([i, w]) => [i, keywordRe(w)] as const);

/** Intent a prompt asks for (first rule that matches), else "aura". */
export function vfxIntent(text: string, fallback: VfxIntent = "aura"): VfxIntent {
  for (const [i, re] of INTENT_RES) if (re.test(text)) return i;
  return fallback;
}

export interface VfxOptions {
  intent: VfxIntent;
  element: string;
  /** [main, glow, accent]; default from the element palette. */
  colors?: string[];
  /** Overall scale (metres-ish), 0.2-4. */
  scale?: number;
  /** 0-2 multiplier on rates. */
  density?: number;
  /** 0-2 multiplier on speeds. */
  energy?: number;
  sprite?: string;
  durationSec?: number | null;
  attach?: string;
  name?: string;
  seed: number;
  light?: boolean;
}

/** Build a VFX recipe (always clamped; never null). */
export function buildVfx(o: VfxOptions): VfxRecipe {
  const rnd = mulberry32(o.seed ^ 0x7f4a7c15);
  const pals = elementPalettes(o.element);
  const pal = pals[Math.floor(rnd() * pals.length) % pals.length];
  const c0 = hexOrNull(o.colors?.[0]) ?? pal.metal;
  const c1 = hexOrNull(o.colors?.[1]) ?? pal.glow;
  const c2 = hexOrNull(o.colors?.[2]) ?? pal.accent;
  const s = clampN(finOr(o.scale, 1), 0.2, 4);
  const dens = clampN(finOr(o.density, 1), 0.1, 2);
  const en = clampN(finOr(o.energy, 1), 0.1, 2);
  const sprite = oneOfS(PARTICLE_SPRITES, o.sprite) ?? elementSprite(o.element);
  const fireLike = sprite === "ember" || sprite === "flame";
  const ramp = (a = 1) => [{ t: 0, color: mixHex(c1, "#ffffff", 0.35), alpha: a }, { t: 0.4, color: c1, alpha: a * 0.9 }, { t: 1, color: c2, alpha: 0 }];
  const sizes = (a: number, b = 0) => [{ t: 0, size: a * s }, { t: 1, size: b * s }];
  const up: [number, number, number] = [0, 1, 0];
  const light = { color: c1, intensity: 1.5 * en, range: 3 * s, flicker: fireLike ? 0.35 : 0.1 };
  let r: Record<string, unknown>;
  switch (o.intent) {
    case "trail":
      r = {
        trails: [{ width: 0.12 * s, lifetime: 0.35, colorRamp: ramp(), blend: "additive", attach: o.attach ?? "tip" }],
        emitters: [{ shape: "point", rate: 30 * dens, maxParticles: 96, lifetime: [0.2, 0.5], velocity: { dir: [0, 0, 0], speed: [0.1, 0.4 * en], spread: 1 }, colorRamp: ramp(), sizeCurve: sizes(0.05, 0), sprite, blend: "additive" }],
      };
      break;
    case "burst":
    case "hit":
      r = {
        duration: 0.6,
        emitters: [
          { shape: "sphere", radius: 0.05 * s, rate: 0, burst: Math.round((o.intent === "hit" ? 24 : 40) * dens), maxParticles: 96, lifetime: [0.2, 0.5], velocity: { dir: up, speed: [2 * en * s, 5 * en * s], spread: 1 }, gravity: 4, drag: 0.4, colorRamp: ramp(), sizeCurve: sizes(0.08, 0), sprite, blend: "additive" },
          { shape: "point", rate: 0, burst: 1, maxParticles: 1, lifetime: [0.18, 0.22], velocity: { dir: [0, 0, 0], speed: [0, 0], spread: 0 }, colorRamp: [{ t: 0, color: "#ffffff", alpha: 1 }, { t: 1, color: c1, alpha: 0 }], sizeCurve: sizes(0.4, 0.9), sprite: "ring", blend: "additive" },
        ],
        lights: [{ ...light, intensity: 3 * en }],
      };
      break;
    case "explosion":
      r = {
        duration: 1.2,
        emitters: [
          { shape: "sphere", radius: 0.2 * s, rate: 0, burst: Math.round(80 * dens), maxParticles: 160, lifetime: [0.4, 0.9], velocity: { dir: up, speed: [3 * en * s, 8 * en * s], spread: 1 }, gravity: 2, drag: 0.6, colorRamp: ramp(), sizeCurve: sizes(0.25, 0.05), sprite: fireLike ? "flame" : sprite, blend: "additive" },
          { shape: "sphere", radius: 0.3 * s, rate: 0, burst: Math.round(24 * dens), maxParticles: 48, lifetime: [0.8, 1.6], velocity: { dir: up, speed: [0.5, 1.5 * en], spread: 0.8 }, gravity: -0.5, colorRamp: [{ t: 0, color: mixHex(c0, "#333333", 0.5), alpha: 0.7 }, { t: 1, color: "#222222", alpha: 0 }], sizeCurve: sizes(0.4, 1.2), sprite: "smoke", blend: "alpha" },
        ],
        auras: [{ shape: "ground_decal", radius: 1.5 * s, color: c1, intensity: 1.5, pulse: { speed: 4, amount: 0.6 } }],
        lights: [{ ...light, intensity: 6 * en, range: 6 * s }],
      };
      break;
    case "rain":
      r = {
        emitters: [{ shape: "box", extents: [3 * s, 0.1, 3 * s], offset: [0, 4 * s, 0], rate: 60 * dens, maxParticles: 256, lifetime: [0.8, 1.2], velocity: { dir: [0, -1, 0], speed: [4 * en, 7 * en], spread: 0.05 }, gravity: 2, colorRamp: ramp(0.9), sizeCurve: sizes(0.06, 0.04), sprite: sprite === "ember" ? "ember" : sprite === "snow" ? "snow" : "shard", blend: "additive" }],
      };
      break;
    case "heal":
      r = {
        emitters: [{ shape: "ring", radius: 0.6 * s, rate: 20 * dens, maxParticles: 96, lifetime: [0.8, 1.4], velocity: { dir: up, speed: [0.6 * en, 1.2 * en], spread: 0.15 }, gravity: -0.3, colorRamp: ramp(), sizeCurve: sizes(0.07, 0), sprite: "mote", blend: "additive" }],
        auras: [{ shape: "column", radius: 0.7 * s, height: 1.8 * s, color: c1, intensity: 0.8, pulse: { speed: 2, amount: 0.3 } }],
        lights: [light],
      };
      break;
    case "shield":
      r = {
        auras: [{ shape: "sphere", radius: 1.1 * s, color: c1, intensity: 0.9, pulse: { speed: 1.5, amount: 0.2 } }, { shape: "ring", radius: 1.1 * s, color: c2, intensity: 1.4 }],
        emitters: [{ shape: "sphere", radius: 1.1 * s, rate: 12 * dens, maxParticles: 64, lifetime: [0.5, 1], velocity: { dir: [0, 0, 0], speed: [0, 0.2], spread: 1 }, colorRamp: ramp(0.8), sizeCurve: sizes(0.05, 0), sprite: "spark", blend: "additive" }],
      };
      break;
    case "beam":
      r = {
        emitters: [{ shape: "line", extents: [0.05, 0.05, 6 * s], rate: 80 * dens, maxParticles: 256, lifetime: [0.1, 0.25], velocity: { dir: [0, 0, 1], speed: [0.2, 0.6], spread: 0.2 }, colorRamp: ramp(), sizeCurve: sizes(0.12, 0.02), sprite: "spark", blend: "additive", local: true }],
        lights: [{ ...light, intensity: 2.5 * en }],
      };
      break;
    case "cast":
      r = {
        emitters: [{ shape: "ring", radius: 0.5 * s, rate: 30 * dens, maxParticles: 128, lifetime: [0.5, 0.9], velocity: { dir: up, speed: [0.3, 1.0 * en], spread: 0.2 }, spin: 3, colorRamp: ramp(), sizeCurve: sizes(0.06, 0), sprite: "glyph", blend: "additive" }],
        auras: [{ shape: "ground_decal", radius: 0.8 * s, color: c1, intensity: 1.4, pulse: { speed: 3, amount: 0.4 } }],
        lights: [light],
      };
      break;
    case "smoke":
      r = {
        emitters: [{ shape: "sphere", radius: 0.3 * s, rate: 10 * dens, maxParticles: 64, lifetime: [1.5, 3], velocity: { dir: up, speed: [0.2, 0.6 * en], spread: 0.4 }, gravity: -0.2, drag: 0.3, colorRamp: [{ t: 0, color: mixHex(c0, "#888888", 0.6), alpha: 0.5 }, { t: 1, color: "#444444", alpha: 0 }], sizeCurve: sizes(0.3, 1.0), sprite: "smoke", blend: "alpha" }],
      };
      break;
    case "ambient":
      r = {
        emitters: [{ shape: "sphere", radius: 1.2 * s, rate: 8 * dens, maxParticles: 64, lifetime: [2, 4], velocity: { dir: up, speed: [0.05, 0.25 * en], spread: 1 }, gravity: -0.05, colorRamp: ramp(0.9), sizeCurve: [{ t: 0, size: 0 }, { t: 0.2, size: 0.05 * s }, { t: 1, size: 0 }], sprite, blend: "additive" }],
      };
      break;
    default: // aura
      r = {
        emitters: [{ shape: "sphere", radius: 0.4 * s, rate: (isPhysical(o.element) ? 10 : 22) * dens, maxParticles: 128, lifetime: [0.6, 1.2], velocity: { dir: up, speed: [0.3, 0.9 * en], spread: 0.5 }, gravity: fireLike ? -0.8 : -0.2, colorRamp: ramp(), sizeCurve: sizes(0.07, 0), sprite, blend: "additive" }],
        auras: [{ shape: "sphere", radius: 0.5 * s, color: c1, intensity: 0.8, pulse: { speed: 2, amount: 0.25 } }],
        lights: o.light === false ? [] : [light],
      };
  }
  if (o.light === false) delete r.lights;
  r.v = 1;
  r.name = o.name;
  if (o.durationSec !== undefined) r.duration = o.durationSec;
  if (o.attach) r.attach = o.attach;
  r.tags = [o.intent, o.element.toLowerCase()];
  return clampVfx(r, c1) ?? { v: 1, emitters: [], auras: [{ shape: "sphere", radius: 0.5, color: c1, intensity: 1 }] };
}

// ------------------------------------------------------------------------------------------------ LLM compact style

/** The forge LLM's compact VFX style (expanded by vfxFromStyle). */
export const VFX_STYLE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    intent: { type: "string", enum: [...VFX_INTENTS] },
    colors: { type: "array", items: { type: "string" } },
    sprite: { type: "string", enum: [...PARTICLE_SPRITES] },
    scale: { type: "number" },
    density: { type: "number" },
    energy: { type: "number" },
    light: { type: "boolean" },
  },
  required: ["name", "intent", "colors", "sprite", "scale", "density", "energy", "light"],
} as const;

/** Expand an untrusted compact VFX style (every field optional / clamped). */
export function vfxFromStyle(raw: unknown, base: Omit<VfxOptions, "intent"> & { intent?: VfxIntent }): VfxRecipe {
  const s = isObj(raw) ? raw : {};
  return buildVfx({
    ...base,
    intent: oneOfS(VFX_INTENTS, s.intent) ?? base.intent ?? "aura",
    colors: Array.isArray(s.colors) ? s.colors.filter((c): c is string => typeof c === "string").slice(0, 3) : base.colors,
    sprite: typeof s.sprite === "string" ? s.sprite : base.sprite,
    scale: typeof s.scale === "number" ? s.scale : base.scale,
    density: typeof s.density === "number" ? s.density : base.density,
    energy: typeof s.energy === "number" ? s.energy : base.energy,
    light: typeof s.light === "boolean" ? s.light : base.light,
    name: typeof s.name === "string" && s.name.trim() ? s.name.trim().slice(0, 64) : base.name,
  });
}

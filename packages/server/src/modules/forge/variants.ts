// Looks (forge.look, forge.npc_look): Variant v1 restyles of developer assets (recolour, material swaps, decals,
// scale, part toggles, bolted-on accessories, VFX). Keyless from colour / material / glyph words; the LLM upgrade
// fills a compact look (LOOK_JSON_SCHEMA) that lookFromLlm clamps into the same Variant.
import { cleanText, type Blueprint, type Material, type Variant, type VfxRecipe } from "@liveforge/protocol";
import type { ForgeEnv } from "./env.js";
import { accessoryTemplate } from "./library/armour.js";
import { applyStyle, proceduralBlueprint } from "./procedural.js";
import { centreGuard } from "./guards.js";
import { elementPalettes, isPhysical } from "./elements.js";
import { COLOUR_WORDS, colourWords, decalGlyphs, materialWord, sizeWord } from "./looks.js";
import { buildVfx, vfxFromStyle, vfxIntent } from "./vfx.js";
import { resolveElement } from "./items.js";
import { clampN, finOr, hexOrNull, isObj, mulberry32, scaleModel, toBlueprint } from "./model.js";

export interface LookRequest { prompt: string; asset: string; slots?: string[]; seed: number }

const HIDE_RE = /\b(?:no|without|remove|hide|lose|ditch)\s+(?:the\s+|a\s+|an\s+|his\s+|her\s+|their\s+)?([a-z][a-z_-]{2,24})/gi;

/** Part toggles from "no cape", "without the helmet". */
function partToggles(text: string): Record<string, boolean> | undefined {
  const out: Record<string, boolean> = {};
  for (const m of text.matchAll(HIDE_RE)) out[m[1].toLowerCase()] = false;
  return Object.keys(out).length ? out : undefined;
}

/** Slots a look applies to: the request's, else the asset's declared slots (manifest items.assets), else "*". */
function lookSlots(env: ForgeEnv, asset: string, wanted?: string[]): string[] {
  if (wanted?.length) return wanted.slice(0, 8).map((s) => s.slice(0, 64));
  const decl = env.schema.assets.find((a) => a.id === asset);
  return decl?.slots?.length ? decl.slots.slice(0, 8) : ["*"];
}

/** Bolted-on accessories named in a prompt ("with a horned helm and a red cape"), as worn blueprints. */
export function accessories(env: ForgeEnv, text: string, element: string, seed: number): Array<{ point: string; blueprint: Blueprint }> {
  const out: Array<{ point: string; blueprint: Blueprint }> = [];
  const chunks = text.split(/\b(?:with|and|plus|wearing|,)\b/i).map((c) => c.trim()).filter(Boolean);
  const seen = new Set<string>();
  for (const [i, chunk] of chunks.entries()) {
    const t = accessoryTemplate(chunk);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    let m = proceduralBlueprint(t, element, (seed + i * 31) >>> 0);
    const cols = colourWords(chunk);
    if (cols.length) m = applyStyle(m, { p: cols.slice(0, 3) }, t.baseLength);
    delete m.trail;
    scaleModel(m, t.baseLength);
    centreGuard(m);
    out.push({ point: POINT_FOR[t.id] ?? "socket_head", blueprint: toBlueprint(m, { kind: "npc_accessory", frame: "worn", name: t.name, maxParts: env.maxParts, source: "procedural", seed, tags: [t.id] }) });
    if (out.length >= 3) break;
  }
  return out;
}
const POINT_FOR: Record<string, string> = {
  crown: "socket_head", helmet: "socket_head", cape: "socket_back", pauldron: "socket_shoulder", breastplate: "socket_chest",
  amulet: "socket_neck", ring: "socket_hand", belt: "socket_waist", gloves: "socket_hand", boots: "socket_feet", greaves: "socket_legs",
};

/** Keyless look: a Variant of `asset` from the prompt's colours, materials, glyphs, size and element. */
export function forgeLookRules(env: ForgeEnv, req: LookRequest): Variant {
  const text = req.prompt.trim();
  const rnd = mulberry32(req.seed ^ 0x5be0cd19);
  const element = resolveElement(env, text);
  const pals = elementPalettes(element);
  const pal = pals[Math.floor(rnd() * pals.length) % pals.length];
  const cols = colourWords(text);
  const mat = materialWord(text);
  const phys = isPhysical(element);
  const recolour: NonNullable<Variant["recolour"]> = [];
  const primary = cols[0] ?? (phys ? null : pal.metal);
  if (primary) recolour.push({ from: "primary", to: primary });
  const secondary = cols[1] ?? (phys && !cols.length ? null : pal.grip);
  if (secondary) recolour.push({ from: "secondary", to: secondary });
  const trim = cols[2] ?? (cols.length || !phys ? pal.accent : null);
  if (trim) recolour.push({ from: "trim", to: trim });
  if (!phys) recolour.push({ from: "accent", to: pal.glow });
  if (!recolour.length) {
    // nothing named: a seeded palette so every request still looks different
    recolour.push({ from: "primary", to: pal.metal }, { from: "secondary", to: pal.grip }, { from: "trim", to: pal.accent });
  }
  const slots = lookSlots(env, req.asset, req.slots);
  const materialSwaps: Variant["materialSwaps"] = [];
  if (mat) {
    const m: Material = { color: mat.color ?? cols[0] ?? pal.metal };
    if (mat.metalness !== undefined) m.metalness = mat.metalness;
    if (mat.roughness !== undefined) m.roughness = mat.roughness;
    if (mat.opacity !== undefined) m.opacity = mat.opacity;
    if (mat.emissiveIntensity) { m.emissive = phys ? (cols[0] ?? pal.glow) : pal.glow; m.emissiveIntensity = mat.emissiveIntensity; }
    for (const slot of slots) materialSwaps.push({ slot, material: m });
  }
  const glyphs = decalGlyphs(text, env.factions);
  const variant: Variant = {
    v: 1,
    baseAsset: req.asset,
    name: cleanText(text, 64) || undefined,
    materialSwaps,
    recolour,
    ...(glyphs.length ? { decals: glyphs.map((g, i) => ({ glyph: g, on: i === 0 ? "chest" : "back", size: 0.3, color: trim ?? pal.accent })) } : {}),
    ...(sizeWord(text) ? { scale: sizeWord(text)! } : {}),
    ...(partToggles(text) ? { partToggles: partToggles(text) } : {}),
    tags: [element, ...(mat ? ["material"] : [])],
  };
  const acc = accessories(env, text, element, req.seed);
  if (acc.length) variant.attachments = acc;
  if (!phys || mat?.emissiveIntensity) {
    variant.vfx = [buildVfx({ intent: vfxIntent(text, "aura"), element, scale: 0.8, density: 0.6, attach: "vfx_core", seed: req.seed, name: `${variant.name ?? "look"} glow` })];
  }
  if (!variant.name) delete variant.name;
  return variant;
}

// ------------------------------------------------------------------------------------------------ LLM compact look

const ROLES = ["primary", "secondary", "trim", "accent"] as const;

/** Compact look the LLM fills (one structured call). */
export function lookJsonSchema() {
  const str = { type: "string" } as const;
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      name: str,
      primary: str, secondary: str, trim: str, accent: str,
      metalness: { type: "number" }, roughness: { type: "number" },
      glow: str,
      decals: { type: "array", items: str },
      scale: { type: "number" },
      hide: { type: "array", items: str },
      vfxIntent: { type: "string", enum: ["none", "aura", "ambient", "smoke", "trail", "shield", "heal"] },
    },
    required: ["name", "primary", "secondary", "trim", "accent", "metalness", "roughness", "glow", "decals", "scale", "hide", "vfxIntent"],
  } as const;
}

/** LLM look -> clamped Variant (falls back field by field to the keyless look). */
export function lookFromLlm(env: ForgeEnv, raw: unknown, req: LookRequest, fallback: Variant): Variant | null {
  if (!isObj(raw)) return null;
  const element = resolveElement(env, req.prompt);
  const recolour: NonNullable<Variant["recolour"]> = [];
  for (const r of ROLES) {
    const hex = hexOrNull(raw[r]) ?? (typeof raw[r] === "string" ? COLOUR_WORDS[(raw[r] as string).toLowerCase()] ?? null : null);
    if (hex) recolour.push({ from: r, to: hex });
  }
  const glow = hexOrNull(raw.glow);
  const slots = lookSlots(env, req.asset, req.slots);
  const metal = typeof raw.metalness === "number" ? clampN(raw.metalness, 0, 1) : null;
  const rough = typeof raw.roughness === "number" ? clampN(raw.roughness, 0, 1) : null;
  const materialSwaps: Variant["materialSwaps"] = [];
  if (metal !== null || rough !== null || glow) {
    const base = recolour.find((r) => r.from === "primary")?.to ?? fallback.recolour?.[0]?.to ?? "#b8c0c8";
    const m: Material = { color: base };
    if (metal !== null) m.metalness = metal;
    if (rough !== null) m.roughness = rough;
    if (glow) { m.emissive = glow; m.emissiveIntensity = 1; }
    for (const slot of slots) materialSwaps.push({ slot, material: m });
  }
  const decals = (Array.isArray(raw.decals) ? raw.decals : []).filter((d): d is string => typeof d === "string" && !!d.trim()).slice(0, 3)
    .map((g, i) => ({ glyph: g.trim().toLowerCase().replace(/[^a-z0-9_ -]/g, "").slice(0, 64) || "rune", on: i === 0 ? "chest" : "back", size: 0.3 }));
  const hide = (Array.isArray(raw.hide) ? raw.hide : []).filter((h): h is string => typeof h === "string" && !!h.trim()).slice(0, 8);
  const intent = typeof raw.vfxIntent === "string" && raw.vfxIntent !== "none" ? raw.vfxIntent : null;
  const scale = clampN(finOr(raw.scale, 1), 0.5, 2);
  let vfx: VfxRecipe[] | undefined = fallback.vfx;
  if (intent) vfx = [vfxFromStyle({ intent, colors: [recolour[0]?.to ?? "", glow ?? "", recolour[2]?.to ?? ""] }, { element, scale: 0.8, density: 0.6, attach: "vfx_core", seed: req.seed })];
  else if (raw.vfxIntent === "none") vfx = undefined;
  const v: Variant = {
    v: 1,
    baseAsset: req.asset,
    name: cleanText(raw.name, 64) || fallback.name,
    materialSwaps,
    recolour: recolour.length ? recolour : fallback.recolour,
    ...(decals.length ? { decals } : fallback.decals ? { decals: fallback.decals } : {}),
    ...(Math.abs(scale - 1) > 0.01 ? { scale: Math.round(scale * 100) / 100 } : {}),
    ...(hide.length ? { partToggles: Object.fromEntries(hide.map((h) => [h.toLowerCase().slice(0, 64), false])) } : {}),
    ...(fallback.attachments ? { attachments: fallback.attachments } : {}),
    ...(vfx ? { vfx } : {}),
    tags: fallback.tags,
  };
  if (!v.name) delete v.name;
  return v;
}

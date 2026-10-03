// Hand-tuned sample Blueprints + VFX recipes (Blueprint v1 / VFX v1). The demo source uses them as forge output,
// and the gallery falls back to them for previews when a result carries no blueprint.
import type { Blueprint, BlueprintPart, Material, VfxRecipe } from "@liveforge/protocol";

const PI = Math.PI;
const mat = (color: string, o: Partial<Material> = {}): Material => ({ color, metalness: 0.4, roughness: 0.5, flatShading: true, ...o });
const glow = (color: string, intensity = 1.6): Material => ({ color, emissive: color, emissiveIntensity: intensity, metalness: 0.1, roughness: 0.3, flatShading: true });
const part = (p: Omit<BlueprintPart, "rotation"> & { rotation?: BlueprintPart["rotation"] }): BlueprintPart => ({ rotation: [0, 0, 0], ...p });

export const ELEMENT_COLORS: Record<string, string> = {
  fire: "#ff6a2a",
  ice: "#7fd6ff",
  lightning: "#ffe066",
  physical: "#d8dde6",
  veil: "#b18cff",
};

export function vfxFor(element: string, kind: "aura" | "trail" | "burst" = "aura"): VfxRecipe {
  const c = ELEMENT_COLORS[element] ?? ELEMENT_COLORS.veil;
  if (element === "ice") {
    return {
      v: 1, name: "Frost motes", attach: "tip", tags: ["ice", kind],
      emitters: [{
        shape: "sphere", radius: 0.25, rate: 40, maxParticles: 160, lifetime: [1.2, 2.2],
        velocity: { dir: [0, 1, 0], speed: [0.05, 0.25], spread: 1 }, gravity: 0.15, drag: 0.4,
        colorRamp: [{ t: 0, color: "#ffffff", alpha: 0 }, { t: 0.2, color: c, alpha: 1 }, { t: 1, color: "#2d6cff", alpha: 0 }],
        sizeCurve: [{ t: 0, size: 0.02 }, { t: 0.5, size: 0.06 }, { t: 1, size: 0.01 }], sprite: "snow", blend: "additive",
      }],
      lights: [{ color: c, intensity: 1.2, range: 3 }],
    };
  }
  if (element === "lightning") {
    return {
      v: 1, name: "Arc sparks", attach: "tip", tags: ["lightning", kind],
      emitters: [{
        shape: "point", rate: 70, burst: 20, maxParticles: 200, lifetime: [0.15, 0.45],
        velocity: { dir: [0, 1, 0], speed: [1.5, 3.5], spread: 1 }, gravity: 2, drag: 0.6,
        colorRamp: [{ t: 0, color: "#ffffff", alpha: 1 }, { t: 0.4, color: c, alpha: 1 }, { t: 1, color: "#4d7bff", alpha: 0 }],
        sizeCurve: [{ t: 0, size: 0.05 }, { t: 1, size: 0.005 }], sprite: "spark", blend: "additive",
      }],
      lights: [{ color: c, intensity: 2.2, range: 4, flicker: 0.8 }],
    };
  }
  if (element === "veil") {
    return {
      v: 1, name: "Veil shimmer", attach: "vfx_core", tags: ["veil", kind],
      emitters: [{
        shape: "ring", radius: 0.5, rate: 50, maxParticles: 220, lifetime: [1.5, 3], spin: 1.5,
        velocity: { dir: [0, 1, 0], speed: [0.1, 0.4], spread: 0.3 }, gravity: -0.1,
        colorRamp: [{ t: 0, color: "#ffffff", alpha: 0 }, { t: 0.3, color: c, alpha: 0.9 }, { t: 1, color: "#3a1d7a", alpha: 0 }],
        sizeCurve: [{ t: 0, size: 0.03 }, { t: 0.6, size: 0.08 }, { t: 1, size: 0.02 }], sprite: "mote", blend: "additive",
      }],
      auras: [{ shape: "ring", radius: 0.6, color: c, intensity: 1.2, pulse: { speed: 1.4, amount: 0.4 } }],
      lights: [{ color: c, intensity: 1.4, range: 4 }],
    };
  }
  return {
    v: 1, name: element === "fire" ? "Ember plume" : "Forge sparks", attach: "tip", tags: [element, kind],
    emitters: [{
      shape: "cone", radius: 0.08, angle: 25, rate: 55, maxParticles: 220, lifetime: [0.6, 1.4],
      velocity: { dir: [0, 1, 0], speed: [0.4, 1.2], spread: 0.35 }, gravity: -0.6, drag: 0.2,
      colorRamp: [{ t: 0, color: "#fff3c4", alpha: 1 }, { t: 0.35, color: c, alpha: 0.95 }, { t: 1, color: "#3a0d00", alpha: 0 }],
      sizeCurve: [{ t: 0, size: 0.06 }, { t: 0.4, size: 0.09 }, { t: 1, size: 0.01 }], sprite: "ember", blend: "additive",
    }],
    lights: [{ color: c, intensity: 1.8, range: 3.5, flicker: 0.35 }],
  };
}

export type SampleKind = "sword" | "axe" | "staff" | "hammer" | "shield" | "helm" | "hound" | "lantern" | "spear";
export const SAMPLE_KINDS: SampleKind[] = ["sword", "axe", "staff", "hammer", "shield", "helm", "hound", "lantern", "spear"];

/** A ready-to-render sample blueprint, tinted by element. */
export function sampleBlueprint(kind: SampleKind, element = "fire", name?: string): Blueprint {
  const accent = ELEMENT_COLORS[element] ?? ELEMENT_COLORS.fire;
  const steel = "#b9c2cf";
  const dark = "#2a2f3a";
  const leather = "#5a3a22";
  const gold = "#d4af37";
  const base = (parts: BlueprintPart[], kindName: Blueprint["kind"], palette: string[], extra: Partial<Blueprint> = {}): Blueprint => ({
    v: 1, kind: kindName, name, parts, palette, attachments: [], source: "procedural", tags: [element], ...extra,
  });
  switch (kind) {
    case "sword":
      return base([
        part({ role: "blade", shape: "wedge", size: [0.11, 0.95, 0.025], offset: [0, 0.68, 0], material: mat(steel, { metalness: 0.85, roughness: 0.25 }) }),
        part({ role: "rune", shape: "box", size: [0.02, 0.6, 0.03], offset: [0, 0.6, 0], material: glow(accent, 1.4), anim: { kind: "pulse", speed: 2, amount: 0.4 } }),
        part({ role: "guard", shape: "crescent", size: [0.42, 0.1, 0.07], offset: [0, 0.18, 0], rotation: [0, 0, PI], material: mat(gold, { metalness: 0.9, roughness: 0.3 }) }),
        part({ role: "handle", shape: "cylinder", size: [0.05, 0.24, 0.05], offset: [0, 0.03, 0], material: mat(leather, { metalness: 0, roughness: 0.9 }) }),
        part({ role: "pommel", shape: "octahedron", size: [0.08, 0.1, 0.08], offset: [0, -0.12, 0], material: glow(accent, 1.2), anim: { kind: "spin", speed: 1.5, amount: 1 } }),
      ], "item", [steel, leather, gold, accent], {
        attachments: [{ name: "grip", position: [0, 0.03, 0], kind: "grip" }, { name: "tip", position: [0, 1.15, 0], kind: "tip" }],
        trail: { color: accent, width: 0.12 }, vfx: [vfxFor(element)],
      });
    case "spear":
      return base([
        part({ role: "handle", shape: "cylinder", size: [0.045, 1.5, 0.045], offset: [0, 0.4, 0], material: mat("#6b4a2b", { metalness: 0, roughness: 0.85 }) }),
        part({ role: "head", shape: "wedge", size: [0.12, 0.34, 0.04], offset: [0, 1.32, 0], material: mat(steel, { metalness: 0.9, roughness: 0.2 }) }),
        part({ role: "ring", shape: "torus", size: [0.1, 0.1, 0.04], offset: [0, 1.13, 0], rotation: [PI / 2, 0, 0], material: mat(gold, { metalness: 0.9 }) }),
        part({ role: "cloth", shape: "prism", size: [0.08, 0.22, 0.02], offset: [0.06, 1.05, 0], rotation: [0, 0, 0.3], material: mat(accent, { metalness: 0, roughness: 0.8 }), anim: { kind: "wobble", speed: 3, amount: 0.3 } }),
      ], "item", [steel, "#6b4a2b", gold, accent], { attachments: [{ name: "tip", position: [0, 1.5, 0], kind: "tip" }], vfx: [vfxFor(element)] });
    case "axe":
      return base([
        part({ role: "handle", shape: "cylinder", size: [0.06, 1.0, 0.06], offset: [0, 0.35, 0], material: mat("#4a2f1c", { metalness: 0, roughness: 0.9 }) }),
        part({ role: "head", shape: "crescent", size: [0.5, 0.4, 0.05], offset: [0.2, 0.78, 0], rotation: [0, 0, -PI / 2], material: mat(steel, { metalness: 0.85, roughness: 0.3 }) }),
        part({ role: "spike", shape: "cone", size: [0.08, 0.22, 0.08], offset: [-0.12, 0.78, 0], rotation: [0, 0, PI / 2], material: mat(dark, { metalness: 0.7 }) }),
        part({ role: "gem", shape: "icosahedron", size: [0.09, 0.09, 0.09], offset: [0.02, 0.78, 0.04], material: glow(accent, 1.8), anim: { kind: "pulse", speed: 2.5, amount: 0.5 } }),
      ], "item", [steel, "#4a2f1c", dark, accent], { attachments: [{ name: "tip", position: [0.35, 0.8, 0], kind: "tip" }], vfx: [vfxFor(element)] });
    case "staff":
      return base([
        part({ role: "handle", shape: "cylinder", size: [0.05, 1.5, 0.05], offset: [0, 0.45, 0], material: mat("#3b2a4a", { metalness: 0.1, roughness: 0.8 }) }),
        part({ role: "frame", shape: "torus", size: [0.3, 0.3, 0.04], offset: [0, 1.32, 0], material: mat(gold, { metalness: 0.9, roughness: 0.25 }), anim: { kind: "spin", speed: 0.8, amount: 1 } }),
        part({ role: "orb", shape: "icosahedron", size: [0.18, 0.18, 0.18], offset: [0, 1.32, 0], material: glow(accent, 2.2), anim: { kind: "float", speed: 1.4, amount: 0.3 } }),
        part({ role: "shard", shape: "octahedron", size: [0.05, 0.12, 0.05], offset: [0.24, 1.32, 0], material: glow(accent, 1.4), anim: { kind: "orbit", speed: 1.2, amount: 0.8 } }),
      ], "item", ["#3b2a4a", gold, accent], { attachments: [{ name: "tip", position: [0, 1.32, 0], kind: "tip" }, { name: "vfx_core", position: [0, 1.32, 0], kind: "vfx" }], vfx: [vfxFor(element)] });
    case "hammer":
      return base([
        part({ role: "handle", shape: "cylinder", size: [0.07, 1.1, 0.07], offset: [0, 0.35, 0], material: mat("#4a2f1c", { metalness: 0, roughness: 0.9 }) }),
        part({ role: "head", shape: "box", size: [0.5, 0.26, 0.26], offset: [0, 0.95, 0], material: mat(dark, { metalness: 0.75, roughness: 0.4 }) }),
        part({ role: "rim", shape: "box", size: [0.06, 0.3, 0.3], offset: [0.22, 0.95, 0], mirror: "x", material: mat(gold, { metalness: 0.9 }) }),
        part({ role: "rune", shape: "box", size: [0.3, 0.05, 0.27], offset: [0, 0.95, 0], material: glow(accent, 1.6), anim: { kind: "flicker", speed: 4, amount: 0.5 } }),
      ], "item", [dark, "#4a2f1c", gold, accent], { attachments: [{ name: "tip", position: [0, 1.05, 0], kind: "tip" }], vfx: [vfxFor(element)] });
    case "shield":
      return base([
        part({ role: "body", shape: "cylinder", size: [0.75, 0.07, 0.75], offset: [0, 0.6, 0], rotation: [PI / 2, 0, 0], material: mat("#3a4a63", { metalness: 0.6, roughness: 0.45 }) }),
        part({ role: "rim", shape: "torus", size: [0.78, 0.78, 0.07], offset: [0, 0.6, 0], material: mat(gold, { metalness: 0.9, roughness: 0.25 }) }),
        part({ role: "decor", shape: "octahedron", size: [0.2, 0.28, 0.08], offset: [0, 0.6, 0.06], material: glow(accent, 1.5), anim: { kind: "pulse", speed: 1.6, amount: 0.4 } }),
      ], "item", ["#3a4a63", gold, accent], { attachments: [{ name: "vfx_core", position: [0, 0.6, 0.1], kind: "vfx" }], vfx: [vfxFor(element, "aura")] });
    case "helm":
      return base([
        part({ role: "helm", shape: "sphere", size: [0.36, 0.34, 0.38], offset: [0, 0.55, 0], material: mat(steel, { metalness: 0.85, roughness: 0.3 }) }),
        part({ role: "visor", shape: "box", size: [0.3, 0.06, 0.06], offset: [0, 0.54, 0.17], material: glow(accent, 1.8) }),
        part({ role: "horn", shape: "cone", size: [0.08, 0.3, 0.08], offset: [0.2, 0.75, 0], rotation: [0, 0, -0.6], mirror: "x", material: mat("#e8dcc0", { metalness: 0.1, roughness: 0.6 }) }),
        part({ role: "trim", shape: "torus", size: [0.38, 0.38, 0.05], offset: [0, 0.42, 0], rotation: [PI / 2, 0, 0], material: mat(gold, { metalness: 0.9 }) }),
      ], "armour", [steel, gold, accent], { attachments: [{ name: "socket_head", position: [0, 0.4, 0], kind: "socket" }] });
    case "hound":
      return base([
        part({ role: "torso", shape: "capsule", size: [0.32, 0.8, 0.32], offset: [0, 0.55, 0], rotation: [0, 0, PI / 2], material: mat("#2e2622", { metalness: 0.1, roughness: 0.9 }) }),
        part({ role: "head", shape: "box", size: [0.28, 0.24, 0.3], offset: [0.5, 0.72, 0], material: mat("#3a302a", { metalness: 0.1, roughness: 0.9 }) }),
        part({ role: "eye", shape: "sphere", size: [0.05, 0.05, 0.05], offset: [0.64, 0.77, 0.08], mirror: "z", material: glow(accent, 2.5), anim: { kind: "flicker", speed: 3, amount: 0.4 } }),
        part({ role: "leg", shape: "cylinder", size: [0.07, 0.4, 0.07], offset: [0.25, 0.2, 0.12], mirror: "z", material: mat("#2e2622", { metalness: 0.1, roughness: 0.9 }) }),
        part({ role: "leg", shape: "cylinder", size: [0.07, 0.4, 0.07], offset: [-0.25, 0.2, 0.12], mirror: "z", material: mat("#2e2622", { metalness: 0.1, roughness: 0.9 }) }),
        part({ role: "tail", shape: "cone", size: [0.08, 0.35, 0.08], offset: [-0.55, 0.7, 0], rotation: [0, 0, 1.1], material: glow(accent, 1.2), anim: { kind: "wobble", speed: 4, amount: 0.4 } }),
        part({ role: "spike", shape: "cone", size: [0.06, 0.16, 0.06], offset: [0.05, 0.78, 0], material: mat(accent, { metalness: 0.3 }) }),
      ], "creature", ["#2e2622", accent], { vfx: [{ ...vfxFor(element), attach: "vfx_core" }], attachments: [{ name: "vfx_core", position: [0, 0.7, 0], kind: "vfx" }] });
    case "lantern":
      return base([
        part({ role: "base", shape: "cylinder", size: [0.3, 0.06, 0.3], offset: [0, 0.03, 0], material: mat(dark, { metalness: 0.7 }) }),
        part({ role: "frame", shape: "prism", size: [0.28, 0.42, 0.28], offset: [0, 0.27, 0], material: mat(gold, { metalness: 0.9, roughness: 0.3, opacity: 0.35 }) }),
        part({ role: "flame", shape: "cone", size: [0.12, 0.22, 0.12], offset: [0, 0.25, 0], material: glow(accent, 2.6), anim: { kind: "flicker", speed: 6, amount: 0.6 } }),
        part({ role: "lid", shape: "cone", size: [0.34, 0.14, 0.34], offset: [0, 0.55, 0], material: mat(dark, { metalness: 0.7 }) }),
        part({ role: "ring", shape: "torus", size: [0.1, 0.1, 0.02], offset: [0, 0.66, 0], material: mat(gold, { metalness: 0.9 }) }),
      ], "prop", [dark, gold, accent], { attachments: [{ name: "vfx_core", position: [0, 0.3, 0], kind: "vfx" }], vfx: [{ ...vfxFor(element), attach: "vfx_core" }] });
  }
}

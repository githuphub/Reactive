// Look vocabulary for the keyless forge: colour words, material words and decal glyphs found in a prompt. Shared by
// forge.look (Variant), forge.npc_look and the item / armour paths (a "golden" sword gets a gold main colour).
import type { Material } from "@liveforge/protocol";
import { keywordRe } from "./keywords.js";

/** Colour words -> "#rrggbb" (order of appearance in the prompt matters: first = primary). */
export const COLOUR_WORDS: Record<string, string> = {
  red: "#d62839", crimson: "#a01c2a", scarlet: "#e0242f", maroon: "#6b1420", ruby: "#c4122f", rose: "#ff6f91", pink: "#ff70b8",
  orange: "#ff8a2a", amber: "#ffb02e", yellow: "#ffd23f", gold: "#f5c542", golden: "#f5c542", brass: "#c99a3d", bronze: "#b87333",
  copper: "#cf6f3a", brown: "#7b4526", tan: "#c8a27a", beige: "#e8d8b8", cream: "#f3e2b8", ivory: "#f4efdf", bone: "#efe5cc",
  white: "#f5f5f5", silver: "#c9d2dc", grey: "#8c8780", gray: "#8c8780", steel: "#9ba8b6", iron: "#6f7883", black: "#18191e",
  obsidian: "#1b1724", charcoal: "#2c3039", green: "#3daa4f", emerald: "#1f9d55", jade: "#3fb68b", lime: "#a6e22e",
  olive: "#6b7a2a", moss: "#5d8a3a", teal: "#19b3a3", cyan: "#59e3ff", turquoise: "#2ed3c6", aqua: "#4fe3ff",
  blue: "#2f6fde", azure: "#3b8eff", sapphire: "#1f4fbf", navy: "#22346e", cobalt: "#2347b8", indigo: "#4b3bb8",
  purple: "#7a46d0", violet: "#9b5cff", lavender: "#b9a3ff", amethyst: "#9966cc", magenta: "#e0309f", plum: "#7d3c6b",
};
const COLOUR_RE = new RegExp(`\\b(${Object.keys(COLOUR_WORDS).join("|")})\\b`, "gi");

/** Colours named in a prompt, in order (deduplicated). */
export function colourWords(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(COLOUR_RE)) {
    const hex = COLOUR_WORDS[m[1].toLowerCase()];
    if (hex && !out.includes(hex)) out.push(hex);
  }
  return out;
}

/** Material words -> a material preset (colour optional: the recolour keeps the asset's own colour then). */
const MATERIAL_WORDS: Array<[RegExp, Omit<Material, "color"> & { color?: string }]> = [
  [keywordRe(["gold", "golden", "gilded"]), { color: "#f5c542", metalness: 1, roughness: 0.25 }],
  [keywordRe(["silver", "chrome", "mirror", "polished"]), { color: "#d9e2ea", metalness: 1, roughness: 0.15 }],
  [keywordRe(["steel", "iron", "metal", "metallic", "plate"]), { metalness: 0.85, roughness: 0.4 }],
  [keywordRe(["rusty", "rusted", "corroded"]), { color: "#8a4b2a", metalness: 0.5, roughness: 0.9 }],
  [keywordRe(["obsidian", "glass", "glassy"]), { color: "#1b1724", metalness: 0.2, roughness: 0.05 }],
  [keywordRe(["crystal", "crystalline", "gem", "gemstone", "diamond"]), { metalness: 0.1, roughness: 0.05, opacity: 0.8 }],
  [keywordRe(["wood", "wooden", "oak", "timber"]), { color: "#8b5a2b", metalness: 0, roughness: 0.85 }],
  [keywordRe(["bone", "skeletal", "ivory"]), { color: "#efe5cc", metalness: 0, roughness: 0.7 }],
  [keywordRe(["leather", "hide"]), { color: "#7b4526", metalness: 0, roughness: 0.8 }],
  [keywordRe(["stone", "marble", "granite"]), { color: "#8c8780", metalness: 0, roughness: 0.95 }],
  [keywordRe(["cloth", "silk", "velvet", "wool", "linen"]), { metalness: 0, roughness: 1 }],
  [keywordRe(["ghostly", "spectral", "ethereal", "translucent"]), { metalness: 0, roughness: 0.3, opacity: 0.55 }],
  [keywordRe(["glowing", "luminous", "radiant", "neon", "shining"]), { metalness: 0.2, roughness: 0.4, emissiveIntensity: 1.4 }],
];

/** The first material preset a prompt names, or null. */
export function materialWord(text: string): (Omit<Material, "color"> & { color?: string }) | null {
  for (const [re, m] of MATERIAL_WORDS) if (re.test(text)) return { ...m };
  return null;
}

/** Decal glyph words (SDKs map glyph names to their own emblem art). */
const GLYPHS = [
  "skull", "sun", "moon", "star", "flame", "rune", "heart", "crown", "eye", "dragon", "wolf", "raven", "rose", "anvil",
  "sword", "shield", "tree", "leaf", "snowflake", "lightning", "wave", "spiral", "cross", "claw", "feather", "key", "coin",
] as const;
const GLYPH_RE = keywordRe([...GLYPHS], "gi");

/** Glyph names a prompt mentions (also any manifest faction id mentioned, as an emblem). */
export function decalGlyphs(text: string, factions: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(GLYPH_RE)) {
    const g = m[0].toLowerCase().replace(/(?:es|s)$/, "");
    const hit = GLYPHS.find((x) => x === g || x === m[0].toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
  }
  for (const f of factions) if (new RegExp(`\\b${f.replace(/[_-]/g, "[ _-]?")}\\b`, "i").test(text) && !out.includes(f)) out.push(f);
  return out.slice(0, 3);
}

/** Size words -> uniform scale. */
export function sizeWord(text: string): number | null {
  if (/\b(tiny|miniature|mini|small|little|petite)\b/i.test(text)) return 0.8;
  if (/\b(huge|giant|massive|enormous|colossal|oversized|big|large|towering)\b/i.test(text)) return 1.25;
  return null;
}

// Element looks for any manifest element name. Counterforge's four element palettes (fire / ice / lightning /
// physical) are kept verbatim; common fantasy elements get hand-picked palettes, and an unknown element name gets a
// stable generated palette (hue from its hash), so a game with "spore" or "chrono" still looks consistent.
import type { ParticleKind, VfxRecipe } from "@liveforge/protocol";
import { hashString, hslHex, mixHex } from "./model.js";

export interface ElementPalette { metal: string; glow: string; accent: string; dark: string; grip: string }

const P = (metal: string, glow: string, accent: string, dark: string, grip: string): ElementPalette => ({ metal, glow, accent, dark, grip });

/** Known element looks (lowercase names; synonyms resolve through ELEMENT_ALIASES). */
const PALETTES: Record<string, ElementPalette[]> = {
  fire: [
    P("#ff9a4a", "#ff5a1f", "#ffd23f", "#3b1510", "#5a2412"),
    P("#ff7a3d", "#ff3b1f", "#ffb02e", "#2a0f0c", "#7a2a16"),
    P("#3a2622", "#ff6a00", "#ff3d3d", "#140b09", "#3d1a10"),
  ],
  ice: [
    P("#c9f6ff", "#4fe3ff", "#ffffff", "#1b3c5e", "#2c5b85"),
    P("#8fd8ff", "#7affff", "#d7c4ff", "#14284a", "#e8f6ff"),
    P("#e8fbff", "#5fb8ff", "#9ae6ff", "#203a6a", "#4a6fa5"),
  ],
  lightning: [
    P("#fff4a0", "#ffe14f", "#9b7bff", "#25204a", "#3a2f6b"),
    P("#d9d4ff", "#b38bff", "#ffe14f", "#1c1838", "#2b2552"),
    P("#e6f0ff", "#57d0ff", "#fff36b", "#1a2236", "#33405e"),
  ],
  physical: [
    P("#d5dee8", "#ff4d6d", "#f5c542", "#2c3039", "#8e1b2e"),
    P("#d9a066", "#1fd1b9", "#2bb3a0", "#3a2a1a", "#1e5f58"),
    P("#4a4560", "#b56cff", "#e0c3ff", "#15121f", "#4a2f6b"),
    P("#7fd6a0", "#3dff9a", "#f5c542", "#1d3b2a", "#7b4526"),
    P("#efe5cc", "#ff3355", "#b8733a", "#2a1b16", "#4b2a17"),
    P("#9fb7ff", "#4f7bff", "#ffffff", "#1a2350", "#22346e"),
  ],
  poison: [P("#9be564", "#6dff3a", "#d6ff5a", "#1d2b12", "#3f4a1d"), P("#5f8f3a", "#a6ff00", "#b05cff", "#16200f", "#2e3b1b")],
  holy: [P("#fff6d8", "#ffe28a", "#ffffff", "#5a4a20", "#c9a24a"), P("#f5f0ff", "#ffd86b", "#9fd8ff", "#3a3350", "#d4b06a")],
  shadow: [P("#3b3350", "#9b5cff", "#ff4dd2", "#0d0b14", "#241d33"), P("#2a2a35", "#6f5cff", "#c0c0ff", "#08080c", "#1a1a24")],
  water: [P("#7fc8ff", "#3aa0ff", "#c8f4ff", "#0f2a4a", "#1f4f7a"), P("#5fd3c8", "#2ff0ff", "#ffffff", "#0c2a30", "#1d5a60")],
  earth: [P("#a07850", "#d9a441", "#7fae5a", "#2e2014", "#5a3b22"), P("#8c8780", "#e0b050", "#6b8e4e", "#24201c", "#4b3a2a")],
  wind: [P("#e2fff4", "#8affd4", "#ffffff", "#2f5048", "#6fb8a0"), P("#d8f0ff", "#9fe8ff", "#e8fff0", "#2a4050", "#7ab0c8")],
  arcane: [P("#c9a8ff", "#b05cff", "#5fd3ff", "#1d1238", "#3a2470"), P("#a8b8ff", "#7a5cff", "#ff8ad8", "#141238", "#2e2a70")],
  nature: [P("#7fb85a", "#9dff5a", "#ffd86b", "#1d2b12", "#5e3b1d"), P("#5d8a3a", "#c4ff7a", "#ff9ab8", "#16200f", "#4b2a17")],
  blood: [P("#a01c2a", "#ff2d4a", "#ffb0b8", "#2a0a10", "#4a1018")],
  void: [P("#1a1a24", "#7a5cff", "#00e5ff", "#000000", "#14141c")],
};

/** Synonyms -> canonical palette key. */
const ELEMENT_ALIASES: Record<string, string> = {
  flame: "fire", heat: "fire", lava: "fire", magma: "fire", inferno: "fire", burn: "fire",
  frost: "ice", cold: "ice", snow: "ice", cryo: "ice", glacial: "ice",
  shock: "lightning", electric: "lightning", thunder: "lightning", storm: "lightning", volt: "lightning", energy: "lightning",
  none: "physical", neutral: "physical", normal: "physical", blunt: "physical", slash: "physical", pierce: "physical", kinetic: "physical",
  toxic: "poison", acid: "poison", venom: "poison", plague: "poison",
  light: "holy", radiant: "holy", divine: "holy", sacred: "holy", sun: "holy",
  dark: "shadow", darkness: "shadow", necrotic: "shadow", death: "shadow", curse: "shadow", unholy: "shadow",
  aqua: "water", tide: "water", ocean: "water",
  stone: "earth", rock: "earth", ground: "earth",
  air: "wind", sky: "wind",
  magic: "arcane", mana: "arcane", psychic: "arcane", ether: "arcane", chaos: "arcane",
  life: "nature", plant: "nature", wood: "nature", druidic: "nature",
};

/** Keywords that imply each canonical element in a prompt (whole words; "price" / "dice" never match "ice"). */
export const ELEMENT_WORDS: Record<string, string> = {
  fire: "flame|flames|flaming|fire|fiery|blaze|blazing|burning|burn|magma|lava|molten|ember|embers|inferno|volcano|volcanic|solar|scorching|cinder",
  ice: "ice|icy|frost|frosty|frozen|freezing|snow|snowy|glacier|glacial|cold|winter|arctic|rime",
  lightning: "storm|stormy|lightning|thunder|thundering|electric|electrified|spark|sparking|shock|shocking|volt|tesla",
  poison: "poison|poisoned|poisonous|toxic|venom|venomous|acid|acidic|plague|blight",
  holy: "holy|divine|sacred|radiant|blessed|angelic|sun|sunlit|celestial",
  shadow: "shadow|shadows|dark|darkness|cursed|necrotic|unholy|void|abyssal|night",
  water: "water|tidal|tide|ocean|sea|aqua|wave|waves",
  earth: "earth|stone|rock|granite|boulder|mountain|quake",
  wind: "wind|gale|gust|cyclone|tornado|air|breeze",
  arcane: "arcane|magic|magical|mystic|eldritch|astral|mana|rune",
  nature: "nature|leaf|leaves|vine|vines|thorn|thorns|forest|bloom|flower|moss",
  blood: "blood|bloody|crimson|vampire|vampiric",
};

/** The canonical palette key for an element name ("Fire" -> fire, "frost" -> ice); null when unknown. */
export function canonicalElement(element: string): string | null {
  const e = element.trim().toLowerCase();
  if (PALETTES[e]) return e;
  return ELEMENT_ALIASES[e] ?? null;
}

/** True for the "no element" look (physical / none / neutral). */
export function isPhysical(element: string): boolean {
  return canonicalElement(element) === "physical" || element.trim() === "";
}

/** Palettes for any element name (generated from its hash when unknown). */
export function elementPalettes(element: string): ElementPalette[] {
  const key = canonicalElement(element);
  if (key) return PALETTES[key];
  const h = (hashString(element.toLowerCase()) % 360) / 360;
  const glow = hslHex(h, 0.9, 0.6);
  return [
    P(hslHex(h, 0.45, 0.72), glow, hslHex((h + 0.12) % 1, 0.8, 0.65), hslHex(h, 0.5, 0.12), hslHex(h, 0.35, 0.3)),
    P(mixHex(hslHex(h, 0.3, 0.6), "#ffffff", 0.2), hslHex((h + 0.05) % 1, 1, 0.55), hslHex((h + 0.5) % 1, 0.7, 0.6), hslHex(h, 0.4, 0.1), hslHex(h, 0.3, 0.25)),
  ];
}

const PARTICLES: Record<string, ParticleKind> = {
  fire: "embers", ice: "frost", lightning: "sparks", physical: "motes", poison: "bubbles", holy: "motes", shadow: "smoke",
  water: "bubbles", earth: "smoke", wind: "motes", arcane: "sparks", nature: "motes", blood: "embers", void: "smoke",
};
/** Quick-FX particle kind for an element. */
export const elementParticles = (element: string): ParticleKind => PARTICLES[canonicalElement(element) ?? ""] ?? "motes";

/** Player status a move / item of this element applies (move grammar statuses). */
export function elementStatus(element: string): "none" | "burning" | "chilled" | "charged" | "wet" | "poisoned" | "slowed" {
  switch (canonicalElement(element)) {
    case "fire": return "burning";
    case "ice": return "chilled";
    case "lightning": return "charged";
    case "water": return "wet";
    case "poison": return "poisoned";
    case "earth": return "slowed";
    default: return "none";
  }
}

/** VFX sprite for an element. */
export function elementSprite(element: string): VfxRecipe["emitters"][number]["sprite"] {
  switch (canonicalElement(element)) {
    case "fire": case "blood": return "ember";
    case "ice": return "snow";
    case "lightning": case "arcane": return "spark";
    case "poison": case "water": return "bubble";
    case "shadow": case "void": case "earth": return "smoke";
    case "nature": return "leaf";
    case "holy": return "mote";
    default: return "mote";
  }
}

/** Match a manifest element by name or synonym ("frost" -> the manifest's "ice"). */
export function matchElement(word: string, elements: readonly string[]): string | undefined {
  const w = word.trim().toLowerCase();
  const direct = elements.find((e) => e.toLowerCase() === w);
  if (direct) return direct;
  const canon = canonicalElement(w);
  return canon ? elements.find((e) => canonicalElement(e) === canon) : undefined;
}

/** The manifest's "plain" element (physical / none), else its first element. */
export function plainElement(elements: readonly string[]): string {
  return elements.find((e) => isPhysical(e)) ?? elements[0] ?? "physical";
}

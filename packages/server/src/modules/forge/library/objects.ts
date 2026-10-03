// The object library (ported from Counterforge improvised.ts, MIT): ~40 everyday things (train, car, chair, toaster,
// tree, boat, bell, ...) as chunky low-poly part models, plus summon / creature behaviour models and a generic
// seeded fallback for any other noun. Used by forge.item (improvised weapons: a thing mounted on a handle),
// forge.creature (summons / allies) and forge.prop.
//
// Object frame (library designs, creature / prop models): metres, base on y = 0, +Y up, +Z forward.
// Held frame (improvised items): Blueprint conventions, the grip at the origin and +Y = grip -> tip.
import { ANIM_KINDS, BLUEPRINT_ROLES, BLUEPRINT_SHAPES, type AnimKind, type BlueprintRole, type BlueprintShape, type ParticleKind } from "@liveforge/protocol";
import { HEAD_END, keywordRe } from "../keywords.js";
import { elementPalettes, elementParticles, isPhysical } from "../elements.js";
import { hashString, hslHex, mixHex, mulberry32, partsBounds, type RawModel as ItemBlueprint, type RawPart as BlueprintPart, type Vec3 } from "../model.js";

/** What a creature / summon does on the field (the game implements each behaviour id). */
export const SUMMON_BEHAVIOURS = [
  "charge", "orbit", "turret", "wall", "trap", "bomb", "heal_zone", "rain", "ride", "platform", "decoy",
] as const;
export type SummonBehaviour = (typeof SUMMON_BEHAVIOURS)[number];
type Element = string;
type WeaponFamily = string;

const H = Math.PI / 2;
const PI = Math.PI;
const MAX_PARTS = 24;

// ------------------------------------------------------------------------------------------------ authoring DSL

type Anim = [AnimKind, number, number];
interface O { rot?: Vec3; e?: string; ei?: number; a?: Anim; mx?: "x" | "z"; m?: number }

function P(role: BlueprintRole, shape: BlueprintShape, size: Vec3, offset: Vec3, color: string, o: O = {}): BlueprintPart {
  const p: BlueprintPart = {
    role, shape, size: size.map((v) => Math.max(0.01, v)) as Vec3, offset, rotation: o.rot ?? [0, 0, 0], color,
  };
  if (o.e) { p.emissive = o.e; p.emissiveIntensity = o.ei ?? 1.6; }
  if (o.a) p.anim = { kind: o.a[0], speed: o.a[1], amount: o.a[2] };
  if (o.mx) p.mirror = o.mx;
  if (o.m !== undefined) p.metalness = o.m;
  return p;
}

/** A wheel on the X axle at (x, y, z), mirrored to -x unless x = 0; spins about the axle. */
const wheel = (x: number, y: number, z: number, r: number, w: number, c: string): BlueprintPart =>
  P("rim", "cylinder", [2 * r, w, 2 * r], [x, y, z], c, { rot: [0, 0, H], a: ["spin", 7, 0], ...(x !== 0 ? { mx: "x" as const } : {}) });

/** Colours a design paints with: `t` tints an authored colour toward the element; glow / accent / dark from the palette. */
interface Cols { t: (hex: string) => string; glow: string; accent: string; dark: string }

/** How an object sits on its handle (improvised weapons). */
export type Mount = "tip" | "head" | "shield" | "center";

export interface ObjectDesign {
  id: string;
  name: string;
  /** Whole-word keywords (lowercase, "|"-separated; multi-word allowed). */
  keywords: string;
  /** How you would swing it (moveset family of the improvised weapon). */
  family: WeaponFamily;
  /** What it does as a summon (keyless default). */
  behaviour: SummonBehaviour;
  /** Mount override (default by family). */
  mount?: Mount;
  /** Physical look gets smoke (engines, steam). */
  smoke?: boolean;
  parts: (c: Cols) => BlueprintPart[];
}

const K = {
  red: "#d62839", dark: "#2c3039", black: "#18191e", white: "#f5f5f5", steel: "#c9d2dc", iron: "#6f7883",
  gold: "#f5c542", brass: "#c99a3d", wood: "#8b5a2b", wood2: "#5e3b1d", green: "#3daa4f", leaf: "#4caf3a",
  blue: "#2f6fde", sky: "#9fd8ff", yellow: "#ffd23f", orange: "#ff8a2a", pink: "#ff70b8", purple: "#7a46d0",
  brown: "#7b4526", cream: "#f3e2b8", grey: "#8c8780", teal: "#19b3a3", mint: "#7fe0b0",
} as const;

// ------------------------------------------------------------------------------------------------ the library

export const OBJECT_DESIGNS: readonly ObjectDesign[] = [
  {
    id: "train", name: "Train", keywords: "train|trains|locomotive|steam engine|tram|railway engine|choo choo",
    family: "hammer", behaviour: "charge", smoke: true,
    parts: ({ t, glow, dark }) => [
      P("body", "cylinder", [0.34, 0.62, 0.34], [0, 0.33, 0.12], t(K.red), { rot: [H, 0, 0] }),
      P("body", "box", [0.42, 0.42, 0.34], [0, 0.4, -0.34], t("#a01c2a")),
      P("rim", "box", [0.48, 0.05, 0.4], [0, 0.63, -0.34], dark),
      P("barrel", "cylinder", [0.1, 0.22, 0.1], [0, 0.58, 0.3], dark),
      P("guard", "wedge", [0.38, 0.16, 0.12], [0, 0.1, 0.5], t(K.gold), { rot: [-H, 0, 0] }),
      wheel(0.19, 0.12, 0.28, 0.12, 0.05, dark),
      wheel(0.19, 0.12, -0.02, 0.12, 0.05, dark),
      wheel(0.19, 0.12, -0.34, 0.12, 0.05, dark),
      P("gem", "sphere", [0.1, 0.1, 0.05], [0, 0.4, 0.45], K.yellow, { e: glow, a: ["pulse", 3, 0.25] }),
    ],
  },
  {
    id: "car", name: "Car", keywords: "car|cars|truck|van|taxi|jeep|tractor|bus|lorry|race car|sports car|limo|limousine",
    family: "hammer", behaviour: "charge", smoke: true,
    parts: ({ t, glow, dark }) => [
      P("body", "box", [0.5, 0.2, 0.95], [0, 0.22, 0], t(K.blue)),
      P("body", "box", [0.44, 0.18, 0.5], [0, 0.41, -0.06], t(K.blue)),
      P("decor", "box", [0.46, 0.12, 0.44], [0, 0.42, -0.06], K.sky),
      P("rim", "box", [0.06, 0.205, 0.96], [0, 0.22, 0], t(K.white)),
      wheel(0.25, 0.12, 0.3, 0.12, 0.08, dark),
      wheel(0.25, 0.12, -0.3, 0.12, 0.08, dark),
      P("gem", "sphere", [0.08, 0.06, 0.04], [0.17, 0.25, 0.48], K.yellow, { e: glow, mx: "x" }),
    ],
  },
  {
    id: "tank", name: "Tank", keywords: "tank|tanks|panzer|armored car|armoured car",
    family: "cannon", behaviour: "turret", mount: "tip", smoke: true,
    parts: ({ t, glow, dark }) => [
      P("body", "box", [0.56, 0.2, 0.86], [0, 0.22, 0], t("#5d7a3a")),
      P("rim", "box", [0.14, 0.2, 0.94], [0.32, 0.12, 0], dark, { mx: "x" }),
      P("head", "box", [0.36, 0.18, 0.4], [0, 0.41, -0.06], t("#4c6630")),
      P("barrel", "cylinder", [0.07, 0.6, 0.07], [0, 0.42, 0.38], t(K.iron), { rot: [H, 0, 0] }),
      P("gem", "sphere", [0.06, 0.06, 0.06], [0, 0.42, 0.69], glow, { e: glow, a: ["flicker", 6, 0.4] }),
    ],
  },
  {
    id: "bicycle", name: "Bicycle", keywords: "bicycle|bike|bikes|motorbike|motorcycle|scooter|unicycle",
    family: "hammer", behaviour: "ride",
    parts: ({ t, dark }) => [
      P("rim", "torus", [0.44, 0.44, 0.04], [0, 0.22, 0.32], dark, { rot: [0, H, 0], a: ["spin", 6, 0] }),
      P("rim", "torus", [0.44, 0.44, 0.04], [0, 0.22, -0.32], dark, { rot: [0, H, 0], a: ["spin", 6, 0] }),
      P("body", "box", [0.04, 0.04, 0.62], [0, 0.36, 0], t(K.red), { rot: [0.25, 0, 0] }),
      P("body", "cylinder", [0.035, 0.32, 0.035], [0, 0.36, 0.3], t(K.red)),
      P("cloth", "box", [0.12, 0.04, 0.2], [0, 0.5, -0.16], K.black),
      P("decor", "box", [0.4, 0.03, 0.03], [0, 0.53, 0.3], t(K.steel)),
    ],
  },
  {
    id: "boat", name: "Boat", keywords: "boat|boats|ship|ships|canoe|kayak|yacht|sailboat|pirate ship|submarine|raft",
    family: "greatsword", behaviour: "ride",
    parts: ({ t, accent }) => [
      P("body", "box", [0.42, 0.18, 0.72], [0, 0.12, -0.08], t(K.wood)),
      P("body", "cone", [0.42, 0.3, 0.18], [0, 0.12, 0.43], t(K.wood), { rot: [H, 0, 0] }),
      P("rim", "box", [0.44, 0.04, 0.74], [0, 0.22, -0.08], t(K.wood2)),
      P("decor", "cylinder", [0.04, 0.72, 0.04], [0, 0.56, 0], t(K.wood2)),
      P("cloth", "box", [0.02, 0.44, 0.38], [0, 0.6, -0.02], t(K.white), { a: ["wobble", 2, 0.12] }),
      P("decor", "box", [0.02, 0.1, 0.16], [0, 0.88, 0.06], accent, { a: ["wobble", 5, 0.4] }),
    ],
  },
  {
    id: "spaceship", name: "Flying Saucer", keywords: "ufo|ufos|flying saucer|spaceship|space ship|spacecraft|rocket ship|starship",
    family: "shield_small", behaviour: "platform", mount: "shield",
    parts: ({ t, glow, accent }) => [
      P("body", "sphere", [0.9, 0.18, 0.9], [0, 0.3, 0], t(K.steel), { m: 0.8 }),
      P("orb", "sphere", [0.4, 0.3, 0.4], [0, 0.42, 0], K.sky, { e: glow, ei: 0.8 }),
      P("ring", "torus", [0.94, 0.94, 0.05], [0, 0.3, 0], accent, { rot: [H, 0, 0], e: glow, a: ["spin", 2, 0] }),
      P("limb", "cone", [0.06, 0.24, 0.06], [0.26, 0.12, 0], t(K.iron), { mx: "x" }),
      P("limb", "cone", [0.06, 0.24, 0.06], [0, 0.12, 0.26], t(K.iron), { mx: "z" }),
    ],
  },
  {
    id: "chair", name: "Chair", keywords: "chair|chairs|stool|stools|throne|thrones|bench|armchair",
    family: "hammer", behaviour: "decoy",
    parts: ({ t }) => [
      P("body", "box", [0.5, 0.06, 0.5], [0, 0.45, 0], t(K.wood)),
      P("body", "box", [0.5, 0.5, 0.06], [0, 0.73, -0.22], t(K.wood)),
      P("limb", "cylinder", [0.05, 0.45, 0.05], [0.21, 0.22, 0.21], t(K.wood2), { mx: "x" }),
      P("limb", "cylinder", [0.05, 0.45, 0.05], [0.21, 0.22, -0.21], t(K.wood2), { mx: "x" }),
      P("cloth", "box", [0.44, 0.05, 0.44], [0, 0.5, 0.01], t(K.red)),
      P("decor", "box", [0.36, 0.08, 0.02], [0, 0.88, -0.19], t(K.gold)),
    ],
  },
  {
    id: "couch", name: "Couch", keywords: "couch|couches|sofa|sofas|settee",
    family: "greatsword", behaviour: "wall",
    parts: ({ t }) => [
      P("body", "box", [1.1, 0.25, 0.45], [0, 0.2, 0], t(K.purple)),
      P("body", "box", [1.1, 0.36, 0.12], [0, 0.46, -0.2], t(K.purple)),
      P("cloth", "box", [0.12, 0.3, 0.46], [0.5, 0.36, 0], t("#5a2f9c"), { mx: "x" }),
      P("cloth", "box", [0.42, 0.08, 0.36], [0.22, 0.36, 0.03], t("#9a6ae0"), { mx: "x" }),
      P("limb", "cylinder", [0.05, 0.08, 0.05], [0.48, 0.04, 0.16], K.wood2, { mx: "x" }),
    ],
  },
  {
    id: "fridge", name: "Fridge", keywords: "fridge|fridges|refrigerator|freezer|vending machine",
    family: "hammer", behaviour: "wall",
    parts: ({ t, glow }) => [
      P("body", "box", [0.5, 1.0, 0.45], [0, 0.5, 0], t(K.white)),
      P("rim", "box", [0.52, 0.025, 0.47], [0, 0.68, 0], t(K.iron)),
      P("decor", "box", [0.03, 0.2, 0.04], [0.18, 0.86, 0.24], t(K.steel), { m: 0.8 }),
      P("decor", "box", [0.03, 0.3, 0.04], [0.18, 0.4, 0.24], t(K.steel), { m: 0.8 }),
      P("gem", "box", [0.08, 0.08, 0.02], [-0.1, 0.84, 0.23], K.red, { e: glow, ei: 0.8 }),
      P("decor", "box", [0.07, 0.07, 0.02], [0.02, 0.5, 0.23], K.yellow),
    ],
  },
  {
    id: "toaster", name: "Toaster", keywords: "toaster|toasters|microwave|blender|waffle iron",
    family: "gun", behaviour: "turret", mount: "tip",
    parts: ({ t, glow }) => [
      P("body", "box", [0.5, 0.32, 0.3], [0, 0.16, 0], t(K.steel), { m: 0.85 }),
      P("rim", "box", [0.52, 0.04, 0.32], [0, 0.02, 0], K.black),
      P("decor", "box", [0.32, 0.02, 0.07], [0, 0.325, 0.065], K.black, { mx: "z" }),
      P("blade", "box", [0.26, 0.18, 0.04], [0, 0.4, 0.065], t(K.cream), { a: ["float", 3, 0.02], mx: "z" }),
      P("guard", "box", [0.04, 0.1, 0.06], [0.27, 0.22, 0], K.black),
      P("gem", "sphere", [0.06, 0.06, 0.03], [0.12, 0.16, 0.16], glow, { e: glow, a: ["pulse", 4, 0.3] }),
    ],
  },
  {
    id: "tree", name: "Tree", keywords: "tree|trees|oak|pine|palm tree|sapling|bonsai|christmas tree",
    family: "greatsword", behaviour: "wall",
    parts: ({ t, glow }) => [
      P("handle", "cylinder", [0.14, 0.62, 0.14], [0, 0.31, 0], t(K.wood)),
      P("body", "icosahedron", [0.64, 0.52, 0.64], [0, 0.78, 0], t(K.leaf)),
      P("body", "icosahedron", [0.46, 0.42, 0.46], [0.1, 1.05, 0.04], t(K.green)),
      P("limb", "cone", [0.24, 0.12, 0.24], [0, 0.04, 0], t(K.wood2)),
      P("gem", "sphere", [0.08, 0.08, 0.08], [0.22, 0.72, 0.2], K.red, { e: glow, ei: 0.6, mx: "x" }),
      P("gem", "sphere", [0.07, 0.07, 0.07], [0, 0.95, -0.24], K.red, { e: glow, ei: 0.6 }),
    ],
  },
  {
    id: "cactus", name: "Cactus", keywords: "cactus|cacti|cactuses|saguaro",
    family: "sword", behaviour: "trap",
    parts: ({ t, glow }) => [
      P("body", "capsule", [0.22, 0.9, 0.22], [0, 0.45, 0], t(K.green)),
      P("limb", "capsule", [0.12, 0.34, 0.12], [0.22, 0.58, 0], t(K.green), { mx: "x" }),
      P("limb", "capsule", [0.12, 0.2, 0.12], [0.15, 0.42, 0], t(K.green), { rot: [0, 0, H], mx: "x" }),
      P("spike", "cone", [0.03, 0.08, 0.03], [0.12, 0.3, 0], K.cream, { rot: [0, 0, -H], mx: "x" }),
      P("spike", "cone", [0.03, 0.08, 0.03], [0, 0.66, 0.12], K.cream, { rot: [H, 0, 0], mx: "z" }),
      P("gem", "sphere", [0.12, 0.08, 0.12], [0, 0.92, 0], K.pink, { e: glow, ei: 0.5 }),
    ],
  },
  {
    id: "mushroom", name: "Mushroom", keywords: "mushroom|mushrooms|toadstool|toadstools|fungus|fungi",
    family: "hammer", behaviour: "heal_zone", mount: "tip",
    parts: ({ t, glow }) => [
      P("handle", "cylinder", [0.16, 0.42, 0.16], [0, 0.21, 0], t(K.cream)),
      P("head", "sphere", [0.62, 0.32, 0.62], [0, 0.46, 0], t(K.red)),
      P("decor", "sphere", [0.1, 0.05, 0.1], [0.16, 0.59, 0.1], K.white, { mx: "x" }),
      P("decor", "sphere", [0.09, 0.05, 0.09], [0, 0.6, -0.17], K.white),
      P("decor", "sphere", [0.08, 0.05, 0.08], [0, 0.62, 0.05], K.white),
      P("gem", "sphere", [0.05, 0.05, 0.05], [0.04, 0.34, 0.08], glow, { e: glow, a: ["pulse", 2, 0.3], mx: "x" }),
    ],
  },
  {
    id: "teapot", name: "Teapot", keywords: "teapot|teapots|kettle|kettles|coffee pot|coffee mug|mug",
    family: "focus", behaviour: "heal_zone", smoke: true,
    parts: ({ t, glow }) => [
      P("body", "sphere", [0.45, 0.36, 0.45], [0, 0.2, 0], t(K.teal)),
      P("rim", "sphere", [0.22, 0.08, 0.22], [0, 0.39, 0], t(K.white)),
      P("decor", "sphere", [0.07, 0.07, 0.07], [0, 0.45, 0], t(K.gold)),
      P("barrel", "cone", [0.08, 0.28, 0.08], [0, 0.27, 0.28], t(K.teal), { rot: [0.9, 0, 0] }),
      P("handle", "torus", [0.24, 0.24, 0.04], [0, 0.22, -0.24], t(K.teal), { rot: [0, H, 0] }),
      P("gem", "box", [0.36, 0.04, 0.36], [0, 0.18, 0], glow, { e: glow, ei: 0.7, a: ["pulse", 2, 0.2] }),
    ],
  },
  {
    id: "bell", name: "Bell", keywords: "bell|bells|church bell|cowbell",
    family: "hammer", behaviour: "decoy", mount: "head",
    parts: ({ t, glow }) => [
      P("body", "cone", [0.5, 0.48, 0.5], [0, 0.3, 0], t(K.gold), { m: 0.8, a: ["wobble", 3, 0.15] }),
      P("body", "sphere", [0.3, 0.22, 0.3], [0, 0.54, 0], t(K.gold), { m: 0.8 }),
      P("rim", "torus", [0.52, 0.52, 0.05], [0, 0.07, 0], t(K.brass), { rot: [H, 0, 0] }),
      P("orb", "sphere", [0.1, 0.1, 0.1], [0, 0.04, 0], glow, { e: glow, a: ["pulse", 4, 0.3] }),
      P("ring", "torus", [0.14, 0.14, 0.03], [0, 0.69, 0], t(K.brass)),
    ],
  },
  {
    id: "trophy", name: "Trophy", keywords: "trophy|trophies|chalice|goblet|grail|holy grail",
    family: "hammer", behaviour: "decoy", mount: "tip",
    parts: ({ t, glow }) => [
      P("head", "cone", [0.4, 0.36, 0.4], [0, 0.56, 0], t(K.gold), { rot: [PI, 0, 0], m: 0.9 }),
      P("handle", "cylinder", [0.07, 0.24, 0.07], [0, 0.28, 0], t(K.gold), { m: 0.9 }),
      P("pommel", "box", [0.3, 0.1, 0.3], [0, 0.05, 0], K.black),
      P("ring", "torus", [0.18, 0.18, 0.04], [0.22, 0.62, 0], t(K.gold), { mx: "x" }),
      P("gem", "octahedron", [0.12, 0.14, 0.06], [0, 0.6, 0.17], glow, { e: glow, a: ["pulse", 3, 0.25] }),
    ],
  },
  {
    id: "traffic_cone", name: "Traffic Cone", keywords: "traffic cone|traffic cones|pylon|road cone|witches hat",
    family: "spear", behaviour: "decoy",
    parts: ({ t }) => [
      P("head", "cone", [0.36, 0.8, 0.36], [0, 0.44, 0], t(K.orange)),
      P("decor", "cylinder", [0.26, 0.08, 0.26], [0, 0.42, 0], K.white),
      P("decor", "cylinder", [0.17, 0.07, 0.17], [0, 0.62, 0], K.white),
      P("pommel", "box", [0.5, 0.05, 0.5], [0, 0.025, 0], t(K.orange)),
    ],
  },
  {
    id: "ladder", name: "Ladder", keywords: "ladder|ladders|step ladder",
    family: "spear", behaviour: "platform",
    parts: ({ t }) => [
      P("handle", "box", [0.05, 1.4, 0.05], [0.18, 0.7, 0], t(K.wood), { mx: "x" }),
      P("decor", "box", [0.36, 0.04, 0.04], [0, 0.2, 0], t(K.wood2)),
      P("decor", "box", [0.36, 0.04, 0.04], [0, 0.5, 0], t(K.wood2)),
      P("decor", "box", [0.36, 0.04, 0.04], [0, 0.8, 0], t(K.wood2)),
      P("decor", "box", [0.36, 0.04, 0.04], [0, 1.1, 0], t(K.wood2)),
    ],
  },
  {
    id: "stop_sign", name: "Stop Sign", keywords: "stop sign|road sign|street sign|signpost|sign post|sign",
    family: "axe", behaviour: "wall", mount: "tip",
    parts: ({ t }) => [
      P("handle", "cylinder", [0.05, 0.9, 0.05], [0, 0.45, 0], t(K.steel)),
      P("head", "cylinder", [0.5, 0.04, 0.5], [0, 1.08, 0], t(K.red), { rot: [H, 0, 0] }),
      P("rim", "torus", [0.52, 0.52, 0.03], [0, 1.08, 0], K.white),
      P("decor", "box", [0.3, 0.07, 0.01], [0, 1.08, 0.025], K.white, { mx: "z" }),
    ],
  },
  {
    id: "board", name: "Board", keywords: "surfboard|surfboards|skateboard|skateboards|snowboard|hoverboard|longboard",
    family: "shield_large", behaviour: "ride",
    parts: ({ t, glow }) => [
      P("body", "capsule", [0.36, 0.06, 1.3], [0, 0.12, 0], t(K.teal)),
      P("decor", "box", [0.07, 0.065, 1.16], [0, 0.125, 0], t(K.yellow)),
      P("limb", "wedge", [0.02, 0.14, 0.14], [0, 0.03, -0.5], t(K.dark), { rot: [PI, 0, 0] }),
      P("gem", "box", [0.3, 0.02, 0.9], [0, 0.085, 0], glow, { e: glow, ei: 1.2, a: ["pulse", 2, 0.3] }),
    ],
  },
  {
    id: "microphone", name: "Microphone", keywords: "microphone|microphones|mic|karaoke",
    family: "hammer", behaviour: "decoy", mount: "tip",
    parts: ({ t, glow }) => [
      P("handle", "cylinder", [0.07, 0.42, 0.07], [0, 0.21, 0], t(K.dark)),
      P("head", "sphere", [0.2, 0.22, 0.2], [0, 0.5, 0], t(K.steel), { m: 0.8 }),
      P("ring", "torus", [0.16, 0.16, 0.03], [0, 0.42, 0], t(K.gold), { rot: [H, 0, 0] }),
      P("gem", "box", [0.03, 0.05, 0.02], [0, 0.26, 0.04], glow, { e: glow, a: ["flicker", 5, 0.4] }),
    ],
  },
  {
    id: "wrench", name: "Wrench", keywords: "wrench|wrenches|spanner|spanners|monkey wrench|crowbar",
    family: "hammer", behaviour: "orbit", mount: "tip",
    parts: ({ t }) => [
      P("handle", "box", [0.08, 0.7, 0.04], [0, 0.35, 0], t(K.steel), { m: 0.85 }),
      P("head", "crescent", [0.3, 0.24, 0.05], [0, 0.78, 0], t(K.steel), { m: 0.85 }),
      P("decor", "torus", [0.1, 0.1, 0.03], [0, 0.06, 0], t(K.iron)),
      P("cloth", "box", [0.09, 0.3, 0.045], [0, 0.22, 0], t(K.red)),
    ],
  },
  {
    id: "plunger", name: "Plunger", keywords: "plunger|plungers",
    family: "spear", behaviour: "trap", mount: "tip",
    parts: ({ t }) => [
      P("handle", "cylinder", [0.05, 0.9, 0.05], [0, 0.45, 0], t(K.wood)),
      P("head", "sphere", [0.3, 0.2, 0.3], [0, 0.96, 0], t(K.red)),
      P("rim", "torus", [0.3, 0.3, 0.03], [0, 0.98, 0], t("#a01c2a"), { rot: [H, 0, 0] }),
    ],
  },
  {
    id: "key", name: "Key", keywords: "key|keys|skeleton key|giant key",
    family: "sword", behaviour: "orbit", mount: "tip",
    parts: ({ t, glow }) => [
      P("handle", "torus", [0.28, 0.28, 0.06], [0, 0.14, 0], t(K.gold), { m: 0.9 }),
      P("blade", "cylinder", [0.06, 0.62, 0.06], [0, 0.58, 0], t(K.gold), { m: 0.9 }),
      P("blade", "box", [0.14, 0.06, 0.04], [0.07, 0.82, 0], t(K.gold), { m: 0.9 }),
      P("blade", "box", [0.1, 0.06, 0.04], [0.05, 0.7, 0], t(K.gold), { m: 0.9 }),
      P("gem", "octahedron", [0.08, 0.1, 0.04], [0, 0.14, 0], glow, { e: glow, a: ["pulse", 3, 0.3] }),
    ],
  },
  {
    id: "cake", name: "Cake", keywords: "cake|cakes|cupcake|cupcakes|donut|donuts|doughnut|muffin|birthday cake",
    family: "hammer", behaviour: "heal_zone", mount: "head",
    parts: ({ t, glow }) => [
      P("body", "cylinder", [0.5, 0.26, 0.5], [0, 0.13, 0], t(K.pink)),
      P("rim", "cylinder", [0.53, 0.06, 0.53], [0, 0.28, 0], t(K.white)),
      P("decor", "sphere", [0.09, 0.09, 0.09], [0, 0.35, 0], K.red),
      P("decor", "cylinder", [0.03, 0.12, 0.03], [0.13, 0.37, 0], t(K.sky), { mx: "x" }),
      P("gem", "cone", [0.04, 0.07, 0.04], [0.13, 0.47, 0], K.yellow, { e: glow, a: ["flicker", 9, 0.5], mx: "x" }),
    ],
  },
  {
    id: "pizza", name: "Pizza", keywords: "pizza|pizzas|pie|pies|pancake|pancakes|frisbee",
    family: "thrown", behaviour: "orbit",
    parts: ({ t }) => [
      P("body", "cylinder", [0.7, 0.04, 0.7], [0, 0.02, 0], t(K.yellow)),
      P("rim", "torus", [0.72, 0.72, 0.07], [0, 0.03, 0], t("#d9963e"), { rot: [H, 0, 0] }),
      P("decor", "cylinder", [0.6, 0.045, 0.6], [0, 0.025, 0], t(K.red)),
      P("decor", "cylinder", [0.11, 0.05, 0.11], [0.15, 0.035, 0.1], "#9c2a1c", { mx: "x" }),
      P("decor", "cylinder", [0.11, 0.05, 0.11], [0, 0.035, -0.18], "#9c2a1c"),
      P("decor", "cylinder", [0.1, 0.05, 0.1], [0.08, 0.035, -0.02], "#9c2a1c", { mx: "x" }),
    ],
  },
  {
    id: "carrot", name: "Carrot", keywords: "carrot|carrots|parsnip|cucumber|corn|cob|eggplant|aubergine",
    family: "dagger", behaviour: "orbit",
    parts: ({ t }) => [
      P("cloth", "cone", [0.14, 0.18, 0.06], [0.04, 0.09, 0], t(K.leaf), { rot: [0, 0, 0.4], mx: "x" }),
      P("handle", "cone", [0.06, 0.2, 0.06], [0, 0.1, 0], t(K.green)),
      P("blade", "cone", [0.17, 0.66, 0.17], [0, 0.53, 0], t(K.orange)),
      P("decor", "torus", [0.15, 0.15, 0.015], [0, 0.4, 0], "#c96a1d", { rot: [H, 0, 0] }),
      P("decor", "torus", [0.1, 0.1, 0.015], [0, 0.6, 0], "#c96a1d", { rot: [H, 0, 0] }),
    ],
  },
  {
    id: "ice_cream", name: "Ice Cream", keywords: "ice cream|ice creams|ice-cream|sundae|popsicle|gelato",
    family: "sword", behaviour: "heal_zone",
    parts: ({ t, glow }) => [
      P("handle", "cone", [0.22, 0.5, 0.22], [0, 0.25, 0], t("#d9963e"), { rot: [PI, 0, 0] }),
      P("head", "sphere", [0.28, 0.26, 0.28], [0, 0.56, 0], t(K.pink)),
      P("head", "sphere", [0.25, 0.24, 0.25], [0, 0.76, 0], t(K.mint)),
      P("decor", "sphere", [0.08, 0.08, 0.08], [0, 0.92, 0], K.red, { e: glow, ei: 0.4 }),
    ],
  },
  {
    id: "television", name: "Television", keywords: "television|televisions|tv|tvs|monitor|computer|laptop|arcade machine",
    family: "hammer", behaviour: "decoy", mount: "head",
    parts: ({ t, glow }) => [
      P("body", "box", [0.8, 0.55, 0.3], [0, 0.42, 0], t(K.dark)),
      P("rune", "box", [0.68, 0.44, 0.02], [0, 0.43, 0.155], K.sky, { e: glow, ei: 1.4, a: ["flicker", 6, 0.4] }),
      P("decor", "cylinder", [0.02, 0.4, 0.02], [0.12, 0.86, 0], t(K.steel), { rot: [0, 0, 0.5], mx: "x" }),
      P("limb", "box", [0.06, 0.15, 0.06], [0.28, 0.07, 0], K.black, { mx: "x" }),
    ],
  },
  {
    id: "lighthouse", name: "Lighthouse", keywords: "lighthouse|lighthouses|beacon tower",
    family: "staff", behaviour: "turret",
    parts: ({ t, glow }) => [
      P("handle", "cylinder", [0.26, 1.0, 0.26], [0, 0.5, 0], t(K.white)),
      P("decor", "cylinder", [0.27, 0.12, 0.27], [0, 0.32, 0], t(K.red)),
      P("decor", "cylinder", [0.27, 0.12, 0.27], [0, 0.68, 0], t(K.red)),
      P("orb", "cylinder", [0.22, 0.18, 0.22], [0, 1.1, 0], K.yellow, { e: glow, a: ["pulse", 3, 0.3] }),
      P("rune", "box", [0.04, 0.04, 0.9], [0, 1.1, 0], glow, { e: glow, ei: 2, a: ["spin", 2.5, 0] }),
      P("head", "cone", [0.3, 0.2, 0.3], [0, 1.29, 0], t(K.red)),
    ],
  },
  {
    id: "castle", name: "Castle", keywords: "castle|castles|fortress|fort|palace|sandcastle",
    family: "hammer", behaviour: "wall", mount: "head",
    parts: ({ t, glow }) => [
      P("body", "box", [0.8, 0.4, 0.6], [0, 0.2, 0], t(K.grey)),
      P("body", "cylinder", [0.22, 0.62, 0.22], [0.4, 0.31, 0.3], t(K.grey), { mx: "x" }),
      P("body", "cylinder", [0.22, 0.62, 0.22], [0.4, 0.31, -0.3], t(K.grey), { mx: "x" }),
      P("spike", "cone", [0.26, 0.26, 0.26], [0.4, 0.75, 0.3], t(K.red), { mx: "x" }),
      P("spike", "cone", [0.26, 0.26, 0.26], [0.4, 0.75, -0.3], t(K.red), { mx: "x" }),
      P("decor", "box", [0.2, 0.26, 0.02], [0, 0.13, 0.305], K.black),
      P("gem", "box", [0.1, 0.06, 0.02], [0.2, 0.3, 0.305], K.yellow, { e: glow, mx: "x" }),
    ],
  },
  {
    id: "clock", name: "Clock", keywords: "clock|clocks|alarm clock|grandfather clock|pocket watch|stopwatch",
    family: "shield_small", behaviour: "trap",
    parts: ({ t, glow }) => [
      P("body", "cylinder", [0.6, 0.12, 0.6], [0, 0.34, 0], t(K.red), { rot: [H, 0, 0] }),
      P("rim", "torus", [0.62, 0.62, 0.06], [0, 0.34, 0.02], t(K.gold)),
      P("decor", "cylinder", [0.52, 0.02, 0.52], [0, 0.34, 0.065], K.cream, { rot: [H, 0, 0] }),
      P("rune", "box", [0.025, 0.22, 0.01], [0, 0.34, 0.08], K.black, { a: ["spin", 3, 0] }),
      P("decor", "sphere", [0.14, 0.1, 0.1], [0.18, 0.66, 0], t(K.gold), { mx: "x" }),
      P("gem", "sphere", [0.05, 0.05, 0.03], [0, 0.34, 0.09], glow, { e: glow }),
    ],
  },
  {
    id: "phone", name: "Phone", keywords: "phone|phones|smartphone|telephone|cellphone|iphone",
    family: "gun", behaviour: "decoy", mount: "tip",
    parts: ({ t, glow }) => [
      P("body", "box", [0.32, 0.6, 0.05], [0, 0.3, 0], t(K.dark)),
      P("rune", "box", [0.28, 0.5, 0.01], [0, 0.31, 0.03], K.sky, { e: glow, ei: 1.2, a: ["flicker", 4, 0.3] }),
      P("gem", "sphere", [0.04, 0.04, 0.01], [0, 0.04, 0.03], glow, { e: glow }),
    ],
  },
  {
    id: "piano", name: "Piano", keywords: "piano|pianos|grand piano|organ|harpsichord",
    family: "hammer", behaviour: "bomb", mount: "head",
    parts: ({ t }) => [
      P("body", "box", [1.0, 0.5, 0.45], [0, 0.5, 0], t(K.black)),
      P("decor", "box", [0.9, 0.04, 0.14], [0, 0.64, 0.24], K.white),
      P("decor", "box", [0.86, 0.045, 0.06], [0, 0.66, 0.2], K.black),
      P("limb", "cylinder", [0.06, 0.25, 0.06], [0.42, 0.125, 0.15], t(K.black), { mx: "x" }),
      P("rim", "box", [1.02, 0.03, 0.47], [0, 0.76, 0], t(K.gold)),
    ],
  },
  {
    id: "shark", name: "Shark", keywords: "shark|sharks|whale|whales|dolphin|dolphins|orca|swordfish shark",
    family: "sword", behaviour: "charge",
    parts: ({ t, glow }) => [
      P("body", "sphere", [0.3, 0.32, 1.0], [0, 0.25, 0], t("#5f7d95")),
      P("decor", "sphere", [0.24, 0.2, 0.8], [0, 0.17, 0.04], t(K.white)),
      P("spike", "wedge", [0.04, 0.26, 0.2], [0, 0.46, -0.02], t("#5f7d95"), { rot: [-0.3, 0, 0] }),
      P("limb", "wedge", [0.04, 0.32, 0.2], [0, 0.32, -0.56], t("#5f7d95"), { rot: [-0.5, 0, 0], a: ["wobble", 5, 0.35] }),
      P("limb", "wedge", [0.2, 0.04, 0.16], [0.17, 0.16, 0.1], t("#5f7d95"), { rot: [0, 0, -0.4], mx: "x" }),
      P("gem", "sphere", [0.04, 0.04, 0.03], [0.1, 0.3, 0.36], K.black, { e: glow, ei: 0.5, mx: "x" }),
    ],
  },
  {
    id: "snowman", name: "Snowman", keywords: "snowman|snowmen|snow man",
    family: "staff", behaviour: "decoy",
    parts: ({ t }) => [
      P("body", "sphere", [0.5, 0.48, 0.5], [0, 0.24, 0], t(K.white)),
      P("body", "sphere", [0.38, 0.36, 0.38], [0, 0.64, 0], t(K.white)),
      P("head", "sphere", [0.28, 0.27, 0.28], [0, 0.94, 0], t(K.white)),
      P("spike", "cone", [0.05, 0.16, 0.05], [0, 0.94, 0.18], K.orange, { rot: [H, 0, 0] }),
      P("decor", "sphere", [0.035, 0.035, 0.02], [0.06, 0.99, 0.13], K.black, { mx: "x" }),
      P("cloth", "cylinder", [0.2, 0.2, 0.2], [0, 1.16, 0], K.black),
      P("cloth", "cylinder", [0.32, 0.03, 0.32], [0, 1.07, 0], K.black),
    ],
  },
  {
    id: "anvil", name: "Anvil", keywords: "anvil|anvils",
    family: "hammer", behaviour: "bomb", mount: "head",
    parts: ({ t, glow }) => [
      P("pommel", "box", [0.3, 0.18, 0.3], [0, 0.09, 0], t(K.iron)),
      P("body", "box", [0.18, 0.16, 0.2], [0, 0.26, 0], t(K.iron)),
      P("head", "box", [0.56, 0.15, 0.28], [0.06, 0.41, 0], t(K.dark), { m: 0.7 }),
      P("spike", "cone", [0.16, 0.3, 0.14], [-0.36, 0.42, 0], t(K.dark), { rot: [0, 0, H], m: 0.7 }),
      P("rune", "box", [0.4, 0.02, 0.2], [0.08, 0.49, 0], glow, { e: glow, ei: 1.2, a: ["pulse", 2, 0.3] }),
    ],
  },
  {
    id: "watermelon", name: "Watermelon", keywords: "watermelon|watermelons|melon|melons|pumpkin|pumpkins|coconut|coconuts",
    family: "thrown", behaviour: "bomb",
    parts: ({ t }) => [
      P("body", "sphere", [0.7, 0.46, 0.46], [0, 0.23, 0], t(K.green)),
      P("decor", "sphere", [0.71, 0.47, 0.1], [0, 0.23, 0], t("#1f6b2a")),
      P("decor", "sphere", [0.1, 0.47, 0.47], [0.16, 0.23, 0], t("#1f6b2a"), { mx: "x" }),
      P("handle", "cylinder", [0.03, 0.08, 0.03], [0.36, 0.26, 0], K.wood2, { rot: [0, 0, H] }),
    ],
  },
  {
    id: "cloud", name: "Cloud", keywords: "cloud|clouds|raincloud|rain cloud|thundercloud|storm cloud",
    family: "staff", behaviour: "rain",
    parts: ({ t, glow }) => [
      P("body", "sphere", [0.5, 0.36, 0.44], [0, 0.4, 0], t(K.white), { a: ["float", 1.5, 0.03] }),
      P("body", "sphere", [0.38, 0.3, 0.36], [0.28, 0.36, 0.02], t("#e8eef5"), { mx: "x", a: ["float", 1.8, 0.03] }),
      P("body", "sphere", [0.3, 0.28, 0.3], [0.1, 0.56, -0.04], t("#dfe7f0")),
      P("shard", "prism", [0.05, 0.22, 0.05], [0.12, 0.14, 0.04], K.yellow, { e: glow, a: ["flicker", 10, 0.6], mx: "x" }),
    ],
  },
  {
    id: "dinosaur", name: "Dinosaur", keywords: "dinosaur|dinosaurs|dino|dinos|t-rex|trex|raptor|raptors|godzilla",
    family: "greatsword", behaviour: "charge",
    parts: ({ t, glow }) => [
      P("body", "sphere", [0.4, 0.46, 0.8], [0, 0.52, -0.04], t(K.green)),
      P("head", "box", [0.28, 0.26, 0.42], [0, 0.86, 0.42], t(K.green)),
      P("decor", "box", [0.26, 0.04, 0.2], [0, 0.74, 0.55], K.white),
      P("limb", "cone", [0.2, 0.6, 0.2], [0, 0.48, -0.62], t(K.green), { rot: [-H, 0, 0], a: ["wobble", 3, 0.25] }),
      P("limb", "cylinder", [0.14, 0.4, 0.14], [0.14, 0.2, -0.04], t("#2f8a3e"), { mx: "x" }),
      P("spike", "cone", [0.1, 0.16, 0.1], [0, 0.8, -0.1], t(K.orange)),
      P("spike", "cone", [0.08, 0.13, 0.08], [0, 0.74, -0.3], t(K.orange)),
      P("gem", "sphere", [0.04, 0.04, 0.03], [0.1, 0.92, 0.55], K.yellow, { e: glow, mx: "x" }),
    ],
  },
  {
    id: "horse", name: "Horse", keywords: "horse|horses|pony|ponies|unicorn|unicorns|steed|camel|donkey|stallion",
    family: "greatsword", behaviour: "ride",
    parts: ({ t, glow }) => [
      P("body", "capsule", [0.34, 0.86, 0.34], [0, 0.76, 0], t(K.brown), { rot: [H, 0, 0] }),
      P("body", "box", [0.18, 0.46, 0.2], [0, 1.06, 0.4], t(K.brown), { rot: [0.5, 0, 0] }),
      P("head", "box", [0.18, 0.18, 0.38], [0, 1.28, 0.58], t(K.brown)),
      P("limb", "cylinder", [0.09, 0.6, 0.09], [0.11, 0.3, 0.3], t("#5a3a22"), { mx: "x" }),
      P("limb", "cylinder", [0.09, 0.6, 0.09], [0.11, 0.3, -0.3], t("#5a3a22"), { mx: "x" }),
      P("cloth", "box", [0.06, 0.36, 0.12], [0, 1.18, 0.34], K.black, { rot: [0.5, 0, 0] }),
      P("cloth", "box", [0.36, 0.06, 0.3], [0, 0.95, -0.02], t(K.red)),
      P("limb", "cone", [0.08, 0.36, 0.08], [0, 0.66, -0.5], K.black, { rot: [-2.4, 0, 0], a: ["wobble", 4, 0.3] }),
      P("gem", "sphere", [0.03, 0.03, 0.03], [0.08, 1.32, 0.66], K.black, { e: glow, ei: 0.4, mx: "x" }),
    ],
  },
];

/** Behaviour models for summons that name no known thing ("summon something that heals me"). */
const BEHAVIOUR_DESIGNS: Record<SummonBehaviour, ObjectDesign> = {
  charge: {
    id: "_beast", name: "Forge Boar", keywords: "", family: "hammer", behaviour: "charge",
    parts: ({ t, glow, dark }) => [
      P("body", "sphere", [0.5, 0.46, 0.84], [0, 0.44, 0], t(K.grey)),
      P("head", "box", [0.32, 0.3, 0.32], [0, 0.46, 0.5], t(K.grey)),
      P("spike", "cone", [0.06, 0.24, 0.06], [0.12, 0.38, 0.68], K.cream, { rot: [1.2, 0, 0], mx: "x" }),
      P("spike", "cone", [0.08, 0.22, 0.08], [0.12, 0.66, 0.42], dark, { rot: [-0.4, 0, 0.4], mx: "x" }),
      P("limb", "cylinder", [0.12, 0.26, 0.12], [0.16, 0.13, 0.22], dark, { mx: "x" }),
      P("limb", "cylinder", [0.12, 0.26, 0.12], [0.16, 0.13, -0.22], dark, { mx: "x" }),
      P("gem", "sphere", [0.05, 0.05, 0.03], [0.09, 0.52, 0.66], glow, { e: glow, mx: "x", a: ["flicker", 6, 0.4] }),
      P("rune", "box", [0.4, 0.06, 0.02], [0, 0.5, 0.42], glow, { e: glow, a: ["pulse", 3, 0.3] }),
    ],
  },
  orbit: {
    id: "_wisp", name: "Wisp", keywords: "", family: "focus", behaviour: "orbit",
    parts: ({ glow, accent }) => [
      P("orb", "icosahedron", [0.36, 0.36, 0.36], [0, 0.5, 0], glow, { e: glow, ei: 2, a: ["pulse", 3, 0.3] }),
      P("ring", "torus", [0.6, 0.6, 0.04], [0, 0.5, 0], accent, { rot: [1.1, 0, 0.3], e: glow, a: ["spin", 2, 0] }),
      P("ring", "torus", [0.5, 0.5, 0.04], [0, 0.5, 0], accent, { rot: [0.2, 0, 1.2], e: glow, a: ["spin", 3, 0] }),
      P("shard", "octahedron", [0.08, 0.14, 0.08], [0.4, 0.5, 0], glow, { e: glow, a: ["orbit", 3, 0.4] }),
    ],
  },
  turret: {
    id: "_turret", name: "Forge Turret", keywords: "", family: "cannon", behaviour: "turret",
    parts: ({ t, glow, dark }) => [
      P("limb", "cylinder", [0.06, 0.5, 0.06], [0.2, 0.22, 0], dark, { rot: [0, 0, 0.4], mx: "x" }),
      P("limb", "cylinder", [0.06, 0.5, 0.06], [0, 0.22, -0.2], dark, { rot: [-0.4, 0, 0] }),
      P("body", "box", [0.42, 0.34, 0.5], [0, 0.6, 0], t(K.iron)),
      P("barrel", "cylinder", [0.1, 0.56, 0.1], [0, 0.62, 0.44], dark, { rot: [H, 0, 0] }),
      P("orb", "sphere", [0.16, 0.16, 0.08], [0, 0.66, -0.25], glow, { e: glow, a: ["pulse", 3, 0.3] }),
    ],
  },
  wall: {
    id: "_crystal_wall", name: "Crystal Wall", keywords: "", family: "shield_large", behaviour: "wall",
    parts: ({ t, glow }) => [
      P("body", "box", [0.9, 0.9, 0.3], [-0.5, 0.45, 0], t(K.sky), { rot: [0, 0.1, 0] }),
      P("body", "box", [0.9, 1.1, 0.3], [0.4, 0.55, 0], t(K.sky), { rot: [0, -0.1, 0] }),
      P("shard", "octahedron", [0.4, 0.8, 0.3], [0, 1.0, 0], glow, { e: glow, ei: 1 }),
      P("rune", "box", [1.6, 0.06, 0.32], [0, 0.3, 0], glow, { e: glow, a: ["pulse", 2, 0.3] }),
    ],
  },
  trap: {
    id: "_snare", name: "Rune Snare", keywords: "", family: "fist", behaviour: "trap",
    parts: ({ t, glow, dark }) => [
      P("body", "cylinder", [1.4, 0.06, 1.4], [0, 0.03, 0], dark),
      P("rune", "torus", [1.2, 1.2, 0.04], [0, 0.07, 0], glow, { rot: [H, 0, 0], e: glow, a: ["spin", 1, 0] }),
      P("spike", "cone", [0.12, 0.36, 0.12], [0.4, 0.2, 0], t(K.steel), { mx: "x" }),
      P("spike", "cone", [0.12, 0.36, 0.12], [0, 0.2, 0.4], t(K.steel), { mx: "z" }),
      P("spike", "cone", [0.14, 0.44, 0.14], [0, 0.24, 0], t(K.steel)),
    ],
  },
  bomb: {
    id: "_bomb", name: "Bomb", keywords: "", family: "thrown", behaviour: "bomb",
    parts: ({ glow }) => [
      P("body", "sphere", [0.6, 0.6, 0.6], [0, 0.3, 0], K.black),
      P("rim", "cylinder", [0.2, 0.1, 0.2], [0, 0.62, 0], K.iron),
      P("handle", "cylinder", [0.04, 0.18, 0.04], [0.03, 0.74, 0], K.cream, { rot: [0, 0, -0.4] }),
      P("gem", "octahedron", [0.1, 0.1, 0.1], [0.07, 0.84, 0], glow, { e: glow, ei: 2.4, a: ["flicker", 14, 0.7] }),
      P("decor", "sphere", [0.12, 0.08, 0.04], [0.12, 0.42, 0.26], K.white),
    ],
  },
  heal_zone: {
    id: "_totem", name: "Mending Totem", keywords: "", family: "staff", behaviour: "heal_zone",
    parts: ({ t, glow }) => [
      P("body", "cylinder", [0.24, 0.8, 0.24], [0, 0.4, 0], t(K.wood)),
      P("orb", "icosahedron", [0.3, 0.3, 0.3], [0, 1.0, 0], K.mint, { e: glow, a: ["float", 2, 0.05] }),
      P("ring", "torus", [0.5, 0.5, 0.04], [0, 1.0, 0], K.mint, { rot: [H, 0, 0], e: glow, a: ["spin", 1.5, 0] }),
      P("limb", "wedge", [0.3, 0.14, 0.05], [0.2, 0.7, 0], t(K.leaf), { rot: [0, 0, -1.0], mx: "x" }),
    ],
  },
  rain: OBJECT_DESIGNS.find((d) => d.id === "cloud")!,
  ride: OBJECT_DESIGNS.find((d) => d.id === "horse")!,
  platform: {
    id: "_disc", name: "Hover Disc", keywords: "", family: "shield_small", behaviour: "platform",
    parts: ({ t, glow, accent }) => [
      P("body", "cylinder", [1.2, 0.12, 1.2], [0, 0.3, 0], t(K.steel), { m: 0.7 }),
      P("rim", "torus", [1.24, 1.24, 0.06], [0, 0.3, 0], accent, { rot: [H, 0, 0], e: glow, a: ["spin", 2, 0] }),
      P("orb", "cone", [0.5, 0.24, 0.5], [0, 0.12, 0], glow, { rot: [PI, 0, 0], e: glow, a: ["pulse", 3, 0.3] }),
    ],
  },
  decoy: {
    id: "_dummy", name: "Decoy Dummy", keywords: "", family: "staff", behaviour: "decoy",
    parts: ({ t, glow }) => [
      P("handle", "cylinder", [0.06, 1.1, 0.06], [0, 0.55, 0], t(K.wood)),
      P("body", "box", [0.7, 0.06, 0.06], [0, 0.95, 0], t(K.wood)),
      P("cloth", "box", [0.4, 0.45, 0.2], [0, 0.82, 0], t(K.cream), { a: ["wobble", 2, 0.1] }),
      P("head", "sphere", [0.26, 0.28, 0.24], [0, 1.2, 0], t(K.cream)),
      P("rune", "torus", [0.24, 0.24, 0.03], [0, 0.82, 0.11], K.red, { e: glow, a: ["pulse", 4, 0.4] }),
      P("cloth", "cone", [0.32, 0.18, 0.32], [0, 1.38, 0], t(K.brown)),
    ],
  },
};

const DESIGN_BY_ID = new Map(OBJECT_DESIGNS.map((d) => [d.id, d]));
export const designById = (id: string): ObjectDesign | undefined => DESIGN_BY_ID.get(id);
export const behaviourDesign = (b: SummonBehaviour): ObjectDesign => BEHAVIOUR_DESIGNS[b];

// ------------------------------------------------------------------------------------------------ keyword picking

interface DesignKw { d: ObjectDesign; re: RegExp; len: number }
const DESIGN_KWS: DesignKw[] = OBJECT_DESIGNS.flatMap((d) =>
  d.keywords.split("|").map((k) => ({ d, re: keywordRe([k], "gi"), len: k.length })));

/**
 * The library design a prompt names (head-noun rule like pickArchetype: a match starting before the first connective
 * wins, the one ending last; else the same over the whole prompt). Null when none.
 */
export function findDesign(text: string): ObjectDesign | null {
  const cut = text.search(HEAD_END);
  const headEnd = cut < 0 ? text.length : cut;
  let head: { d: ObjectDesign; end: number; len: number } | null = null;
  let all: { d: ObjectDesign; end: number; len: number } | null = null;
  const better = (a: { end: number; len: number } | null, end: number, len: number) =>
    !a || end > a.end || (end === a.end && len > a.len);
  for (const k of DESIGN_KWS) {
    k.re.lastIndex = 0;
    for (const m of text.matchAll(k.re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (start < headEnd && better(head, end, k.len)) head = { d: k.d, end, len: k.len };
      if (better(all, end, k.len)) all = { d: k.d, end, len: k.len };
    }
  }
  return (head ?? all)?.d ?? null;
}

const FILLER = new Set([
  "a", "an", "the", "some", "my", "your", "our", "this", "that", "one", "giant", "huge", "big", "tiny", "small", "little",
  "great", "mighty", "cool", "awesome", "epic", "magic", "magical", "legendary", "ancient", "cursed", "holy", "dark",
  "pure", "super", "mega", "ultra", "very", "really", "massive", "enormous", "angry", "evil", "good", "old", "new",
  "something", "anything", "thing", "things", "stuff", "weapon", "item", "object", "summon", "call", "conjure", "spawn",
  "flaming", "fiery", "fire", "flame", "burning", "molten", "lava", "ice", "icy", "frost", "frozen", "frosty", "snowy",
  "lightning", "electric", "thunder", "storm", "stormy", "shock", "shocking", "crystal", "golden", "silver", "iron",
  "steel", "wooden", "stone", "glowing", "flying", "floating", "living", "animated", "possessed", "rubber", "plastic",
  // adjective-only wishes stay weapons ("infinitely strong", "instant win")
  "strong", "stronger", "strongest", "powerful", "ultimate", "best", "deadly", "sharp", "fast", "quick", "heavy",
  "light", "long", "short", "infinite", "infinitely", "instant", "win", "overpowered", "unbeatable", "invincible",
  "random", "surprise", "please", "me", "for",
]);

/** The prompt's head noun ("a flaming steam train" -> "train"), or "" when it names nothing. */
export function headNoun(text: string): string {
  const cut = text.search(HEAD_END);
  const head = (cut < 0 ? text : text.slice(0, cut)).toLowerCase();
  const words = head.match(/[a-z][a-z'-]*/g) ?? [];
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i].replace(/'s$/, "");
    if (w.length >= 3 && !FILLER.has(w)) return w;
  }
  return "";
}

// ------------------------------------------------------------------------------------------------ colours

function colours(element: Element, rnd: () => number): Cols {
  const pals = elementPalettes(element);
  const pal = pals[Math.floor(rnd() * pals.length) % pals.length];
  const k = isPhysical(element) ? 0 : 0.28 + rnd() * 0.2;
  return {
    t: (hex) => (k > 0 ? mixHex(hex, pal.metal, k) : hex),
    glow: pal.glow,
    accent: pal.accent,
    dark: mixHex("#22252c", pal.dark, 0.4),
  };
}


/** Generic chunky object for a noun the library does not know: a seeded body + bits, coloured from the noun. */
function genericDesign(noun: string): ObjectDesign {
  return {
    id: "_generic", name: noun ? noun[0].toUpperCase() + noun.slice(1) : "Thing", keywords: "", family: "hammer",
    behaviour: "charge", mount: "head",
    parts: ({ t, glow, accent, dark }) => {
      const h = hashString(noun || "thing");
      const rnd = mulberry32(h ^ 0x5bd1e995);
      const pick = <T>(l: readonly T[]): T => l[Math.floor(rnd() * l.length) % l.length];
      const hue = (h % 360) / 360;
      const main = t(hslHex(hue, 0.65, 0.5));
      const second = t(hslHex((hue + 0.45) % 1, 0.6, 0.45));
      const body = pick(["box", "sphere", "icosahedron", "cylinder", "capsule", "octahedron"] as const);
      const w = 0.45 + rnd() * 0.3;
      const parts = [
        P("body", body, [w, 0.4 + rnd() * 0.25, 0.4 + rnd() * 0.3], [0, 0.3, 0], main),
        P("rim", pick(["torus", "cylinder"] as const), [w * 0.9, w * 0.9, 0.06], [0, 0.3, 0], second, { rot: [H, 0, 0] }),
        P("head", pick(["cone", "sphere", "box"] as const), [w * 0.5, 0.22, w * 0.5], [0, 0.62, 0], second),
        P("gem", pick(["octahedron", "sphere", "icosahedron"] as const), [0.12, 0.14, 0.08], [0, 0.34, 0.26], glow, { e: glow, a: ["pulse", 3, 0.3] }),
      ];
      if (rnd() < 0.6) parts.push(P("spike", "cone", [0.08, 0.2, 0.08], [w * 0.55, 0.32, 0], accent, { rot: [0, 0, -H], mx: "x" }));
      if (rnd() < 0.5) parts.push(P("limb", "cylinder", [0.08, 0.2, 0.08], [w * 0.3, 0.06, 0], dark, { mx: "x" }));
      return parts;
    },
  };
}


// ------------------------------------------------------------------------------------------------ geometry helpers

type M3 = [number, number, number, number, number, number, number, number, number];

/** Row-major rotation matrix of an Euler XYZ rotation (three.js order, as buildBlueprint uses). */
function eulerM(r: readonly number[]): M3 {
  const a = Math.cos(r[0]), b = Math.sin(r[0]), c = Math.cos(r[1]), d = Math.sin(r[1]), e = Math.cos(r[2]), f = Math.sin(r[2]);
  return [c * e, -c * f, d, a * f + b * e * d, a * e - b * f * d, -b * c, b * f - a * e * d, b * e + a * f * d, a * c];
}
function mul(A: M3, B: M3): M3 {
  const o = [0, 0, 0, 0, 0, 0, 0, 0, 0] as M3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
  return o;
}
function toEuler(m: M3): Vec3 {
  const y = Math.asin(Math.max(-1, Math.min(1, m[2])));
  if (Math.abs(m[2]) < 0.9999999) return [Math.atan2(-m[5], m[8]), y, Math.atan2(-m[1], m[0])];
  return [Math.atan2(m[7], m[4]), y, 0];
}
const apply = (m: M3, v: readonly number[]): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
const rotX = (a: number): M3 => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const rotY = (a: number): M3 => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const rotZ = (a: number): M3 => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** Mirrored parts become two explicit parts (a later rotation would move the mirror plane). */
function expandMirrors(parts: readonly BlueprintPart[]): BlueprintPart[] {
  const out: BlueprintPart[] = [];
  for (const p of parts) {
    const { mirror, ...rest } = p;
    const q: BlueprintPart = { ...rest, size: [...p.size] as Vec3, offset: [...p.offset] as Vec3, rotation: [...p.rotation] as Vec3 };
    out.push(q);
    if (mirror === "x") out.push({ ...q, offset: [-p.offset[0], p.offset[1], p.offset[2]], rotation: [p.rotation[0], -p.rotation[1], -p.rotation[2]] });
    if (mirror === "z") out.push({ ...q, offset: [p.offset[0], p.offset[1], -p.offset[2]], rotation: [-p.rotation[0], -p.rotation[1], p.rotation[2]] });
  }
  return out;
}


/** Rotates every part about the origin by `m` (mirrors expanded first). */
function rotateParts(parts: readonly BlueprintPart[], m: M3): BlueprintPart[] {
  return expandMirrors(parts).map((p) => ({
    ...p,
    offset: apply(m, p.offset).map(r4) as Vec3,
    rotation: toEuler(mul(m, eulerM(p.rotation))).map(r4) as Vec3,
  }));
}

function translate(parts: BlueprintPart[], d: Vec3): BlueprintPart[] {
  for (const p of parts) p.offset = [r4(p.offset[0] + d[0]), r4(p.offset[1] + d[1]), r4(p.offset[2] + d[2])];
  return parts;
}

/** Default mount per family: bottom-held heads (hammer / axe) sit across the handle, long things point up it. */
export function mountFor(family: WeaponFamily): Mount {
  switch (family) {
    case "hammer": case "axe": return "head";
    case "shield_small": case "shield_large": return "shield";
    case "thrown": case "focus": case "fist": return "center";
    default: return "tip";
  }
}

/**
 * Object frame -> weapon frame. tip: the longest axis becomes +Y (bottom at y = 0); head: the longest axis becomes X
 * (across the handle, bottom at y = 0); shield: the thinnest axis becomes Z (the face looks +Z), the longer of the
 * rest Y (bottom at y = 0); center: as authored, centred on the origin.
 */
export function mountObject(parts: readonly BlueprintPart[], mount: Mount): BlueprintPart[] {
  const b0 = partsBounds(parts);
  const ext = [b0.max[0] - b0.min[0], b0.max[1] - b0.min[1], b0.max[2] - b0.min[2]];
  let m: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (mount === "tip") {
    if (ext[2] >= ext[0] && ext[2] > ext[1]) m = rotX(-H); // Z -> Y
    else if (ext[0] > ext[1] && ext[0] > ext[2]) m = rotZ(H); // X -> Y
  } else if (mount === "head") {
    if (ext[2] > ext[0] && ext[2] >= ext[1]) m = rotY(H); // Z -> X
    else if (ext[1] > ext[0] && ext[1] > ext[2]) m = rotZ(-H); // Y -> X
  } else if (mount === "shield") {
    if (ext[0] <= ext[1] && ext[0] <= ext[2]) m = rotY(H); // thin X -> Z
    else if (ext[1] <= ext[0] && ext[1] <= ext[2]) m = rotX(H); // thin Y -> Z
    const e2 = swapExt(ext, m);
    if (e2[0] > e2[1] * 1.05) m = mul(rotZ(H), m); // the longer face axis stands up
  }
  const out = rotateParts(parts, m);
  const b = partsBounds(out);
  const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  if (mount === "center") return translate(out, [-cx, -(b.min[1] + b.max[1]) / 2, -cz]);
  return translate(out, [-cx, -b.min[1], -cz]);
}

/** Axis extents after rotating by a 90-degree matrix `m`. */
function swapExt(ext: number[], m: M3): number[] {
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) out[i] += Math.abs(m[i * 3 + j]) * ext[j];
  return out;
}

/** Families that get an automatic handle when the model has none (thrown / focus / fist / shields are hand-held). */
const HANDLE_RATIO: Partial<Record<WeaponFamily, number>> = {
  dagger: 0.35, sword: 0.32, greatsword: 0.35, axe: 1.1, hammer: 1.1, spear: 1.4, scythe: 1.3, whip: 0.5,
  staff: 1.2, bow: 0.3, crossbow: 0.3, gun: 0.3, cannon: 0.3,
};

/**
 * Server adds a handle if none: for families held at a handle, a model without a "handle" part is lifted onto a
 * wooden shaft (length = ratio x the model's extent) whose bottom is the grip (y = 0). Mutates and returns `bp`.
 * Post-handle offsets may exceed the +-2 clamp range (buildBlueprint rescales the whole item): never re-clamp it.
 */
export function ensureHandle(bp: ItemBlueprint, family: WeaponFamily): ItemBlueprint {
  const ratio = HANDLE_RATIO[family];
  if (!ratio || bp.parts.some((p) => p.role === "handle")) return bp;
  const b = partsBounds(bp.parts);
  const E = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 0.05);
  const Hh = ratio * E;
  const d = Math.min(0.14, Math.max(0.03, 0.07 * E));
  const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  // the thing sits on the handle (centred over it, its bottom at the handle's top)
  translate(bp.parts, [-cx, Hh - b.min[1] - 0.02 * E, -cz]);
  if (bp.parts.length >= MAX_PARTS) bp.parts.length = MAX_PARTS - 2;
  bp.parts.unshift(
    P("handle", "cylinder", [d, Hh, d], [0, r4(Hh / 2), 0], "#5e3b1d"),
    P("pommel", "sphere", [d * 1.5, d * 1.5, d * 1.5], [0, r4(d * 0.4), 0], "#3a2a1c"),
  );
  return bp;
}

// ------------------------------------------------------------------------------------------------ public builders

/** Seeded object-frame parts of a design (or a generic object for `noun`), painted for `element`. */
function designParts(design: ObjectDesign, element: Element, seed: number): { parts: BlueprintPart[]; cols: Cols } {
  const rnd = mulberry32(seed ^ 0x2c1b3c6d);
  const cols = colours(element, rnd);
  const s = 0.92 + rnd() * 0.16; // a little size variety
  const parts = design.parts(cols).map((p) => ({
    ...p, size: p.size.map((v) => r4(v * s)) as Vec3, offset: p.offset.map((v) => r4(v * s)) as Vec3,
  }));
  return { parts, cols };
}

function finish(parts: BlueprintPart[], cols: Cols, element: Element, design: ObjectDesign, seed: number): ItemBlueprint {
  const rnd = mulberry32(seed ^ 0x68e31da4);
  const bp: ItemBlueprint = { parts: parts.slice(0, MAX_PARTS), palette: [cols.t(K.steel), cols.glow, cols.accent, cols.dark] };
  if (!isPhysical(element)) bp.particles = { kind: elementParticles(element), color: cols.glow, rate: Math.round(8 + rnd() * 6) };
  else if (design.smoke) bp.particles = { kind: "smoke", color: "#c8c8c8", rate: 8 };
  else if (rnd() < 0.4) bp.particles = { kind: "motes", color: cols.glow, rate: 5 };
  return bp;
}

/** The design for a prompt / noun: a library match, else a generic object named after the head noun. */
export function designFor(text: string): ObjectDesign {
  return findDesign(text) ?? genericDesign(headNoun(text));
}

/** A summon's design: a library match, else a generic object for a named thing, else the behaviour's own model. */
export function summonDesignFor(text: string, behaviour: SummonBehaviour): ObjectDesign {
  const noun = headNoun(text);
  return findDesign(text) ?? (noun ? genericDesign(noun) : BEHAVIOUR_DESIGNS[behaviour]);
}

/** Weapon frame (+Y = grip -> tip) -> object frame: the item lies along +Z, base on y = 0 (novelty summons). */
export function layDown(bp: ItemBlueprint): ItemBlueprint {
  const parts = rotateParts(bp.parts, rotX(H));
  const b = partsBounds(parts);
  translate(parts, [-(b.min[0] + b.max[0]) / 2, -b.min[1], -(b.min[2] + b.max[2]) / 2]);
  return { ...bp, parts: parts.slice(0, MAX_PARTS) };
}

/**
 * Keyless improvised weapon: the design's object mounted for `family` (default: the design's own family) on a handle
 * (ensureHandle), painted for `element`, seeded. Weapon frame (grip at the origin, +Y to the tip).
 */
export function improvisedBlueprint(design: ObjectDesign, element: Element, seed: number, family: WeaponFamily = design.family): ItemBlueprint {
  const { parts, cols } = designParts(design, element, seed);
  const mount = family === design.family && design.mount ? design.mount : mountFor(family);
  const bp = finish(mountObject(parts, mount), cols, element, design, seed);
  bp.trail = { color: cols.glow, width: 0.12 };
  return ensureHandle(bp, family);
}

/** Keyless summon model: the design's object (object frame: base on y = 0, facing +Z), painted for `element`. */
export function summonBlueprint(design: ObjectDesign, element: Element, seed: number): ItemBlueprint {
  const { parts, cols } = designParts(design, element, seed);
  return finish(parts, cols, element, design, seed);
}

// ------------------------------------------------------------------------------------------------ LLM shapes

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | undefined =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined;
const HEX = /^#[0-9a-f]{6}$/i;
const ANIM_AMOUNT: Record<AnimKind, number> = { spin: 0, pulse: 0.25, float: 0.05, orbit: 0, flicker: 0.4, wobble: 0.3 };
/** At most this many LLM shape parts are read (the prompt asks for 4-10). */
export const SHAPE_MAX_PARTS = 12;

/**
 * The forge LLM's compact parts (SHAPE_PART_JSON_SCHEMA: r s z o t c e a) -> a raw blueprint for clampBlueprint
 * (which clamps every number and drops junk). Null when `raw` is not an array with at least 3 objects.
 */
export function expandShape(raw: unknown, element: Element): { parts: unknown[]; palette: string[] } | null {
  if (!Array.isArray(raw)) return null;
  const parts: unknown[] = [];
  for (const q of raw.slice(0, SHAPE_MAX_PARTS)) {
    if (!isObj(q)) continue;
    const e = typeof q.e === "string" && HEX.test(q.e.trim()) ? q.e.trim() : undefined;
    const a = oneOf(ANIM_KINDS, q.a);
    parts.push({
      role: oneOf(BLUEPRINT_ROLES, q.r) ?? "decor",
      shape: oneOf(BLUEPRINT_SHAPES, q.s) ?? "box",
      size: q.z, offset: q.o, rotation: q.t, color: q.c,
      ...(e ? { emissive: e, emissiveIntensity: 1.6 } : {}),
      ...(a ? { anim: { kind: a, speed: a === "spin" ? 4 : 2.5, amount: ANIM_AMOUNT[a] } } : {}),
    });
  }
  if (parts.length < 3) return null;
  const pal = elementPalettes(element)[0];
  return { parts, palette: [pal.metal, pal.glow, pal.accent] };
}

/** Particles for an LLM-shaped model: the element's, or none for Physical (the style's pk may add some). */
export function shapeParticles(element: Element): ItemBlueprint["particles"] | undefined {
  if (isPhysical(element)) return undefined;
  return { kind: elementParticles(element), color: elementPalettes(element)[0].glow, rate: 10 };
}

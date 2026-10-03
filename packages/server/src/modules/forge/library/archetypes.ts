// The built-in template library: ~130 hand-designed archetypes ported from Counterforge (packages/pipeline/src/
// archetypes.ts, MIT). Data only. Families are plain strings: a game declares its own families in the manifest
// (items.families) and the forge maps each one onto these templates (library/index.ts resolveFamily), so Counterforge
// keeps its 18 weapon families while any other game reuses the same models.
//
// Model conventions (Blueprint v1):
//  - metres; the grip (where the hand holds) is the origin; +Y runs grip -> tip (blade, head, muzzle, arrow).
//  - blades are flat: width on X, thickness on Z; axe bits / hammer faces stick out along +-X.
//  - guns / crossbows / cannons: barrel along +Y, the handle hangs toward -Z, sights on +Z, stock toward -Y.
//  - bows: grip at the origin, limbs span X, arrow points +Y, string behind (-Y).
//  - polearms, staffs, swords, hammers: the bottom end (pommel / butt) sits at y ~ 0.
//  - shields: bottom edge at y = 0, the body spans +Y, the face looks toward +Z.
//  - tier-2 objects stand on y = 0 (allies / arena objects face +Z); armour pieces are centred.
import type { AnimKind, BlueprintRole, BlueprintShape, ParticleKind } from "@liveforge/protocol";
import type { RawModel as ItemBlueprint, RawPart as BlueprintPart, StatBias as Budget, Vec3 } from "../model.js";

/** Library categories: held items (no category), armour pieces, allies (creatures) and arena objects (props). */
export type LibraryCategory = "armour" | "ally" | "arena_object";

export interface Archetype {
  id: string;
  name: string;
  /** Counterforge moveset family (dagger, sword, ... shield_large). Other games map their families onto these. */
  family: string;
  /** Whole-word keywords (lowercase; multi-word allowed) for keyword picking. */
  keywords: string[];
  /** Target longest extent (metres) of a medium item. */
  baseLength: number;
  /** The hand-designed model (neutral colours; proceduralBlueprint recolours and decorates it). */
  defaultBlueprint: ItemBlueprint;
  /** Stat bias (sum 100): the keyless stat spread. */
  statBias: Budget;
  /** Tier-2 archetypes (arena objects / armour / allies); absent = held. */
  category?: LibraryCategory;
}

/** The 18 Counterforge families the library is authored for. */
export const LIBRARY_FAMILIES = [
  "dagger", "sword", "greatsword", "axe", "hammer", "spear", "scythe", "whip", "fist",
  "bow", "crossbow", "gun", "cannon", "thrown", "staff", "focus", "shield_small", "shield_large",
] as const;

// ------------------------------------------------------------------------------------------------ authoring DSL

const PI = Math.PI;
const H = PI / 2;

/** Base colours (Physical look). */
const K = {
  steel: "#d5dee8", steel2: "#9ba8b6", iron: "#6f7883", dark: "#2c3039", black: "#18191e",
  gold: "#f5c542", brass: "#c99a3d", bronze: "#b87333", copper: "#cf6f3a",
  wood: "#8b5a2b", wood2: "#5e3b1d", leather: "#7b4526", leather2: "#4b2a17",
  bone: "#efe5cc", red: "#d62839", crimson: "#8e1b2e", blue: "#2f6fde", navy: "#22346e", teal: "#19b3a3",
  green: "#3daa4f", purple: "#7a46d0", white: "#f5f5f5", orange: "#ff8a2a", pink: "#ff70b8", yellow: "#ffd23f",
  cyan: "#59e3ff", silk: "#c23b4a", stone: "#8c8780", stone2: "#6b6660", moss: "#5d8a3a",
} as const;

type Anim = [AnimKind, number, number];
interface O { rot?: Vec3; e?: string; ei?: number; m?: number; r?: number; a?: Anim; mx?: "x" | "z" }

function P(role: BlueprintRole, shape: BlueprintShape, size: Vec3, offset: Vec3, color: string, o: O = {}): BlueprintPart {
  const sz = size.map((v) => Math.max(0.01, v)) as Vec3; // the validator's minimum part size
  const p: BlueprintPart = { role, shape, size: sz, offset, rotation: o.rot ?? [0, 0, 0], color };
  if (o.e) { p.emissive = o.e; p.emissiveIntensity = o.ei ?? 1; }
  if (o.m !== undefined) p.metalness = o.m;
  if (o.r !== undefined) p.roughness = o.r;
  if (o.a) p.anim = { kind: o.a[0], speed: o.a[1], amount: o.a[2] };
  if (o.mx) p.mirror = o.mx;
  return p;
}

interface Fx { trail?: { color: string; width: number }; particles?: { kind: ParticleKind; color: string; rate: number } }

const ALL: Archetype[] = [];

function A(
  id: string, name: string, family: string, keywords: string, baseLength: number,
  bias: [number, number, number, number], parts: BlueprintPart[], palette: string[], fx: Fx = {},
  category?: LibraryCategory,
): void {
  // Offsets are clamped to +-2 m and sizes to 1.5 m: very long / wide models are authored smaller (buildBlueprint
  // rescales to baseLength anyway).
  const reach = Math.max(...parts.flatMap((p) => p.offset.map(Math.abs)));
  const biggest = Math.max(...parts.flatMap((p) => p.size));
  if (reach > 1.95 || biggest > 1.5) {
    const f = Math.min(1.95 / reach, 1.5 / biggest);
    const r = (v: number) => Math.round(v * f * 1000) / 1000;
    for (const p of parts) {
      p.size = p.size.map((v) => Math.max(0.01, r(v))) as Vec3;
      p.offset = p.offset.map(r) as Vec3;
      if (p.anim && (p.anim.kind === "orbit" || p.anim.kind === "float")) p.anim.amount = r(p.anim.amount);
    }
  }
  const melee = !["bow", "crossbow", "gun", "cannon", "focus", "shield_small", "shield_large"].includes(family);
  const bp: ItemBlueprint = { parts, palette };
  const trail = fx.trail ?? (melee && !category ? { color: "#e8f4ff", width: Math.min(0.3, 0.06 + baseLength * 0.06) } : undefined);
  if (trail) bp.trail = trail;
  if (fx.particles) bp.particles = fx.particles;
  ALL.push({
    id, name, family, keywords: keywords.split("|"), baseLength, defaultBlueprint: bp,
    statBias: { damage: bias[0], speed: bias[1], range: bias[2], special: bias[3] }, category,
  });
}

/** Hilt from the bottom up: pommel, grip, guard. Returns the parts and the guard's top y. */
function hilt(o: {
  grip: number; gripD?: number; gripC: string; guardW: number; guardH?: number; guardD?: number; guardC: string;
  guardShape?: BlueprintShape; pommel?: number; pommelC?: string; pommelShape?: BlueprintShape; wraps?: number; wrapC?: string;
}): { parts: BlueprintPart[]; top: number } {
  const pm = o.pommel ?? 0.05;
  const gd = o.gripD ?? 0.034;
  const parts: BlueprintPart[] = [];
  if (pm > 0) parts.push(P("pommel", o.pommelShape ?? "sphere", [pm, pm, pm], [0, pm / 2, 0], o.pommelC ?? o.guardC));
  const g0 = pm * 0.8;
  parts.push(P("handle", "cylinder", [gd, o.grip, gd], [0, g0 + o.grip / 2, 0], o.gripC));
  for (let i = 0; i < (o.wraps ?? 0); i++) {
    const y = g0 + (o.grip * (i + 0.5)) / (o.wraps ?? 1);
    parts.push(P("decor", "octahedron", [gd * 0.9, gd * 0.6, gd * 1.15], [0, y, 0], o.wrapC ?? K.white));
  }
  const gh = o.guardH ?? 0.03;
  const gy = g0 + o.grip + gh / 2;
  parts.push(P("guard", o.guardShape ?? "box", [o.guardW, gh, o.guardD ?? 0.05], [0, gy, 0], o.guardC));
  return { parts, top: gy + gh / 2 };
}

/** A straight blade (wedge) standing on y0. */
const blade = (y0: number, len: number, w: number, c: string, t = 0.014, extra: O = {}) =>
  P("blade", "wedge", [w, len, t], [0, y0 + len / 2, 0], c, extra);

/** Fuller / engraving down both faces of a blade. */
const fuller = (y0: number, len: number, w: number, c: string, t = 0.014) =>
  P("rune", "box", [w, len, 0.004], [0, y0 + len / 2, t * 0.32], c, { mx: "z" });

/** Two-piece shaft (each part <= 1.5 m) from y0 to y0 + len. */
function shaft(y0: number, len: number, d: number, c1: string, c2 = c1): BlueprintPart[] {
  const a = len * 0.5;
  return [
    P("handle", "cylinder", [d, a, d], [0, y0 + a / 2, 0], c1),
    P("handle", "cylinder", [d * 0.95, len - a, d * 0.95], [0, y0 + a + (len - a) / 2, 0], c2),
  ];
}

/** A ring around the item axis (torus in the XZ plane). */
const band = (y: number, d: number, c: string, t = 0.012, o: O = {}) =>
  P("ring", "torus", [d, d, t], [0, y, 0], c, { rot: [H, 0, 0], ...o });

const glow = (c: string, ei = 1.4): O => ({ e: c, ei });

/**
 * An axe bit sticking out toward +X from a haft at x = 0, centred at height y: a flattened fan (cone, tip in the haft)
 * plus a curved cutting edge (crescent). mirror "x" makes a double-bitted axe.
 */
function axeBit(y: number, edge: number, depth: number, t: number, c: string, mx?: "x", edgeC = K.steel): BlueprintPart[] {
  const baseX = 0.012 + depth;
  return [
    P("blade", "cone", [edge, depth, t], [baseX - depth / 2, y, 0], c, { rot: [0, 0, H], mx }),
    P("blade", "crescent", [edge, depth * 0.3, t * 1.1], [baseX + depth * 0.15, y, 0], edgeC, { rot: [0, 0, -H], mx }),
  ];
}

// Gun helpers: handle hanging toward -Z at the origin, trigger guard, barrel along +Y.
function pistolGrip(c: string, len = 0.12): BlueprintPart[] {
  return [
    P("handle", "box", [0.034, 0.045, len], [0, -0.012, -len / 2 + 0.01], c, { rot: [-0.3, 0, 0] }),
    P("guard", "torus", [0.05, 0.045, 0.008], [0, 0.035, -0.03], K.dark, { rot: [0, H, 0] }),
  ];
}

// ------------------------------------------------------------------------------------------------ daggers

{
  const h = hilt({ grip: 0.1, gripC: K.leather, guardW: 0.11, guardC: K.brass, pommel: 0.035 });
  A("dagger", "Dagger", "dagger", "dagger|daggers|poniard|shiv", 0.45, [25, 40, 10, 25],
    [...h.parts, blade(h.top, 0.24, 0.045, K.steel), fuller(h.top, 0.16, 0.008, K.steel2)], [K.steel, K.leather, K.brass]);
}
{
  const h = hilt({ grip: 0.1, gripD: 0.03, gripC: K.wood, guardW: 0.035, guardH: 0.012, guardD: 0.035, guardC: K.iron, pommel: 0 });
  A("knife", "Knife", "dagger", "knife|knives|switchblade|pocket knife", 0.36, [22, 45, 10, 23],
    [...h.parts, P("blade", "wedge", [0.04, 0.17, 0.008], [0.004, h.top + 0.085, 0], K.steel),
      P("decor", "cylinder", [0.008, 0.006, 0.034], [0, 0.03, 0], K.brass, { rot: [H, 0, 0], mx: "z" })],
    [K.steel, K.wood, K.iron]);
}
A("kunai", "Kunai", "dagger", "kunai", 0.4, [22, 40, 20, 18], [
  band(0.01, 0.06, K.iron, 0.012),
  P("handle", "cylinder", [0.026, 0.12, 0.026], [0, 0.085, 0], K.black),
  P("decor", "box", [0.03, 0.012, 0.03], [0, 0.07, 0], K.red, { rot: [0, 0.6, 0] }),
  P("decor", "box", [0.03, 0.012, 0.03], [0, 0.11, 0], K.red, { rot: [0, -0.6, 0] }),
  P("blade", "octahedron", [0.07, 0.22, 0.014], [0, 0.25, 0], K.iron, { m: 0.6 }),
], [K.iron, K.black, K.red]);
{
  const h = hilt({ grip: 0.11, gripC: K.leather2, guardW: 0.08, guardShape: "cylinder", guardH: 0.02, guardD: 0.04, guardC: K.brass, pommel: 0.045, pommelShape: "icosahedron" });
  A("dirk", "Dirk", "dagger", "dirk|stiletto knife", 0.5, [28, 36, 10, 26],
    [...h.parts, blade(h.top, 0.3, 0.035, K.steel), fuller(h.top, 0.22, 0.007, K.steel2),
      P("gem", "octahedron", [0.03, 0.03, 0.03], [0, h.top - 0.015, 0.022], K.red)], [K.steel, K.leather2, K.brass]);
}
{
  const h = hilt({ grip: 0.1, gripD: 0.026, gripC: K.black, guardW: 0.13, guardH: 0.012, guardD: 0.02, guardC: K.steel2, pommel: 0.03, pommelC: K.steel2 });
  A("stiletto", "Stiletto", "dagger", "stiletto|needle|awl", 0.45, [22, 46, 14, 18],
    [...h.parts, P("blade", "prism", [0.022, 0.26, 0.022], [0, h.top + 0.13, 0], K.steel),
      P("blade", "cone", [0.022, 0.06, 0.022], [0, h.top + 0.29, 0], K.steel)], [K.steel, K.black, K.steel2]);
}
A("sai", "Sai", "dagger", "sai", 0.5, [22, 38, 10, 30], [
  P("pommel", "sphere", [0.035, 0.03, 0.035], [0, 0.015, 0], K.steel2),
  P("handle", "cylinder", [0.03, 0.12, 0.03], [0, 0.085, 0], K.crimson),
  P("guard", "box", [0.06, 0.02, 0.02], [0, 0.15, 0], K.steel2),
  P("guard", "cylinder", [0.014, 0.12, 0.014], [0.045, 0.19, 0], K.steel2, { rot: [0, 0, -0.45], mx: "x" }),
  P("blade", "prism", [0.022, 0.32, 0.022], [0, 0.31, 0], K.steel),
  P("spike", "cone", [0.022, 0.05, 0.022], [0, 0.495, 0], K.steel),
], [K.steel, K.crimson, K.steel2]);
{
  const h = hilt({ grip: 0.1, gripC: K.wood2, guardW: 0.1, guardShape: "wedge", guardH: 0.035, guardC: K.gold, pommel: 0.04, pommelC: K.gold });
  const y = h.top;
  const seg = (i: number, x: number) => P("blade", "box", [0.042, 0.1, 0.012], [x, y + 0.05 + i * 0.065, 0], K.steel, { rot: [0, 0, x > 0 ? 0.3 : -0.3] });
  A("kris", "Kris", "dagger", "kris|keris|wavy dagger", 0.5, [26, 34, 10, 30],
    [...h.parts, seg(0, 0.008), seg(1, -0.008), seg(2, 0.008), seg(3, -0.008), P("blade", "cone", [0.034, 0.08, 0.012], [0, y + 0.3, 0], K.steel)],
    [K.steel, K.wood2, K.gold]);
}
A("karambit", "Karambit", "dagger", "karambit|talon knife", 0.32, [24, 46, 8, 22], [
  band(0.0, 0.06, K.steel2, 0.012),
  P("handle", "box", [0.032, 0.13, 0.022], [0, 0.08, 0], K.black, { rot: [0, 0, 0.15] }),
  P("blade", "crescent", [0.18, 0.09, 0.012], [0.035, 0.18, 0], K.steel, { rot: [0, 0, -2.3] }),
], [K.steel, K.black, K.steel2]);
{
  const h = hilt({ grip: 0.12, gripC: K.black, guardW: 0.055, guardShape: "cylinder", guardH: 0.012, guardD: 0.05, guardC: K.gold, pommel: 0.025, pommelC: K.gold, wraps: 3 });
  A("tanto", "Tanto", "dagger", "tanto", 0.45, [26, 40, 8, 26],
    [...h.parts, P("blade", "box", [0.035, 0.2, 0.012], [0, h.top + 0.1, 0], K.steel),
      P("blade", "wedge", [0.035, 0.08, 0.012], [0, h.top + 0.235, 0], K.steel),
      P("decor", "box", [0.004, 0.2, 0.013], [-0.012, h.top + 0.1, 0], K.white)], [K.steel, K.black, K.gold]);
}

// ------------------------------------------------------------------------------------------------ swords

{
  const h = hilt({ grip: 0.17, gripC: K.leather, guardW: 0.22, guardC: K.steel2, pommel: 0.055, pommelC: K.steel2, pommelShape: "icosahedron" });
  A("arming_sword", "Arming Sword", "sword", "sword|swords|blade|blades|arming sword|shortsword|short sword", 1.0, [30, 30, 15, 25],
    [...h.parts, blade(h.top, 0.72, 0.055, K.steel), fuller(h.top, 0.55, 0.01, K.steel2)], [K.steel, K.leather, K.steel2]);
}
{
  const h = hilt({ grip: 0.22, gripC: K.leather2, guardW: 0.26, guardC: K.iron, guardH: 0.035, pommel: 0.06, pommelC: K.iron, pommelShape: "octahedron" });
  A("longsword", "Longsword", "sword", "longsword|long sword|bastard sword|knightly sword", 1.15, [32, 26, 18, 24],
    [...h.parts, blade(h.top, 0.82, 0.05, K.steel), fuller(h.top, 0.65, 0.01, K.steel2),
      P("decor", "cone", [0.03, 0.06, 0.03], [0.14, h.top - 0.017, 0], K.iron, { rot: [0, 0, -H], mx: "x" })], [K.steel, K.leather2, K.iron]);
}
{
  const h = hilt({ grip: 0.18, gripC: K.navy, guardW: 0.28, guardH: 0.04, guardD: 0.06, guardC: K.gold, pommel: 0.06, pommelC: K.gold });
  A("broadsword", "Broadsword", "sword", "broadsword|broad sword|paladin sword|holy sword", 1.05, [36, 24, 15, 25],
    [...h.parts, blade(h.top, 0.75, 0.085, K.steel), fuller(h.top, 0.6, 0.02, K.gold),
      P("gem", "octahedron", [0.04, 0.05, 0.03], [0, h.top - 0.02, 0.03], K.blue, glow(K.blue, 0.6))], [K.steel, K.navy, K.gold]);
}
{
  const h = hilt({ grip: 0.27, gripD: 0.034, gripC: K.black, guardW: 0.085, guardShape: "cylinder", guardH: 0.014, guardD: 0.085, guardC: K.gold, pommel: 0.03, pommelC: K.gold, pommelShape: "cylinder", wraps: 5 });
  const y = h.top;
  A("katana", "Katana", "sword", "katana|samurai sword|uchigatana|wakizashi", 1.05, [32, 34, 14, 20],
    [...h.parts,
      P("blade", "box", [0.032, 0.42, 0.012], [0, y + 0.21, 0], K.steel),
      P("blade", "wedge", [0.03, 0.34, 0.012], [-0.012, y + 0.585, 0], K.steel, { rot: [0, 0, 0.06] }),
      P("decor", "box", [0.006, 0.42, 0.013], [-0.012, y + 0.21, 0], K.white),
      P("decor", "box", [0.035, 0.03, 0.016], [0, y + 0.015, 0], K.gold)],
    [K.steel, K.black, K.gold]);
}
{
  const g = 0.13;
  A("rapier", "Rapier", "sword", "rapier|epee|foil|fencing sword|estoc", 1.05, [24, 40, 20, 16], [
    P("pommel", "sphere", [0.045, 0.045, 0.045], [0, 0.022, 0], K.gold),
    P("handle", "cylinder", [0.028, g, 0.028], [0, 0.04 + g / 2, 0], K.crimson),
    P("guard", "sphere", [0.12, 0.05, 0.12], [0, 0.04 + g + 0.02, 0], K.gold),
    P("ring", "torus", [0.11, 0.13, 0.008], [0.03, 0.12, 0], K.gold, { rot: [0, 0.3, 0] }),
    P("guard", "box", [0.2, 0.012, 0.012], [0, 0.04 + g + 0.045, 0], K.gold),
    P("blade", "prism", [0.018, 0.78, 0.014], [0, 0.04 + g + 0.05 + 0.39, 0], K.steel),
    P("blade", "cone", [0.018, 0.06, 0.014], [0, 0.04 + g + 0.05 + 0.81, 0], K.steel),
  ], [K.steel, K.gold, K.crimson]);
}
{
  const h = hilt({ grip: 0.15, gripC: K.leather, guardW: 0.1, guardC: K.brass, guardH: 0.02, pommel: 0.04, pommelC: K.brass });
  A("sabre", "Sabre", "sword", "sabre|saber|cavalry sword|shamshir", 1.0, [28, 36, 14, 22],
    [...h.parts,
      P("blade", "crescent", [0.8, 0.11, 0.012], [-0.015, h.top + 0.4, 0], K.steel, { rot: [0, 0, -H] }),
      P("guard", "crescent", [0.2, 0.06, 0.012], [0.03, 0.12, 0], K.brass, { rot: [0, 0, -H] })],
    [K.steel, K.leather, K.brass]);
}
{
  const h = hilt({ grip: 0.14, gripC: K.crimson, guardW: 0.16, guardC: K.gold, guardH: 0.025, pommel: 0.045, pommelC: K.gold, pommelShape: "cone" });
  A("scimitar", "Scimitar", "sword", "scimitar|falchion|tulwar", 0.95, [32, 32, 12, 24],
    [...h.parts,
      P("blade", "crescent", [0.7, 0.16, 0.014], [-0.04, h.top + 0.34, 0], K.steel, { rot: [0, 0, -H] }),
      P("decor", "crescent", [0.6, 0.06, 0.016], [-0.02, h.top + 0.33, 0], K.gold, { rot: [0, 0, -H] })],
    [K.steel, K.crimson, K.gold]);
}
{
  const h = hilt({ grip: 0.13, gripC: K.wood2, guardW: 0.06, guardC: K.brass, guardH: 0.02, pommel: 0.04, pommelC: K.brass });
  A("cutlass", "Cutlass", "sword", "cutlass|pirate sword|hanger", 0.9, [30, 34, 12, 24],
    [...h.parts,
      P("guard", "sphere", [0.14, 0.13, 0.09], [0.025, 0.11, 0], K.brass, { rot: [0, 0, 0] }),
      P("blade", "crescent", [0.66, 0.1, 0.014], [-0.02, h.top + 0.33, 0], K.steel, { rot: [0, 0, -H] })],
    [K.steel, K.brass, K.wood2]);
}
{
  const h = hilt({ grip: 0.1, gripD: 0.04, gripC: K.wood, guardW: 0.11, guardH: 0.035, guardD: 0.06, guardC: K.bronze, guardShape: "capsule", pommel: 0.06, pommelC: K.bronze });
  A("gladius", "Gladius", "sword", "gladius|roman sword|xiphos", 0.75, [32, 36, 8, 24],
    [...h.parts, blade(h.top, 0.5, 0.065, K.steel), fuller(h.top, 0.35, 0.01, K.bronze)], [K.steel, K.wood, K.bronze]);
}
A("khopesh", "Khopesh", "sword", "khopesh|sickle sword", 0.85, [32, 30, 10, 28], [
  P("pommel", "cone", [0.04, 0.04, 0.04], [0, 0.02, 0], K.gold, { rot: [PI, 0, 0] }),
  P("handle", "cylinder", [0.035, 0.14, 0.035], [0, 0.11, 0], K.navy),
  P("guard", "box", [0.06, 0.02, 0.05], [0, 0.19, 0], K.gold),
  P("blade", "box", [0.035, 0.28, 0.014], [0, 0.34, 0], K.bronze),
  P("blade", "crescent", [0.38, 0.17, 0.016], [-0.08, 0.56, 0], K.bronze, { rot: [0, 0, 0.5] }),
  P("decor", "box", [0.01, 0.26, 0.016], [0.01, 0.34, 0], K.gold),
], [K.bronze, K.navy, K.gold]);
{
  const h = hilt({ grip: 0.15, gripD: 0.038, gripC: K.black, guardW: 0.05, guardH: 0.015, guardC: K.dark, pommel: 0.03, pommelC: K.dark });
  A("machete", "Machete", "sword", "machete|bolo|jungle blade|kukri", 0.85, [32, 34, 10, 24],
    [...h.parts,
      P("blade", "box", [0.075, 0.42, 0.01], [0.012, h.top + 0.21, 0], K.steel2),
      P("blade", "wedge", [0.085, 0.14, 0.01], [0.008, h.top + 0.48, 0], K.steel2, { rot: [0, 0, -0.18] }),
      P("decor", "box", [0.02, 0.42, 0.011], [0.04, h.top + 0.21, 0], K.steel)],
    [K.steel2, K.black, K.dark]);
}

// ------------------------------------------------------------------------------------------------ greatswords

{
  const h = hilt({ grip: 0.32, gripC: K.leather, guardW: 0.42, guardH: 0.035, guardC: K.iron, pommel: 0.07, pommelC: K.iron, pommelShape: "icosahedron" });
  A("claymore", "Claymore", "greatsword", "claymore|greatsword|great sword|two-handed sword|two handed sword", 1.6, [42, 18, 20, 20],
    [...h.parts, blade(h.top, 1.1, 0.07, K.steel), fuller(h.top, 0.85, 0.014, K.steel2),
      P("decor", "torus", [0.06, 0.06, 0.014], [0.2, h.top - 0.02, 0], K.iron, { mx: "x" }),
      P("guard", "cone", [0.04, 0.08, 0.04], [0.2, h.top + 0.03, 0], K.iron, { rot: [0, 0, 0.6], mx: "x" })],
    [K.steel, K.leather, K.iron]);
}
{
  const h = hilt({ grip: 0.38, gripC: K.crimson, guardW: 0.5, guardH: 0.04, guardC: K.steel2, pommel: 0.08, pommelC: K.steel2, pommelShape: "octahedron" });
  A("zweihander", "Zweihander", "greatsword", "zweihander|zweihaender|montante", 1.75, [44, 16, 22, 18],
    [...h.parts, blade(h.top, 0.3, 0.06, K.steel2),
      P("guard", "crescent", [0.16, 0.05, 0.02], [0, h.top + 0.3, 0], K.steel2, { mx: "x", rot: [0, 0, PI] }),
      blade(h.top + 0.3, 0.95, 0.075, K.steel), fuller(h.top + 0.3, 0.75, 0.014, K.steel2)],
    [K.steel, K.crimson, K.steel2]);
}
{
  const h = hilt({ grip: 0.3, gripD: 0.045, gripC: K.dark, guardW: 0.2, guardH: 0.06, guardD: 0.08, guardC: K.iron, pommel: 0.06, pommelC: K.iron, pommelShape: "box" });
  A("buster_sword", "Buster Sword", "greatsword", "buster sword|buster|giant sword|huge sword|slab", 1.6, [48, 14, 18, 20],
    [...h.parts,
      P("blade", "box", [0.22, 0.95, 0.03], [0, h.top + 0.475, 0], K.steel2),
      P("blade", "prism", [0.22, 0.03, 0.18], [0, h.top + 1.0, 0], K.steel2, { rot: [H, 0, 0] }),
      P("decor", "cylinder", [0.04, 0.03, 0.04], [0, h.top + 0.1, 0], K.iron, { rot: [H, 0, 0] }),
      P("decor", "cylinder", [0.04, 0.03, 0.04], [0, h.top + 0.18, 0], K.iron, { rot: [H, 0, 0] }),
      P("decor", "box", [0.03, 0.8, 0.032], [0.08, h.top + 0.45, 0], K.steel)],
    [K.steel2, K.dark, K.iron]);
}
{
  const h = hilt({ grip: 0.32, gripC: K.navy, guardW: 0.4, guardH: 0.035, guardC: K.gold, pommel: 0.07, pommelC: K.gold });
  const y = h.top;
  const wave = (i: number) => P("blade", "wedge", [0.08, 0.2, 0.016], [i % 2 ? 0.012 : -0.012, y + 0.1 + i * 0.17, 0], K.steel, { rot: [0, 0, i % 2 ? -0.25 : 0.25] });
  A("flamberge", "Flamberge", "greatsword", "flamberge|flame-bladed|wavy sword|flambard", 1.65, [44, 18, 20, 18],
    [...h.parts, wave(0), wave(1), wave(2), wave(3), wave(4), wave(5), P("blade", "cone", [0.06, 0.16, 0.014], [0, y + 1.1, 0], K.steel)],
    [K.steel, K.navy, K.gold]);
}
{
  const h = hilt({ grip: 0.4, gripC: K.black, guardW: 0.1, guardShape: "cylinder", guardH: 0.016, guardD: 0.1, guardC: K.gold, pommel: 0.035, pommelC: K.gold, pommelShape: "cylinder", wraps: 7, wrapC: K.silk });
  A("nodachi", "Nodachi", "greatsword", "nodachi|odachi|ninja sword|long katana", 1.75, [42, 24, 22, 12],
    [...h.parts,
      P("blade", "box", [0.04, 0.6, 0.014], [0, h.top + 0.3, 0], K.steel),
      P("blade", "wedge", [0.038, 0.55, 0.014], [-0.02, h.top + 0.87, 0], K.steel, { rot: [0, 0, 0.07] }),
      P("decor", "box", [0.007, 0.6, 0.015], [-0.015, h.top + 0.3, 0], K.white)],
    [K.steel, K.black, K.silk]);
}
{
  const h = hilt({ grip: 0.32, gripC: K.wood2, guardW: 0.3, guardH: 0.04, guardC: K.dark, pommel: 0.07, pommelC: K.dark, pommelShape: "sphere" });
  A("executioner", "Executioner's Sword", "greatsword", "executioner|headsman|executioner's sword", 1.5, [50, 12, 18, 20],
    [...h.parts,
      P("blade", "box", [0.12, 0.9, 0.02], [0, h.top + 0.45, 0], K.steel2),
      P("rune", "torus", [0.05, 0.05, 0.022], [0, h.top + 0.8, 0], K.dark),
      P("decor", "box", [0.02, 0.6, 0.022], [0, h.top + 0.35, 0], K.dark)],
    [K.steel2, K.wood2, K.dark]);
}

// ------------------------------------------------------------------------------------------------ axes

A("hatchet", "Hatchet", "axe", "hatchet|hand axe|handaxe|tomahawk", 0.55, [34, 34, 10, 22], [
  P("handle", "cylinder", [0.035, 0.5, 0.035], [0, 0.25, 0], K.wood),
  P("head", "box", [0.08, 0.07, 0.035], [0.03, 0.46, 0], K.iron),
  ...axeBit(0.44, 0.17, 0.12, 0.022, K.steel2),
  P("decor", "cylinder", [0.04, 0.03, 0.04], [0, 0.04, 0], K.leather),
], [K.steel, K.wood, K.iron]);
A("battleaxe", "Battleaxe", "axe", "axe|axes|battleaxe|battle axe|double axe|labrys", 1.15, [44, 20, 14, 22], [
  ...shaft(0, 1.05, 0.042, K.wood2, K.wood),
  P("head", "cylinder", [0.07, 0.16, 0.07], [0, 0.93, 0], K.iron),
  ...axeBit(0.93, 0.36, 0.21, 0.03, K.steel2, "x"),
  P("spike", "cone", [0.05, 0.1, 0.05], [0, 1.06, 0], K.iron),
  band(0.15, 0.06, K.leather, 0.02), band(0.3, 0.06, K.leather, 0.02),
], [K.steel, K.wood2, K.iron]);
A("greataxe", "Greataxe", "axe", "greataxe|great axe|headsman axe|war axe|waraxe", 1.4, [50, 14, 16, 20], [
  ...shaft(0, 1.3, 0.05, K.dark, K.wood2),
  P("head", "box", [0.12, 0.2, 0.06], [0.05, 1.12, 0], K.iron),
  ...axeBit(1.1, 0.52, 0.3, 0.035, K.steel2),
  P("spike", "cone", [0.06, 0.2, 0.05], [-0.1, 1.12, 0], K.iron, { rot: [0, 0, H] }),
  P("spike", "cone", [0.06, 0.14, 0.06], [0, 1.3, 0], K.iron),
  band(0.08, 0.07, K.iron, 0.02),
], [K.steel, K.dark, K.iron]);
A("bearded_axe", "Bearded Axe", "axe", "bearded axe|viking axe|dane axe|skeggox", 0.95, [42, 22, 14, 22], [
  ...shaft(0, 0.9, 0.04, K.wood),
  P("head", "box", [0.07, 0.08, 0.04], [0.03, 0.82, 0], K.iron),
  ...axeBit(0.74, 0.3, 0.17, 0.024, K.steel2),
  P("blade", "wedge", [0.05, 0.1, 0.02], [0.05, 0.62, 0], K.steel2, { rot: [0, 0, 2.6] }),
  P("decor", "torus", [0.05, 0.05, 0.012], [0, 0.6, 0], K.bronze, { rot: [H, 0, 0] }),
  P("cloth", "box", [0.03, 0.12, 0.004], [0.02, 0.55, 0.025], K.red, { a: ["wobble", 3, 0.2] }),
], [K.steel, K.wood, K.red]);
A("cleaver", "Cleaver", "axe", "cleaver|meat cleaver|butcher", 0.6, [40, 28, 8, 24], [
  P("handle", "cylinder", [0.04, 0.2, 0.04], [0, 0.1, 0], K.wood2),
  P("decor", "cylinder", [0.012, 0.045, 0.012], [0, 0.07, 0], K.steel2, { rot: [H, 0, 0] }),
  P("blade", "box", [0.18, 0.34, 0.012], [0.065, 0.37, 0], K.steel),
  P("decor", "box", [0.025, 0.34, 0.013], [0.145, 0.37, 0], K.white),
  P("rune", "torus", [0.035, 0.035, 0.013], [0.09, 0.5, 0], K.dark),
], [K.steel, K.wood2, K.white]);
A("pickaxe", "Pickaxe", "axe", "pickaxe|pick axe|pick|mattock", 0.95, [42, 22, 12, 24], [
  ...shaft(0, 0.85, 0.04, K.wood),
  P("head", "box", [0.08, 0.07, 0.06], [0, 0.85, 0], K.iron),
  P("spike", "cone", [0.05, 0.3, 0.04], [0.17, 0.83, 0], K.iron, { rot: [0, 0, -1.85] }),
  P("spike", "cone", [0.05, 0.3, 0.04], [-0.17, 0.83, 0], K.iron, { rot: [0, 0, 1.85] }),
], [K.iron, K.wood, K.steel2]);

// ------------------------------------------------------------------------------------------------ hammers & maces

A("warhammer", "Warhammer", "hammer", "hammer|hammers|warhammer|war hammer|mjolnir", 1.2, [46, 18, 14, 22], [
  ...shaft(0, 1.0, 0.045, K.wood2, K.leather),
  P("head", "box", [0.32, 0.16, 0.16], [0, 1.0, 0], K.iron),
  P("head", "cylinder", [0.17, 0.04, 0.17], [0.18, 1.0, 0], K.steel2, { rot: [0, 0, H], mx: "x" }),
  P("decor", "box", [0.1, 0.17, 0.17], [0, 1.0, 0], K.brass),
  P("spike", "cone", [0.06, 0.12, 0.06], [0, 1.13, 0], K.iron),
  P("pommel", "octahedron", [0.07, 0.07, 0.07], [0, 0.0, 0], K.brass),
], [K.iron, K.wood2, K.brass]);
A("maul", "Maul", "hammer", "maul|great hammer|greathammer|sledge maul", 1.4, [52, 12, 16, 20], [
  ...shaft(0, 1.2, 0.05, K.wood2),
  P("head", "box", [0.44, 0.24, 0.24], [0, 1.24, 0], K.stone, { m: 0.1, r: 0.9 }),
  P("rim", "box", [0.05, 0.26, 0.26], [0.16, 1.24, 0], K.iron, { mx: "x" }),
  P("decor", "box", [0.12, 0.25, 0.25], [0, 1.24, 0], K.iron),
  band(0.12, 0.07, K.leather, 0.02),
], [K.stone, K.iron, K.wood2]);
A("sledgehammer", "Sledgehammer", "hammer", "sledgehammer|sledge hammer|sledge", 1.1, [50, 14, 12, 24], [
  ...shaft(0, 0.95, 0.04, K.yellow, K.wood),
  P("head", "cylinder", [0.14, 0.3, 0.14], [0, 0.98, 0], K.dark, { rot: [0, 0, H] }),
  P("rim", "cylinder", [0.15, 0.02, 0.15], [0.14, 0.98, 0], K.steel2, { rot: [0, 0, H], mx: "x" }),
], [K.dark, K.yellow, K.steel2]);
A("mace", "Mace", "hammer", "mace|flanged mace|cudgel", 0.85, [42, 26, 10, 22], [
  P("pommel", "sphere", [0.05, 0.05, 0.05], [0, 0.025, 0], K.brass),
  P("handle", "cylinder", [0.035, 0.6, 0.035], [0, 0.33, 0], K.leather),
  P("head", "sphere", [0.12, 0.16, 0.12], [0, 0.72, 0], K.iron),
  P("blade", "box", [0.07, 0.15, 0.022], [0.07, 0.72, 0], K.steel2, { mx: "x" }),
  P("blade", "box", [0.022, 0.15, 0.07], [0, 0.72, 0.07], K.steel2, { mx: "z" }),
  P("spike", "cone", [0.04, 0.07, 0.04], [0, 0.82, 0], K.steel2),
], [K.iron, K.leather, K.steel2]);
A("morningstar", "Morningstar", "hammer", "morningstar|morning star|spiked mace|spiked club", 0.95, [46, 22, 10, 22], [
  P("handle", "cylinder", [0.04, 0.65, 0.04], [0, 0.325, 0], K.wood2),
  band(0.1, 0.06, K.iron, 0.02),
  P("head", "icosahedron", [0.2, 0.2, 0.2], [0, 0.77, 0], K.iron),
  P("spike", "cone", [0.05, 0.12, 0.05], [0.13, 0.77, 0], K.steel, { rot: [0, 0, -H], mx: "x" }),
  P("spike", "cone", [0.05, 0.12, 0.05], [0, 0.77, 0.13], K.steel, { rot: [H, 0, 0], mx: "z" }),
  P("spike", "cone", [0.05, 0.12, 0.05], [0.09, 0.86, 0.0], K.steel, { rot: [0, 0, -0.8], mx: "x" }),
  P("spike", "cone", [0.05, 0.12, 0.05], [0, 0.9, 0], K.steel),
], [K.iron, K.wood2, K.steel]);
A("flail", "Flail", "hammer", "flail|ball and chain|ball-and-chain", 1.0, [48, 18, 14, 20], [
  P("handle", "cylinder", [0.04, 0.4, 0.04], [0, 0.2, 0], K.wood),
  P("pommel", "sphere", [0.05, 0.05, 0.05], [0, 0.0, 0], K.iron),
  P("decor", "torus", [0.05, 0.06, 0.012], [0, 0.44, 0], K.steel2, { a: ["wobble", 4, 0.25] }),
  P("decor", "torus", [0.05, 0.06, 0.012], [0, 0.5, 0], K.steel2, { rot: [0, H, 0], a: ["wobble", 4, 0.3] }),
  P("decor", "torus", [0.05, 0.06, 0.012], [0, 0.56, 0], K.steel2, { a: ["wobble", 4, 0.35] }),
  P("decor", "torus", [0.05, 0.06, 0.012], [0, 0.62, 0], K.steel2, { rot: [0, H, 0], a: ["wobble", 4, 0.4] }),
  P("head", "icosahedron", [0.2, 0.2, 0.2], [0, 0.76, 0], K.iron, { a: ["wobble", 4, 0.3] }),
  P("spike", "cone", [0.04, 0.1, 0.04], [0.12, 0.76, 0], K.steel, { rot: [0, 0, -H], mx: "x" }),
  P("spike", "cone", [0.04, 0.1, 0.04], [0, 0.76, 0.12], K.steel, { rot: [H, 0, 0], mx: "z" }),
  P("spike", "cone", [0.04, 0.1, 0.04], [0, 0.88, 0], K.steel),
], [K.iron, K.wood, K.steel2]);
A("club", "Club", "hammer", "club|cudgel|bat|baseball bat|caveman club|bludgeon", 0.95, [44, 24, 10, 22], [
  P("handle", "cylinder", [0.04, 0.3, 0.04], [0, 0.15, 0], K.leather),
  P("head", "cone", [0.16, 0.65, 0.16], [0, 0.6, 0], K.wood, { rot: [PI, 0, 0] }),
  P("head", "sphere", [0.16, 0.12, 0.16], [0, 0.92, 0], K.wood),
  P("decor", "octahedron", [0.04, 0.04, 0.04], [0.07, 0.75, 0.02], K.wood2),
  P("decor", "octahedron", [0.035, 0.035, 0.035], [-0.06, 0.62, 0.04], K.wood2),
], [K.wood, K.leather, K.wood2]);
A("tetsubo", "Tetsubo", "hammer", "tetsubo|kanabo|oni club|studded club", 1.4, [50, 14, 14, 22], [
  ...shaft(0, 0.45, 0.04, K.black),
  P("head", "prism", [0.13, 0.95, 0.13], [0, 0.9, 0], K.dark),
  P("spike", "sphere", [0.03, 0.03, 0.03], [0.055, 0.7, 0], K.steel2, { mx: "x" }),
  P("spike", "sphere", [0.03, 0.03, 0.03], [0.055, 0.95, 0], K.steel2, { mx: "x" }),
  P("spike", "sphere", [0.03, 0.03, 0.03], [0, 0.82, 0.055], K.steel2, { mx: "z" }),
  P("spike", "sphere", [0.03, 0.03, 0.03], [0, 1.1, 0.055], K.steel2, { mx: "z" }),
  P("pommel", "cylinder", [0.07, 0.04, 0.07], [0, 1.38, 0], K.steel2),
  band(0.45, 0.08, K.steel2, 0.02),
], [K.dark, K.black, K.steel2]);
A("anchor", "Anchor", "hammer", "anchor|ship anchor", 1.3, [52, 12, 16, 20], [
  ...shaft(0, 1.1, 0.06, K.iron),
  P("decor", "torus", [0.18, 0.18, 0.035], [0, 0.0, 0], K.iron),
  P("guard", "box", [0.42, 0.05, 0.05], [0, 0.95, 0], K.iron),
  P("head", "crescent", [0.7, 0.28, 0.06], [0, 1.18, 0], K.iron, { rot: [0, 0, PI] }),
  P("spike", "cone", [0.09, 0.14, 0.05], [0.33, 1.26, 0], K.iron, { mx: "x" }),
], [K.iron, K.dark, K.steel2]);
A("mallet", "Mallet", "hammer", "mallet|gavel|croquet mallet|wooden hammer|tenderiser|tenderizer", 0.8, [42, 26, 10, 22], [
  P("handle", "cylinder", [0.035, 0.6, 0.035], [0, 0.3, 0], K.wood),
  P("head", "cylinder", [0.18, 0.34, 0.18], [0, 0.66, 0], K.wood2, { rot: [0, 0, H] }),
  P("rim", "cylinder", [0.185, 0.03, 0.185], [0.12, 0.66, 0], K.brass, { rot: [0, 0, H], mx: "x" }),
], [K.wood2, K.wood, K.brass]);

// ------------------------------------------------------------------------------------------------ spears & polearms

A("spear", "Spear", "spear", "spear|spears|dory|assegai|polearm", 2.0, [30, 26, 30, 14], [
  ...shaft(0, 1.7, 0.04, K.wood, K.wood2),
  P("decor", "cylinder", [0.05, 0.08, 0.05], [0, 1.72, 0], K.iron),
  P("blade", "octahedron", [0.09, 0.3, 0.03], [0, 1.9, 0], K.steel),
  P("cloth", "cone", [0.08, 0.12, 0.08], [0, 1.64, 0], K.red, { rot: [PI, 0, 0], a: ["wobble", 3, 0.15] }),
  P("pommel", "cone", [0.045, 0.08, 0.045], [0, 0.03, 0], K.iron, { rot: [PI, 0, 0] }),
], [K.steel, K.wood, K.red]);
A("lance", "Lance", "spear", "lance|jousting lance|cavalry lance", 2.3, [36, 18, 32, 14], [
  P("handle", "cylinder", [0.05, 0.3, 0.05], [0, 0.15, 0], K.leather),
  P("guard", "cone", [0.22, 0.25, 0.22], [0, 0.42, 0], K.steel2, { rot: [PI, 0, 0] }),
  P("blade", "cone", [0.12, 1.2, 0.12], [0, 1.15, 0], K.white),
  P("decor", "cone", [0.1, 0.6, 0.1], [0, 1.95, 0], K.red),
  P("blade", "cone", [0.06, 0.12, 0.06], [0, 2.26, 0], K.steel),
  P("cloth", "box", [0.2, 0.12, 0.004], [0.1, 1.35, 0], K.blue, { a: ["wobble", 3, 0.2] }),
], [K.white, K.red, K.steel2]);
A("trident", "Trident", "spear", "trident|trishula|sea fork|fork", 1.95, [32, 24, 28, 16], [
  ...shaft(0, 1.55, 0.04, K.teal, K.dark),
  P("guard", "crescent", [0.3, 0.1, 0.03], [0, 1.6, 0], K.gold, { rot: [0, 0, PI] }),
  P("blade", "cone", [0.04, 0.32, 0.03], [0, 1.78, 0], K.gold),
  P("blade", "cone", [0.035, 0.24, 0.03], [0.13, 1.72, 0], K.gold, { mx: "x" }),
  P("gem", "sphere", [0.05, 0.05, 0.05], [0, 1.58, 0.02], K.teal, glow(K.teal, 0.8)),
], [K.gold, K.teal, K.dark]);
A("halberd", "Halberd", "spear", "halberd|poleaxe|pole axe|bardiche|guandao|voulge", 2.1, [40, 18, 28, 14], [
  ...shaft(0, 1.8, 0.042, K.wood2),
  ...axeBit(1.62, 0.32, 0.18, 0.025, K.steel2),
  P("spike", "cone", [0.04, 0.14, 0.03], [-0.1, 1.68, 0], K.iron, { rot: [0, 0, 1.9] }),
  P("blade", "wedge", [0.05, 0.3, 0.02], [0, 1.95, 0], K.steel),
  band(1.5, 0.06, K.iron, 0.02),
  P("pommel", "cone", [0.04, 0.07, 0.04], [0, 0.03, 0], K.iron, { rot: [PI, 0, 0] }),
], [K.steel, K.wood2, K.iron]);
A("glaive", "Glaive", "spear", "glaive|guisarme|fauchard", 2.0, [38, 22, 26, 14], [
  ...shaft(0, 1.5, 0.04, K.dark, K.crimson),
  P("guard", "box", [0.1, 0.03, 0.04], [0, 1.52, 0], K.gold),
  P("blade", "wedge", [0.12, 0.45, 0.02], [0.02, 1.75, 0], K.steel, { rot: [0, 0, -0.08] }),
  P("spike", "cone", [0.03, 0.08, 0.02], [-0.05, 1.62, 0], K.steel, { rot: [0, 0, 1.2] }),
], [K.steel, K.crimson, K.gold]);
A("naginata", "Naginata", "spear", "naginata|bisento|yari", 2.0, [36, 26, 26, 12], [
  ...shaft(0, 1.45, 0.04, K.black, K.crimson),
  P("guard", "cylinder", [0.08, 0.015, 0.08], [0, 1.47, 0], K.gold),
  P("blade", "crescent", [0.58, 0.12, 0.016], [-0.02, 1.76, 0], K.steel, { rot: [0, 0, -H] }),
  band(1.4, 0.05, K.gold, 0.012),
], [K.steel, K.black, K.crimson]);
A("pike", "Pike", "spear", "pike|sarissa|long spear", 2.6, [30, 20, 40, 10], [
  ...shaft(0, 2.4, 0.035, K.wood),
  P("decor", "cylinder", [0.04, 0.06, 0.04], [0, 2.42, 0], K.iron),
  P("blade", "cone", [0.06, 0.2, 0.04], [0, 2.55, 0], K.steel),
  band(0.9, 0.05, K.iron, 0.015),
], [K.steel, K.wood, K.iron]);
A("harpoon", "Harpoon", "spear", "harpoon|whaling spear|gig", 1.9, [32, 22, 32, 14], [
  ...shaft(0, 1.5, 0.04, K.wood),
  P("blade", "cone", [0.07, 0.3, 0.05], [0, 1.68, 0], K.steel2),
  P("spike", "cone", [0.03, 0.12, 0.02], [0.04, 1.58, 0], K.steel2, { rot: [0, 0, 2.5], mx: "x" }),
  P("ring", "torus", [0.09, 0.09, 0.02], [0, 1.2, 0], K.bone, { rot: [H, 0, 0] }),
  P("cloth", "torus", [0.14, 0.14, 0.02], [0.07, 1.05, 0], K.bone, { rot: [0.3, 0.4, 0], a: ["wobble", 2, 0.2] }),
], [K.steel2, K.wood, K.bone]);

// ------------------------------------------------------------------------------------------------ scythes

A("scythe", "Scythe", "scythe", "scythe|reaper|death scythe", 1.9, [40, 22, 24, 14], [
  ...shaft(0, 1.7, 0.04, K.wood2, K.dark),
  P("handle", "cylinder", [0.03, 0.14, 0.03], [0.06, 0.9, 0], K.wood2, { rot: [0, 0, H] }),
  P("head", "box", [0.07, 0.07, 0.05], [0, 1.7, 0], K.iron),
  P("blade", "crescent", [0.85, 0.3, 0.02], [-0.42, 1.78, 0], K.steel),
], [K.steel, K.dark, K.wood2]);
A("war_scythe", "War Scythe", "scythe", "war scythe|warscythe|double scythe|bone scythe", 2.0, [42, 20, 24, 14], [
  ...shaft(0, 1.75, 0.045, K.black, K.bone),
  P("blade", "crescent", [0.7, 0.26, 0.022], [-0.34, 1.82, 0], K.steel),
  P("blade", "crescent", [0.4, 0.15, 0.02], [0.2, 1.7, 0], K.steel, { rot: [0, 0, PI] }),
  P("decor", "icosahedron", [0.11, 0.11, 0.11], [0, 1.76, 0], K.bone),
  P("gem", "octahedron", [0.04, 0.04, 0.04], [0, 1.76, 0.05], K.purple, glow(K.purple, 1.2)),
], [K.steel, K.bone, K.black]);
A("sickle", "Sickle", "scythe", "sickle|kama|reaping hook|billhook", 0.6, [34, 38, 10, 18], [
  P("handle", "cylinder", [0.035, 0.3, 0.035], [0, 0.15, 0], K.wood),
  P("decor", "cylinder", [0.04, 0.03, 0.04], [0, 0.31, 0], K.iron),
  P("blade", "crescent", [0.36, 0.2, 0.014], [-0.15, 0.4, 0], K.steel, { rot: [0, 0, 0.3] }),
], [K.steel, K.wood, K.iron]);

// ------------------------------------------------------------------------------------------------ whips & chains

{
  const seg = (i: number, c: string): BlueprintPart =>
    P("decor", "capsule", [0.03 - i * 0.003, 0.17, 0.03 - i * 0.003], [0, 0.28 + i * 0.16, 0], c, { a: ["wobble", 5, 0.12 + i * 0.04] });
  A("whip", "Whip", "whip", "whip|whips|lash|bullwhip|cat o nine tails", 1.25, [26, 32, 30, 12], [
    P("handle", "cylinder", [0.04, 0.22, 0.04], [0, 0.11, 0], K.leather2),
    P("pommel", "sphere", [0.05, 0.04, 0.05], [0, 0.0, 0], K.brass),
    seg(0, K.leather), seg(1, K.leather), seg(2, K.leather), seg(3, K.leather), seg(4, K.leather), seg(5, K.leather),
    P("spike", "cone", [0.02, 0.08, 0.02], [0, 1.2, 0], K.leather2, { a: ["wobble", 5, 0.35] }),
  ], [K.leather, K.leather2, K.brass]);
}
{
  const link = (i: number): BlueprintPart =>
    P("ring", "torus", [0.06, 0.08, 0.016], [0, 0.22 + i * 0.075, 0], K.steel2, { rot: [0, i % 2 ? H : 0, 0], a: ["wobble", 4, 0.1 + i * 0.02] });
  A("chain_whip", "Chain Whip", "whip", "chain|chains|chain whip|chain blade", 1.2, [30, 30, 28, 12], [
    P("handle", "cylinder", [0.04, 0.2, 0.04], [0, 0.1, 0], K.dark),
    link(0), link(1), link(2), link(3), link(4), link(5), link(6), link(7), link(8), link(9), link(10), link(11),
    P("blade", "octahedron", [0.07, 0.14, 0.03], [0, 1.15, 0], K.steel, { a: ["wobble", 4, 0.35] }),
  ], [K.steel2, K.dark, K.steel]);
}
A("nunchaku", "Nunchaku", "whip", "nunchaku|nunchucks|nunchuck|nunchuk", 0.75, [28, 40, 12, 20], [
  P("handle", "cylinder", [0.04, 0.3, 0.04], [0, 0.15, 0], K.black),
  P("rim", "cylinder", [0.042, 0.02, 0.042], [0, 0.29, 0], K.gold),
  P("ring", "torus", [0.03, 0.04, 0.01], [0, 0.33, 0], K.steel2, { a: ["wobble", 4, 0.2] }),
  P("ring", "torus", [0.03, 0.04, 0.01], [0, 0.36, 0], K.steel2, { rot: [0, H, 0], a: ["wobble", 4, 0.25] }),
  P("handle", "cylinder", [0.04, 0.3, 0.04], [0, 0.53, 0], K.black, { a: ["wobble", 4, 0.3] }),
  P("rim", "cylinder", [0.042, 0.02, 0.042], [0, 0.39, 0], K.gold, { a: ["wobble", 4, 0.3] }),
], [K.black, K.gold, K.steel2]);
{
  const link = (i: number): BlueprintPart =>
    P("ring", "torus", [0.045, 0.06, 0.012], [0, 0.42 + i * 0.065, 0], K.steel2, { rot: [0, i % 2 ? H : 0, 0], a: ["wobble", 4, 0.1 + i * 0.03] });
  A("kusarigama", "Kusarigama", "whip", "kusarigama|sickle and chain|chain sickle", 1.2, [30, 30, 28, 12], [
    P("handle", "cylinder", [0.035, 0.32, 0.035], [0, 0.16, 0], K.wood),
    P("blade", "crescent", [0.28, 0.12, 0.012], [-0.12, 0.35, 0], K.steel, { rot: [0, 0, 0.2] }),
    link(0), link(1), link(2), link(3), link(4), link(5), link(6), link(7), link(8),
    P("head", "sphere", [0.07, 0.07, 0.07], [0, 1.05, 0], K.iron, { a: ["wobble", 4, 0.35] }),
  ], [K.steel, K.wood, K.iron]);
}

// ------------------------------------------------------------------------------------------------ fist weapons

A("gauntlet", "Gauntlet", "fist", "gauntlet|gauntlets|glove|gloves|fist|fists|punch", 0.34, [36, 32, 6, 26], [
  P("handle", "cylinder", [0.11, 0.12, 0.1], [0, 0.0, 0], K.steel2),
  P("rim", "torus", [0.12, 0.12, 0.02], [0, -0.06, 0], K.brass, { rot: [H, 0, 0] }),
  P("body", "box", [0.12, 0.11, 0.09], [0, 0.11, 0], K.steel),
  P("head", "box", [0.13, 0.05, 0.1], [0, 0.18, 0.005], K.steel2),
  P("spike", "cone", [0.025, 0.05, 0.025], [0.04, 0.22, 0.01], K.steel, { mx: "x" }),
  P("decor", "box", [0.04, 0.07, 0.06], [0.07, 0.1, 0.02], K.steel2, { rot: [0, 0, -0.3] }),
  P("gem", "octahedron", [0.035, 0.035, 0.02], [0, 0.11, 0.05], K.red),
], [K.steel, K.steel2, K.brass]);
A("claws", "Claws", "fist", "claw|claws|talons|wolverine|bagh nakh|tiger claws", 0.5, [32, 42, 6, 20], [
  P("handle", "box", [0.11, 0.09, 0.07], [0, 0.0, 0], K.leather2),
  P("guard", "box", [0.13, 0.03, 0.05], [0, 0.06, 0], K.iron),
  P("blade", "wedge", [0.022, 0.36, 0.008], [0, 0.25, 0], K.steel),
  P("blade", "wedge", [0.022, 0.32, 0.008], [0.045, 0.23, 0], K.steel, { rot: [0, 0, -0.06], mx: "x" }),
], [K.steel, K.leather2, K.iron]);
A("brass_knuckles", "Brass Knuckles", "fist", "knuckles|brass knuckles|knuckle duster|knuckledusters|cestus", 0.22, [34, 40, 4, 22], [
  P("handle", "capsule", [0.035, 0.13, 0.03], [0, -0.03, -0.01], K.brass, { rot: [0, 0, H] }),
  P("ring", "torus", [0.045, 0.045, 0.014], [0.0225, 0.02, 0], K.brass, { mx: "x" }),
  P("ring", "torus", [0.045, 0.045, 0.014], [0.0675, 0.02, 0], K.brass, { mx: "x" }),
  P("spike", "cone", [0.02, 0.03, 0.02], [0.0225, 0.055, 0], K.brass, { mx: "x" }),
  P("spike", "cone", [0.02, 0.03, 0.02], [0.0675, 0.055, 0], K.brass, { mx: "x" }),
], [K.brass, K.gold, K.bronze]);
A("katar", "Katar", "fist", "katar|punch dagger|push dagger", 0.5, [30, 40, 6, 24], [
  P("handle", "cylinder", [0.03, 0.1, 0.03], [0, 0.0, 0], K.gold, { rot: [0, 0, H] }),
  P("guard", "box", [0.015, 0.2, 0.025], [0.06, 0.04, 0], K.gold, { mx: "x" }),
  P("guard", "box", [0.13, 0.025, 0.03], [0, 0.14, 0], K.gold),
  P("blade", "wedge", [0.07, 0.32, 0.014], [0, 0.31, 0], K.steel),
  P("rune", "box", [0.008, 0.2, 0.016], [0, 0.26, 0], K.gold),
], [K.steel, K.gold, K.crimson]);
A("power_fist", "Power Fist", "fist", "power fist|powerfist|rocket fist|mech fist|robot fist|power glove", 0.42, [40, 24, 8, 28], [
  P("handle", "cylinder", [0.14, 0.16, 0.14], [0, 0.0, 0], K.dark),
  P("body", "box", [0.17, 0.14, 0.13], [0, 0.15, 0], K.yellow),
  P("head", "box", [0.18, 0.06, 0.12], [0, 0.25, 0], K.dark),
  P("barrel", "cylinder", [0.04, 0.12, 0.04], [0.11, 0.02, 0], K.steel2, { mx: "x" }),
  P("rune", "box", [0.12, 0.02, 0.005], [0, 0.15, 0.067], K.cyan, glow(K.cyan, 1.4)),
  P("decor", "torus", [0.15, 0.15, 0.02], [0, -0.07, 0], K.steel2, { rot: [H, 0, 0] }),
], [K.yellow, K.dark, K.cyan]);

// ------------------------------------------------------------------------------------------------ bows (grip at origin, limbs on X, arrow +Y)

function bow(span: number, bulge: number, t: number, c: string, gripC: string, stringC: string = K.white): BlueprintPart[] {
  const cy = -bulge * 0.3; // crescent centre: its thick middle lands on the grip
  const tips = cy - bulge / 2;
  return [
    P("limb", "crescent", [span, bulge, t], [0, cy, 0], c),
    P("handle", "box", [0.05, 0.06, t * 1.3], [0, cy + bulge * 0.3, 0], gripC),
    P("string", "box", [span * 0.94, 0.006, 0.006], [0, tips + 0.01, 0], stringC),
    // nocked arrow
    P("decor", "cylinder", [0.012, span * 0.55, 0.012], [0, tips + span * 0.275, t * 0.9], K.wood),
    P("blade", "cone", [0.03, 0.07, 0.012], [0, tips + span * 0.55 + 0.03, t * 0.9], K.steel),
    P("decor", "wedge", [0.03, 0.06, 0.004], [0.015, tips + 0.05, t * 0.9], K.red, { mx: "x" }),
  ];
}
A("shortbow", "Shortbow", "bow", "bow|bows|shortbow|short bow|hunting bow", 1.0, [24, 30, 36, 10],
  bow(0.95, 0.24, 0.035, K.wood, K.leather), [K.wood, K.leather, K.white]);
A("longbow", "Longbow", "bow", "longbow|long bow|war bow|yew bow|elven bow", 1.55, [30, 18, 42, 10],
  [...bow(1.5, 0.3, 0.035, K.wood2, K.green), band(-0.02, 0.06, K.gold, 0.012, { rot: [0, 0, H] })], [K.wood2, K.green, K.gold]);
A("recurve_bow", "Recurve Bow", "bow", "recurve|recurve bow|horse bow|composite bow|horn bow", 1.15, [28, 26, 36, 10], [
  ...bow(1.0, 0.26, 0.035, K.crimson, K.black),
  P("limb", "crescent", [0.2, 0.08, 0.035], [0.52, -0.1, 0], K.bone, { rot: [0, 0, -2.2], mx: "x" }),
], [K.crimson, K.black, K.bone]);
A("compound_bow", "Compound Bow", "bow", "compound bow|compound|modern bow|cam bow", 1.1, [30, 24, 38, 8], [
  ...bow(0.95, 0.2, 0.04, K.dark, K.black, K.steel2),
  P("ring", "cylinder", [0.08, 0.025, 0.08], [0.46, -0.13, 0], K.steel2, { rot: [H, 0, 0], mx: "x", a: ["spin", 1, 0] }),
  P("decor", "box", [0.04, 0.03, 0.03], [0, 0.05, 0.05], K.orange),
], [K.dark, K.steel2, K.orange]);

// ------------------------------------------------------------------------------------------------ crossbows

function crossbowBody(len: number, span: number, wood: string, limb: string): BlueprintPart[] {
  return [
    P("stock", "box", [0.05, len, 0.06], [0, len / 2 - 0.16, 0], wood),
    P("handle", "box", [0.035, 0.045, 0.1], [0, -0.01, -0.06], wood, { rot: [-0.3, 0, 0] }),
    P("limb", "crescent", [span, 0.12, 0.03], [0, len - 0.24, 0.01], limb),
    P("string", "box", [0.006, span * 0.55, 0.006], [span * 0.24, len - 0.38, 0.02], K.white, { rot: [0, 0, 1.05], mx: "x" }),
    P("decor", "cylinder", [0.014, len * 0.62, 0.014], [0, len * 0.47 - 0.14, 0.04], K.wood2),
    P("blade", "cone", [0.03, 0.06, 0.014], [0, len * 0.78 - 0.11, 0.04], K.steel),
  ];
}
A("crossbow", "Crossbow", "crossbow", "crossbow|crossbows|xbow", 0.85, [32, 20, 36, 12],
  [...crossbowBody(0.75, 0.62, K.wood, K.steel2), P("ring", "torus", [0.08, 0.08, 0.014], [0, 0.62, 0], K.iron)], [K.wood, K.steel2, K.iron]);
A("repeater", "Repeating Crossbow", "crossbow", "repeater|repeating crossbow|chu-ko-nu|chu ko nu|auto crossbow", 0.85, [26, 32, 34, 8], [
  ...crossbowBody(0.72, 0.56, K.wood2, K.crimson),
  P("body", "box", [0.06, 0.24, 0.1], [0, 0.22, 0.1], K.wood2),
  P("decor", "box", [0.065, 0.02, 0.11], [0, 0.32, 0.1], K.gold),
], [K.wood2, K.crimson, K.gold]);
A("arbalest", "Arbalest", "crossbow", "arbalest|arbalist|heavy crossbow|siege crossbow|ballista", 1.0, [40, 12, 38, 10], [
  ...crossbowBody(0.9, 0.78, K.dark, K.steel),
  P("ring", "cylinder", [0.08, 0.06, 0.08], [0, -0.1, 0.0], K.iron, { rot: [0, 0, H] }),
  P("decor", "box", [0.08, 0.05, 0.04], [0, 0.7, 0.03], K.iron),
], [K.steel, K.dark, K.iron]);
A("hand_crossbow", "Hand Crossbow", "crossbow", "hand crossbow|pistol crossbow|wrist crossbow", 0.45, [24, 38, 28, 10], [
  ...pistolGrip(K.dark),
  P("stock", "box", [0.035, 0.32, 0.04], [0, 0.12, 0.03], K.dark),
  P("limb", "crescent", [0.36, 0.08, 0.02], [0, 0.24, 0.04], K.steel2),
  P("string", "box", [0.34, 0.005, 0.005], [0, 0.2, 0.05], K.white),
  P("decor", "cylinder", [0.01, 0.22, 0.01], [0, 0.22, 0.06], K.wood),
  P("blade", "cone", [0.022, 0.04, 0.01], [0, 0.35, 0.06], K.steel),
], [K.dark, K.steel2, K.wood]);

// ------------------------------------------------------------------------------------------------ guns (handle at the origin hanging -Z, barrel +Y)

A("pistol", "Pistol", "gun", "gun|guns|pistol|handgun|sidearm|glock|deagle", 0.35, [26, 34, 32, 8], [
  ...pistolGrip(K.dark),
  P("body", "box", [0.035, 0.22, 0.05], [0, 0.08, 0.025], K.dark),
  P("barrel", "box", [0.03, 0.2, 0.028], [0, 0.11, 0.06], K.steel2),
  P("decor", "box", [0.008, 0.012, 0.012], [0, 0.2, 0.08], K.orange),
], [K.dark, K.steel2, K.orange]);
A("revolver", "Revolver", "gun", "revolver|six-shooter|six shooter|magnum|colt", 0.42, [30, 26, 32, 12], [
  ...pistolGrip(K.wood2),
  P("body", "box", [0.035, 0.08, 0.06], [0, 0.05, 0.02], K.steel2),
  P("ring", "cylinder", [0.06, 0.07, 0.06], [0, 0.09, 0.035], K.steel2, { a: ["spin", 0.6, 0] }),
  P("barrel", "cylinder", [0.026, 0.24, 0.026], [0, 0.24, 0.05], K.steel),
  P("decor", "box", [0.01, 0.03, 0.02], [0, 0.0, 0.065], K.steel2, { rot: [0.5, 0, 0] }),
  P("decor", "box", [0.006, 0.012, 0.014], [0, 0.35, 0.068], K.steel2),
], [K.steel2, K.wood2, K.steel]);
A("rifle", "Rifle", "gun", "rifle|rifles|musket|carbine|long gun|hunting rifle", 1.1, [32, 20, 40, 8], [
  ...pistolGrip(K.wood),
  P("stock", "box", [0.04, 0.32, 0.08], [0, -0.18, -0.03], K.wood, { rot: [0.15, 0, 0] }),
  P("body", "box", [0.04, 0.3, 0.05], [0, 0.1, 0.03], K.dark),
  P("barrel", "cylinder", [0.024, 0.5, 0.024], [0, 0.5, 0.045], K.steel2),
  P("stock", "box", [0.036, 0.4, 0.035], [0, 0.42, 0.012], K.wood),
  P("decor", "cylinder", [0.03, 0.16, 0.03], [0, 0.12, 0.085], K.black),
], [K.wood, K.dark, K.steel2]);
A("shotgun", "Shotgun", "gun", "shotgun|scattergun|boomstick|double barrel", 0.95, [40, 18, 22, 20], [
  ...pistolGrip(K.wood2),
  P("stock", "box", [0.045, 0.3, 0.09], [0, -0.17, -0.035], K.wood2, { rot: [0.15, 0, 0] }),
  P("body", "box", [0.05, 0.2, 0.06], [0, 0.07, 0.03], K.dark),
  P("barrel", "cylinder", [0.03, 0.5, 0.03], [0.016, 0.42, 0.05], K.steel2, { mx: "x" }),
  P("stock", "box", [0.05, 0.18, 0.04], [0, 0.3, 0.015], K.wood2),
], [K.steel2, K.wood2, K.dark]);
A("blunderbuss", "Blunderbuss", "gun", "blunderbuss|hand cannon pistol|dragon gun|bell gun", 0.85, [42, 16, 20, 22], [
  ...pistolGrip(K.wood),
  P("stock", "box", [0.04, 0.24, 0.08], [0, -0.14, -0.035], K.wood, { rot: [0.25, 0, 0] }),
  P("barrel", "cylinder", [0.045, 0.45, 0.045], [0, 0.26, 0.04], K.brass),
  P("barrel", "cone", [0.13, 0.14, 0.13], [0, 0.5, 0.04], K.brass, { rot: [PI, 0, 0] }),
  band(0.15, 0.055, K.bronze, 0.012),
], [K.brass, K.wood, K.bronze]);
A("flintlock", "Flintlock", "gun", "flintlock|flintlock pistol|pirate pistol|dueling pistol", 0.45, [30, 26, 28, 16], [
  P("handle", "box", [0.036, 0.05, 0.1], [0, -0.03, -0.045], K.wood2, { rot: [-0.7, 0, 0] }),
  P("pommel", "sphere", [0.045, 0.04, 0.045], [0, -0.07, -0.09], K.brass),
  P("body", "box", [0.035, 0.12, 0.04], [0, 0.04, 0.02], K.wood2),
  P("barrel", "cylinder", [0.026, 0.3, 0.026], [0, 0.24, 0.035], K.brass),
  P("decor", "box", [0.012, 0.03, 0.03], [0.02, 0.01, 0.05], K.steel2, { rot: [0.4, 0, 0] }),
  P("guard", "torus", [0.045, 0.04, 0.007], [0, 0.03, -0.015], K.brass, { rot: [0, H, 0] }),
], [K.wood2, K.brass, K.steel2]);
A("sniper_rifle", "Sniper Rifle", "gun", "sniper|sniper rifle|marksman rifle|railgun|rail gun", 1.3, [40, 10, 46, 4], [
  ...pistolGrip(K.dark),
  P("stock", "box", [0.04, 0.32, 0.09], [0, -0.18, -0.02], K.dark),
  P("body", "box", [0.045, 0.36, 0.055], [0, 0.14, 0.025], K.green),
  P("barrel", "cylinder", [0.022, 0.62, 0.022], [0, 0.62, 0.04], K.black),
  P("decor", "cylinder", [0.04, 0.24, 0.04], [0, 0.12, 0.1], K.black),
  P("gem", "cylinder", [0.035, 0.005, 0.035], [0, 0.245, 0.1], K.cyan, glow(K.cyan, 1.2)),
  P("limb", "box", [0.008, 0.12, 0.008], [0.025, 0.86, -0.03], K.black, { rot: [0.5, 0, 0], mx: "x" }),
], [K.green, K.black, K.cyan]);
A("blaster", "Blaster", "gun", "blaster|ray gun|raygun|laser|laser gun|phaser|plasma gun|zapper", 0.45, [28, 30, 30, 12], [
  ...pistolGrip(K.white),
  P("body", "capsule", [0.06, 0.2, 0.06], [0, 0.08, 0.04], K.white),
  P("ring", "torus", [0.09, 0.09, 0.015], [0, 0.12, 0.04], K.red, { rot: [H, 0, 0] }),
  P("ring", "torus", [0.075, 0.075, 0.015], [0, 0.17, 0.04], K.red, { rot: [H, 0, 0] }),
  P("barrel", "cone", [0.04, 0.12, 0.04], [0, 0.23, 0.04], K.steel2),
  P("orb", "sphere", [0.03, 0.03, 0.03], [0, 0.3, 0.04], K.cyan, { ...glow(K.cyan, 2), a: ["pulse", 5, 0.3] }),
  P("decor", "wedge", [0.05, 0.08, 0.008], [0, 0.03, 0.09], K.red),
], [K.white, K.red, K.cyan]);

// ------------------------------------------------------------------------------------------------ cannons & launchers

A("hand_cannon", "Hand Cannon", "cannon", "cannon|cannons|hand cannon|handcannon|bombard", 1.0, [46, 10, 30, 14], [
  ...pistolGrip(K.wood2, 0.14),
  P("barrel", "cylinder", [0.14, 0.7, 0.14], [0, 0.35, 0.09], K.dark),
  P("rim", "cylinder", [0.18, 0.06, 0.18], [0, 0.68, 0.09], K.brass),
  band(0.2, 0.16, K.brass, 0.025, { rot: [H, 0, 0] }),
  P("pommel", "sphere", [0.12, 0.12, 0.12], [0, 0.0, 0.09], K.dark),
  P("decor", "cylinder", [0.015, 0.05, 0.015], [0, 0.04, 0.17], K.orange, glow(K.orange, 1.5)),
], [K.dark, K.brass, K.wood2]);
A("rocket_launcher", "Rocket Launcher", "cannon", "rocket launcher|rocket|launcher|bazooka|rpg|missile launcher", 1.2, [50, 8, 34, 8], [
  ...pistolGrip(K.dark),
  P("barrel", "cylinder", [0.13, 1.0, 0.13], [0, 0.2, 0.09], K.green),
  band(-0.25, 0.14, K.dark, 0.02), band(0.6, 0.14, K.dark, 0.02),
  P("head", "cone", [0.1, 0.18, 0.1], [0, 0.78, 0.09], K.red),
  P("decor", "box", [0.04, 0.08, 0.06], [0.0, 0.2, 0.18], K.dark),
  P("decor", "box", [0.03, 0.06, 0.06], [0, 0.0, -0.07], K.dark),
  P("limb", "wedge", [0.08, 0.06, 0.006], [0.04, 0.65, 0.09], K.red, { mx: "x" }),
], [K.green, K.dark, K.red]);
A("grenade_launcher", "Grenade Launcher", "cannon", "grenade launcher|grenade|bomb launcher|mortar|noob tube", 0.85, [44, 14, 28, 14], [
  ...pistolGrip(K.dark),
  P("stock", "box", [0.04, 0.24, 0.07], [0, -0.15, -0.02], K.dark),
  P("ring", "cylinder", [0.17, 0.12, 0.17], [0, 0.12, 0.08], K.orange, { a: ["spin", 0.5, 0] }),
  P("barrel", "cylinder", [0.08, 0.4, 0.08], [0, 0.38, 0.08], K.dark),
  P("rim", "cylinder", [0.095, 0.03, 0.095], [0, 0.58, 0.08], K.steel2),
], [K.dark, K.orange, K.steel2]);
A("gatling", "Gatling Gun", "cannon", "gatling|gatling gun|minigun|chaingun|chain gun|machine gun", 1.0, [38, 26, 28, 8], [
  ...pistolGrip(K.dark),
  P("body", "box", [0.14, 0.24, 0.14], [0, 0.06, 0.09], K.dark),
  P("barrel", "cylinder", [0.03, 0.62, 0.03], [0.035, 0.48, 0.09], K.steel2, { mx: "x", a: ["spin", 6, 0] }),
  P("barrel", "cylinder", [0.03, 0.62, 0.03], [0, 0.48, 0.125], K.steel2, { mx: "z", a: ["spin", 6, 0] }),
  P("rim", "cylinder", [0.12, 0.03, 0.12], [0, 0.75, 0.09], K.steel2),
  P("rim", "cylinder", [0.12, 0.03, 0.12], [0, 0.32, 0.09], K.steel2),
  P("decor", "box", [0.08, 0.1, 0.12], [0.1, 0.02, 0.06], K.brass),
], [K.dark, K.steel2, K.brass]);
A("flamethrower", "Flamethrower", "cannon", "flamethrower|flame thrower|flamer|torch gun", 0.95, [36, 22, 22, 20], [
  ...pistolGrip(K.dark),
  P("barrel", "cylinder", [0.05, 0.6, 0.05], [0, 0.32, 0.06], K.steel2),
  P("body", "capsule", [0.11, 0.32, 0.11], [0, 0.12, -0.04], K.red),
  P("rim", "cone", [0.09, 0.08, 0.09], [0, 0.64, 0.06], K.dark, { rot: [PI, 0, 0] }),
  P("orb", "sphere", [0.035, 0.035, 0.035], [0, 0.69, 0.06], K.orange, { ...glow(K.orange, 2.2), a: ["flicker", 9, 0.4] }),
], [K.red, K.steel2, K.orange], { particles: { kind: "embers", color: K.orange, rate: 14 } });

// ------------------------------------------------------------------------------------------------ thrown

A("chakram", "Chakram", "thrown", "chakram|chakrams|war quoit|ring blade|throwing ring", 0.45, [30, 36, 26, 8], [
  P("blade", "torus", [0.42, 0.42, 0.035], [0, 0.21, 0], K.steel, { a: ["spin", 3, 0] }),
  P("rim", "torus", [0.34, 0.34, 0.02], [0, 0.21, 0], K.gold, { a: ["spin", 3, 0] }),
  P("spike", "cone", [0.04, 0.08, 0.012], [0.23, 0.21, 0], K.steel, { rot: [0, 0, -H], mx: "x" }),
  P("spike", "cone", [0.04, 0.08, 0.012], [0, 0.44, 0], K.steel),
  P("handle", "box", [0.05, 0.03, 0.025], [0, 0.03, 0], K.leather),
], [K.steel, K.gold, K.leather]);
{
  A("shuriken", "Shuriken", "thrown", "shuriken|throwing star|ninja star|star", 0.26, [24, 44, 24, 8], [
    P("handle", "cylinder", [0.06, 0.012, 0.06], [0, 0.12, 0], K.dark, { rot: [H, 0, 0], a: ["spin", 4, 0] }),
    P("blade", "octahedron", [0.26, 0.05, 0.01], [0, 0.12, 0], K.steel2, { a: ["spin", 4, 0] }),
    P("blade", "octahedron", [0.05, 0.26, 0.01], [0, 0.12, 0], K.steel2, { a: ["spin", 4, 0] }),
    P("blade", "octahedron", [0.16, 0.035, 0.012], [0, 0.12, 0], K.steel, { rot: [0, 0, PI / 4], mx: "x", a: ["spin", 4, 0] }),
    P("gem", "torus", [0.03, 0.03, 0.014], [0, 0.12, 0], K.red),
  ], [K.steel2, K.dark, K.red]);
}
A("boomerang", "Boomerang", "thrown", "boomerang|kylie|throwing stick", 0.55, [26, 32, 30, 12], [
  P("limb", "box", [0.06, 0.32, 0.018], [0.07, 0.14, 0], K.wood, { rot: [0, 0, -0.7] }),
  P("limb", "box", [0.06, 0.32, 0.018], [-0.07, 0.14, 0], K.wood, { rot: [0, 0, 0.7] }),
  P("decor", "box", [0.02, 0.28, 0.02], [0.07, 0.14, 0], K.red, { rot: [0, 0, -0.7] }),
  P("decor", "box", [0.02, 0.28, 0.02], [-0.07, 0.14, 0], K.yellow, { rot: [0, 0, 0.7] }),
  P("handle", "sphere", [0.07, 0.06, 0.02], [0, 0.03, 0], K.wood2),
], [K.wood, K.red, K.yellow]);
A("javelin", "Javelin", "thrown", "javelin|javelins|pilum|throwing spear|dart", 1.4, [32, 24, 34, 10], [
  P("handle", "cylinder", [0.028, 1.15, 0.028], [0, 0.575, 0], K.wood),
  band(0.45, 0.04, K.leather, 0.015),
  P("decor", "cylinder", [0.02, 0.15, 0.02], [0, 1.22, 0], K.iron),
  P("blade", "cone", [0.05, 0.12, 0.05], [0, 1.35, 0], K.steel),
  P("decor", "wedge", [0.04, 0.1, 0.004], [0.02, 0.06, 0], K.red, { mx: "x" }),
], [K.wood, K.steel, K.red]);
A("throwing_axe", "Throwing Axe", "thrown", "throwing axe|throwing axes|francisca|tomahawks", 0.5, [32, 30, 26, 12], [
  P("handle", "cylinder", [0.03, 0.42, 0.03], [0, 0.21, 0], K.wood),
  ...axeBit(0.4, 0.15, 0.1, 0.02, K.steel2),
  P("spike", "cone", [0.03, 0.07, 0.02], [-0.04, 0.4, 0], K.iron, { rot: [0, 0, H] }),
  band(0.05, 0.04, K.red, 0.012),
  P("cloth", "box", [0.02, 0.09, 0.004], [0.02, 0.02, 0], K.red, { a: ["wobble", 4, 0.25] }),
], [K.steel, K.wood, K.red]);
A("sling", "Sling", "thrown", "sling|slingshot|catapult|slinger", 0.5, [26, 32, 32, 10], [
  P("handle", "cylinder", [0.03, 0.18, 0.03], [0, 0.09, 0], K.wood),
  P("limb", "cylinder", [0.025, 0.16, 0.025], [0.05, 0.24, 0], K.wood, { rot: [0, 0, -0.4], mx: "x" }),
  P("string", "box", [0.006, 0.18, 0.006], [0.05, 0.36, 0.0], K.leather2, { rot: [0, 0, 0.35], mx: "x" }),
  P("cloth", "box", [0.05, 0.03, 0.01], [0, 0.44, 0.0], K.leather, { a: ["wobble", 3, 0.2] }),
  P("orb", "sphere", [0.035, 0.035, 0.035], [0, 0.45, 0.01], K.stone),
], [K.wood, K.leather, K.stone]);

// ------------------------------------------------------------------------------------------------ staffs (bottom at y = 0)

A("wizard_staff", "Wizard Staff", "staff", "staff|staves|wizard staff|mage staff|magic staff", 1.5, [26, 22, 26, 26], [
  ...shaft(0, 1.3, 0.04, K.wood2, K.wood),
  P("head", "cone", [0.06, 0.16, 0.06], [0, 1.32, 0], K.gold, { rot: [PI, 0, 0] }),
  P("spike", "crescent", [0.13, 0.12, 0.02], [0.07, 1.42, 0], K.gold, { rot: [0, 0, -0.9], mx: "x" }),
  P("orb", "sphere", [0.13, 0.13, 0.13], [0, 1.43, 0], K.blue, { ...glow(K.cyan, 1.4), a: ["float", 2, 0.04] }),
  band(0.9, 0.055, K.gold, 0.012),
], [K.wood2, K.gold, K.blue], { particles: { kind: "motes", color: K.cyan, rate: 6 } });
A("crystal_staff", "Crystal Staff", "staff", "crystal staff|crystal|gem staff|prism staff", 1.5, [24, 22, 26, 28], [
  ...shaft(0, 1.25, 0.04, K.white, K.navy),
  P("head", "torus", [0.18, 0.18, 0.025], [0, 1.38, 0], K.steel2),
  P("shard", "octahedron", [0.1, 0.26, 0.1], [0, 1.4, 0], K.cyan, { ...glow(K.cyan, 1.6), a: ["spin", 1.2, 0] }),
  P("shard", "octahedron", [0.04, 0.09, 0.04], [0.15, 1.4, 0], K.cyan, { ...glow(K.cyan, 1.2), a: ["orbit", 2, 0.16] }),
  P("shard", "octahedron", [0.04, 0.09, 0.04], [-0.15, 1.45, 0], K.purple, { ...glow(K.purple, 1.2), a: ["orbit", 2.4, 0.15] }),
], [K.cyan, K.navy, K.white], { particles: { kind: "motes", color: K.cyan, rate: 8 } });
A("druid_staff", "Druid Staff", "staff", "druid staff|druid|nature staff|branch|living wood|gnarled staff", 1.5, [24, 22, 24, 30], [
  P("handle", "cylinder", [0.045, 0.7, 0.045], [0, 0.35, 0], K.wood2),
  P("handle", "cylinder", [0.04, 0.6, 0.04], [0.03, 0.98, 0], K.wood2, { rot: [0, 0, -0.1] }),
  P("limb", "cylinder", [0.03, 0.3, 0.03], [0.1, 1.34, 0], K.wood2, { rot: [0, 0, -0.6] }),
  P("limb", "cylinder", [0.03, 0.28, 0.03], [-0.04, 1.35, 0], K.wood2, { rot: [0, 0, 0.5] }),
  P("orb", "icosahedron", [0.12, 0.12, 0.12], [0.03, 1.38, 0], K.green, { ...glow(K.green, 1.2), a: ["pulse", 2, 0.12] }),
  P("cloth", "octahedron", [0.09, 0.05, 0.02], [0.18, 1.45, 0], K.moss, { rot: [0, 0, 0.6], a: ["wobble", 2, 0.2] }),
  P("cloth", "octahedron", [0.08, 0.045, 0.02], [-0.12, 1.47, 0.02], K.moss, { rot: [0, 0, -0.5], a: ["wobble", 2.4, 0.2] }),
], [K.wood2, K.green, K.moss], { particles: { kind: "motes", color: K.green, rate: 5 } });
A("bo_staff", "Bo Staff", "staff", "bo staff|bo|quarterstaff|quarter staff|jo staff|fighting stick|walking stick|cane", 1.6, [30, 32, 26, 12], [
  ...shaft(0, 1.6, 0.04, K.wood),
  P("rim", "cylinder", [0.046, 0.08, 0.046], [0, 0.04, 0], K.brass),
  P("rim", "cylinder", [0.046, 0.08, 0.046], [0, 1.56, 0], K.brass),
  band(0.7, 0.05, K.red, 0.015), band(0.9, 0.05, K.red, 0.015),
], [K.wood, K.brass, K.red]);
A("rod", "Rod", "staff", "rod|rods|iron rod|lightning rod|sceptre rod", 0.85, [28, 26, 22, 24], [
  P("handle", "cylinder", [0.035, 0.6, 0.035], [0, 0.3, 0], K.steel2),
  P("pommel", "octahedron", [0.05, 0.06, 0.05], [0, 0.0, 0], K.steel2),
  P("head", "cylinder", [0.06, 0.12, 0.06], [0, 0.66, 0], K.copper),
  P("blade", "box", [0.11, 0.1, 0.012], [0, 0.68, 0], K.copper, { mx: "z", rot: [0, PI / 4, 0] }),
  P("spike", "cone", [0.03, 0.12, 0.03], [0, 0.78, 0], K.copper),
  band(0.45, 0.05, K.copper, 0.012), band(0.25, 0.05, K.copper, 0.012),
], [K.copper, K.steel2, K.yellow]);
A("scepter", "Scepter", "staff", "scepter|sceptre|royal scepter|regalia", 0.85, [24, 24, 22, 30], [
  P("handle", "cylinder", [0.035, 0.6, 0.035], [0, 0.3, 0], K.gold),
  P("pommel", "sphere", [0.05, 0.05, 0.05], [0, 0.0, 0], K.gold),
  band(0.2, 0.05, K.purple, 0.014), band(0.4, 0.05, K.purple, 0.014),
  P("head", "cone", [0.12, 0.12, 0.12], [0, 0.66, 0], K.gold, { rot: [PI, 0, 0] }),
  P("spike", "cone", [0.025, 0.07, 0.025], [0.05, 0.75, 0], K.gold, { mx: "x" }),
  P("spike", "cone", [0.025, 0.07, 0.025], [0, 0.75, 0.05], K.gold, { mx: "z" }),
  P("gem", "octahedron", [0.08, 0.1, 0.08], [0, 0.77, 0], K.red, { ...glow(K.red, 1.1), a: ["pulse", 2, 0.1] }),
], [K.gold, K.purple, K.red]);

// ------------------------------------------------------------------------------------------------ foci (catalysts)

A("wand", "Wand", "focus", "wand|wands|magic wand|fairy wand", 0.42, [22, 34, 22, 22], [
  P("handle", "cylinder", [0.03, 0.12, 0.03], [0, 0.06, 0], K.wood2),
  band(0.12, 0.035, K.gold, 0.008),
  P("handle", "cone", [0.024, 0.26, 0.024], [0, 0.26, 0], K.wood, { rot: [0, 0, 0] }),
  P("gem", "octahedron", [0.05, 0.06, 0.05], [0, 0.4, 0], K.pink, { ...glow(K.pink, 1.6), a: ["spin", 2, 0] }),
], [K.wood, K.gold, K.pink], { particles: { kind: "motes", color: K.pink, rate: 8 } });
A("orb", "Orb", "focus", "orb|orbs|sphere|globe|crystal ball|focus|seeing stone", 0.35, [22, 22, 26, 30], [
  P("handle", "cylinder", [0.04, 0.1, 0.04], [0, 0.05, 0], K.gold),
  P("head", "crescent", [0.16, 0.08, 0.03], [0, 0.14, 0], K.gold, { rot: [0, 0, PI] }),
  P("head", "crescent", [0.16, 0.08, 0.03], [0, 0.14, 0], K.gold, { rot: [0, H, PI] }),
  P("orb", "sphere", [0.16, 0.16, 0.16], [0, 0.25, 0], K.purple, { ...glow(K.purple, 1.4), a: ["float", 2, 0.03] }),
  P("ring", "torus", [0.24, 0.24, 0.012], [0, 0.25, 0], K.gold, { rot: [1.1, 0, 0.3], a: ["spin", 1.5, 0] }),
], [K.purple, K.gold, K.pink], { particles: { kind: "motes", color: K.purple, rate: 6 } });
A("tome", "Tome", "focus", "tome|tomes|book|books|spellbook|spell book|codex|bible|scroll", 0.36, [20, 22, 26, 32], [
  P("handle", "box", [0.03, 0.04, 0.03], [0, 0.0, 0], K.leather2),
  P("body", "box", [0.24, 0.3, 0.07], [0, 0.17, 0], K.red),
  P("decor", "box", [0.22, 0.28, 0.055], [0.012, 0.17, 0], K.bone),
  P("rim", "box", [0.03, 0.3, 0.075], [-0.12, 0.17, 0], K.crimson),
  P("decor", "box", [0.04, 0.05, 0.075], [0.11, 0.17, 0], K.gold),
  P("rune", "octahedron", [0.08, 0.1, 0.01], [0, 0.18, 0.04], K.gold, glow(K.yellow, 0.8)),
  P("rune", "torus", [0.06, 0.06, 0.008], [0, 0.42, 0], K.yellow, { ...glow(K.yellow, 1.6), a: ["float", 2, 0.03] }),
], [K.red, K.gold, K.bone]);
A("grimoire", "Grimoire", "focus", "grimoire|necronomicon|dark book|forbidden tome|book of shadows", 0.4, [24, 20, 24, 32], [
  P("handle", "box", [0.03, 0.04, 0.03], [0, 0.0, 0], K.dark),
  P("body", "box", [0.26, 0.32, 0.08], [0, 0.18, 0], K.black),
  P("decor", "box", [0.24, 0.3, 0.06], [0.012, 0.18, 0], K.bone),
  P("spike", "cone", [0.03, 0.05, 0.03], [0.12, 0.33, 0.04], K.steel2, { rot: [0, 0, -0.8], mx: "x" }),
  P("decor", "box", [0.27, 0.025, 0.09], [0, 0.12, 0], K.steel2),
  P("gem", "sphere", [0.07, 0.07, 0.03], [0, 0.2, 0.045], K.purple, { ...glow(K.purple, 1.8), a: ["pulse", 3, 0.2] }),
  P("rune", "octahedron", [0.04, 0.06, 0.01], [0.1, 0.44, 0], K.purple, { ...glow(K.purple, 1.5), a: ["orbit", 1.5, 0.15] }),
], [K.black, K.purple, K.steel2], { particles: { kind: "smoke", color: K.purple, rate: 5 } });
A("lantern", "Lantern", "focus", "lantern|lamp|lantern of|candle|torch", 0.42, [22, 24, 24, 30], [
  P("handle", "torus", [0.1, 0.1, 0.012], [0, 0.04, 0], K.dark),
  P("head", "cone", [0.16, 0.06, 0.16], [0, 0.1, 0], K.dark, { rot: [PI, 0, 0] }),
  P("body", "cylinder", [0.14, 0.16, 0.14], [0, 0.21, 0], K.yellow, { e: K.orange, ei: 1.0 }),
  P("rim", "box", [0.012, 0.17, 0.012], [0.07, 0.21, 0], K.dark, { mx: "x" }),
  P("rim", "box", [0.012, 0.17, 0.012], [0, 0.21, 0.07], K.dark, { mx: "z" }),
  P("rim", "cone", [0.17, 0.05, 0.17], [0, 0.31, 0], K.dark, { rot: [PI, 0, 0] }),
  P("orb", "sphere", [0.06, 0.08, 0.06], [0, 0.21, 0], K.white, { ...glow(K.orange, 2.4), a: ["flicker", 8, 0.35] }),
], [K.yellow, K.dark, K.orange], { particles: { kind: "embers", color: K.orange, rate: 6 } });
A("skull", "Skull Totem", "focus", "skull|skulls|skull totem|bone focus|lich|death's head|voodoo", 0.4, [26, 20, 24, 30], [
  P("handle", "cylinder", [0.03, 0.16, 0.03], [0, 0.08, 0], K.bone),
  P("head", "sphere", [0.16, 0.15, 0.17], [0, 0.26, 0], K.bone),
  P("head", "box", [0.1, 0.06, 0.1], [0, 0.18, 0.025], K.bone),
  P("gem", "sphere", [0.035, 0.035, 0.02], [0.035, 0.27, 0.075], K.green, { ...glow(K.green, 2.2), mx: "x", a: ["flicker", 4, 0.3] }),
  P("decor", "cone", [0.03, 0.08, 0.03], [0.07, 0.36, 0], K.bone, { rot: [0, 0, -0.5], mx: "x" }),
], [K.bone, K.green, K.dark], { particles: { kind: "smoke", color: K.green, rate: 4 } });

// ------------------------------------------------------------------------------------------------ shields (bottom edge at y = 0, face +Z)

A("buckler", "Buckler", "shield_small", "buckler|bucklers|targe|parrying shield", 0.42, [18, 40, 10, 32], [
  P("body", "cylinder", [0.4, 0.04, 0.4], [0, 0.2, 0], K.steel2, { rot: [H, 0, 0] }),
  P("rim", "torus", [0.41, 0.41, 0.03], [0, 0.2, 0.0], K.brass),
  P("head", "sphere", [0.12, 0.12, 0.08], [0, 0.2, 0.03], K.brass),
  P("spike", "cone", [0.04, 0.06, 0.04], [0, 0.2, 0.08], K.steel, { rot: [H, 0, 0] }),
], [K.steel2, K.brass, K.steel]);
A("round_shield", "Round Shield", "shield_small", "shield|shields|round shield|viking shield|roundel", 0.75, [16, 30, 10, 44], [
  P("body", "cylinder", [0.74, 0.04, 0.74], [0, 0.37, 0], K.wood, { rot: [H, 0, 0] }),
  P("rim", "torus", [0.76, 0.76, 0.035], [0, 0.37, 0], K.iron),
  P("decor", "box", [0.74, 0.12, 0.045], [0, 0.37, 0], K.red),
  P("decor", "box", [0.12, 0.74, 0.045], [0, 0.37, 0], K.red),
  P("head", "sphere", [0.16, 0.16, 0.1], [0, 0.37, 0.03], K.iron),
], [K.wood, K.red, K.iron]);
A("spiked_shield", "Spiked Shield", "shield_small", "spiked shield|spike shield|thorn shield|lantern shield", 0.75, [24, 26, 8, 42], [
  P("body", "cylinder", [0.7, 0.05, 0.7], [0, 0.35, 0], K.dark, { rot: [H, 0, 0] }),
  P("rim", "torus", [0.72, 0.72, 0.04], [0, 0.35, 0], K.steel2),
  P("head", "sphere", [0.18, 0.18, 0.1], [0, 0.35, 0.03], K.steel2),
  P("spike", "cone", [0.06, 0.2, 0.06], [0, 0.35, 0.15], K.steel, { rot: [H, 0, 0] }),
  P("spike", "cone", [0.04, 0.1, 0.04], [0.22, 0.35, 0.05], K.steel, { rot: [H, 0, 0], mx: "x" }),
  P("spike", "cone", [0.04, 0.1, 0.04], [0, 0.57, 0.05], K.steel, { rot: [H, 0, 0] }),
  P("spike", "cone", [0.04, 0.1, 0.04], [0, 0.13, 0.05], K.steel, { rot: [H, 0, 0] }),
], [K.dark, K.steel2, K.steel]);
A("heater_shield", "Heater Shield", "shield_small", "heater shield|heater|knight shield|crusader shield|crest shield", 0.8, [16, 28, 10, 46], [
  P("body", "box", [0.56, 0.38, 0.05], [0, 0.55, 0], K.blue),
  P("body", "cone", [0.56, 0.42, 0.05], [0, 0.22, 0], K.blue, { rot: [0, 0, PI] }),
  P("rim", "box", [0.6, 0.04, 0.06], [0, 0.75, 0], K.gold),
  P("decor", "box", [0.06, 0.58, 0.055], [0, 0.44, 0], K.white),
  P("decor", "box", [0.36, 0.06, 0.055], [0, 0.56, 0], K.white),
], [K.blue, K.white, K.gold]);
A("mirror_shield", "Mirror Shield", "shield_small", "mirror shield|mirror|reflective shield|aegis|polished shield", 0.75, [14, 26, 12, 48], [
  P("body", "cylinder", [0.7, 0.04, 0.7], [0, 0.35, 0], "#e4f2ff", { rot: [H, 0, 0], m: 0.5, r: 0.12, e: "#bfefff", ei: 0.35 }),
  P("rim", "torus", [0.73, 0.73, 0.045], [0, 0.35, 0], K.gold),
  P("rune", "torus", [0.4, 0.4, 0.012], [0, 0.35, 0.025], K.gold),
  P("gem", "octahedron", [0.1, 0.12, 0.06], [0, 0.35, 0.04], K.cyan, { ...glow(K.cyan, 1.2), a: ["pulse", 2, 0.1] }),
], [K.white, K.gold, K.cyan]);
A("kite_shield", "Kite Shield", "shield_large", "kite shield|kite|norman shield|teardrop shield", 1.0, [14, 22, 10, 54], [
  P("body", "sphere", [0.62, 0.4, 0.06], [0, 0.78, 0], K.crimson),
  P("body", "cone", [0.62, 0.72, 0.06], [0, 0.45, 0], K.crimson, { rot: [0, 0, PI] }),
  P("rim", "box", [0.05, 0.85, 0.065], [0, 0.5, 0], K.gold),
  P("rim", "box", [0.5, 0.05, 0.065], [0, 0.72, 0], K.gold),
  P("head", "sphere", [0.12, 0.12, 0.08], [0, 0.72, 0.03], K.gold),
], [K.crimson, K.gold, K.steel2]);
A("tower_shield", "Tower Shield", "shield_large", "tower shield|tower|scutum|great shield|wall shield|door|ward|barrier|bulwark", 1.3, [14, 16, 10, 60], [
  P("body", "box", [0.66, 1.22, 0.07], [0, 0.61, 0], K.steel2),
  P("rim", "box", [0.7, 0.05, 0.08], [0, 1.2, 0], K.iron),
  P("rim", "box", [0.7, 0.05, 0.08], [0, 0.03, 0], K.iron),
  P("rim", "box", [0.05, 1.22, 0.08], [0.33, 0.61, 0], K.iron, { mx: "x" }),
  P("decor", "box", [0.08, 1.0, 0.08], [0, 0.61, 0.01], K.iron),
  P("head", "sphere", [0.2, 0.2, 0.1], [0, 0.66, 0.04], K.iron),
  P("spike", "sphere", [0.04, 0.04, 0.03], [0.24, 1.05, 0.04], K.iron, { mx: "x" }),
  P("spike", "sphere", [0.04, 0.04, 0.03], [0.24, 0.2, 0.04], K.iron, { mx: "x" }),
], [K.steel2, K.iron, K.dark]);
A("pavise", "Pavise", "shield_large", "pavise|mantlet|siege shield|barricade shield", 1.4, [12, 14, 14, 60], [
  P("body", "box", [0.72, 1.3, 0.06], [0, 0.65, 0], K.wood),
  P("body", "prism", [0.18, 1.3, 0.12], [0, 0.65, 0.03], K.wood2),
  P("decor", "box", [0.5, 0.5, 0.065], [0, 0.85, 0], K.yellow),
  P("decor", "box", [0.2, 0.3, 0.07], [0, 0.85, 0.005], K.blue),
  P("rim", "box", [0.74, 0.04, 0.07], [0, 1.28, 0], K.iron),
  P("spike", "cone", [0.04, 0.12, 0.04], [0.28, -0.0, 0], K.iron, { rot: [PI, 0, 0], mx: "x" }),
], [K.wood, K.yellow, K.blue]);
A("aspis", "Aspis", "shield_large", "aspis|hoplon|hoplite shield|spartan shield|greek shield", 0.95, [14, 22, 10, 54], [
  P("body", "sphere", [0.9, 0.9, 0.18], [0, 0.45, 0], K.bronze),
  P("rim", "torus", [0.92, 0.92, 0.06], [0, 0.45, 0], K.brass),
  P("decor", "crescent", [0.4, 0.25, 0.02], [0, 0.45, 0.09], K.crimson),
  P("decor", "cone", [0.08, 0.12, 0.02], [0, 0.38, 0.09], K.crimson, { rot: [0, 0, PI] }),
], [K.bronze, K.brass, K.crimson]);

// ------------------------------------------------------------------------------------------------ novelty

A("rubber_chicken", "Rubber Chicken", "whip", "rubber chicken|chicken|chickens|rooster|duck", 0.6, [18, 38, 14, 30], [
  P("handle", "capsule", [0.04, 0.12, 0.04], [0, 0.06, 0], K.orange),
  P("body", "capsule", [0.13, 0.3, 0.11], [0, 0.28, 0], K.yellow, { a: ["wobble", 6, 0.12] }),
  P("head", "sphere", [0.08, 0.09, 0.08], [0, 0.48, 0], K.yellow, { a: ["wobble", 6, 0.2] }),
  P("decor", "cone", [0.04, 0.06, 0.03], [0, 0.49, 0.05], K.orange, { rot: [H, 0, 0], a: ["wobble", 6, 0.2] }),
  P("cloth", "box", [0.012, 0.05, 0.04], [0, 0.54, 0], K.red, { a: ["wobble", 6, 0.25] }),
  P("gem", "sphere", [0.015, 0.015, 0.015], [0.03, 0.5, 0.03], K.black, { mx: "x", a: ["wobble", 6, 0.2] }),
  P("limb", "box", [0.03, 0.12, 0.08], [0.07, 0.3, 0], K.yellow, { rot: [0, 0, -0.3], mx: "x", a: ["wobble", 8, 0.3] }),
], [K.yellow, K.orange, K.red]);
A("frying_pan", "Frying Pan", "hammer", "frying pan|pan|skillet|wok|cooking pot", 0.7, [40, 28, 8, 24], [
  P("handle", "cylinder", [0.035, 0.32, 0.035], [0, 0.16, 0], K.black),
  P("body", "cylinder", [0.34, 0.03, 0.34], [0, 0.49, 0], K.dark, { rot: [H, 0, 0] }),
  P("rim", "torus", [0.35, 0.35, 0.04], [0, 0.49, 0.01], K.dark),
  P("decor", "cylinder", [0.3, 0.005, 0.3], [0, 0.49, 0.017], K.steel2, { rot: [H, 0, 0] }),
], [K.dark, K.black, K.steel2]);
A("fish", "Fish", "sword", "fish|tuna|salmon|swordfish|mackerel|herring|trout|cod", 0.8, [30, 32, 14, 24], [
  P("handle", "cone", [0.08, 0.12, 0.03], [0, 0.05, 0], K.teal, { rot: [PI, 0, 0] }),
  P("limb", "wedge", [0.14, 0.12, 0.02], [0, 0.0, 0], K.teal, { rot: [PI, 0, 0] }),
  P("body", "sphere", [0.16, 0.6, 0.08], [0, 0.4, 0], K.blue, { a: ["wobble", 4, 0.08] }),
  P("decor", "sphere", [0.12, 0.5, 0.082], [0, 0.4, 0.003], K.white),
  P("gem", "sphere", [0.03, 0.03, 0.02], [0, 0.6, 0.04], K.black, { mx: "z" }),
  P("limb", "wedge", [0.06, 0.12, 0.01], [0.07, 0.35, 0], K.teal, { rot: [0, 0, -0.6], mx: "x" }),
], [K.blue, K.teal, K.white]);
A("umbrella", "Umbrella", "sword", "umbrella|parasol|brolly", 0.95, [26, 32, 16, 26], [
  P("handle", "torus", [0.1, 0.1, 0.025], [-0.035, 0.03, 0], K.wood2, { rot: [0, 0, 0] }),
  P("handle", "cylinder", [0.022, 0.75, 0.022], [0, 0.45, 0], K.dark),
  P("body", "cone", [0.16, 0.6, 0.16], [0, 0.55, 0], K.red),
  P("cloth", "cone", [0.17, 0.12, 0.17], [0, 0.82, 0], K.white),
  P("spike", "cone", [0.02, 0.08, 0.02], [0, 0.9, 0], K.steel2),
], [K.red, K.white, K.dark]);
A("guitar", "Guitar", "hammer", "guitar|guitars|lute|bass guitar|axe guitar|electric guitar|banjo|ukulele", 1.0, [40, 24, 10, 26], [
  P("handle", "box", [0.05, 0.5, 0.03], [0, 0.25, 0], K.wood2),
  P("decor", "box", [0.07, 0.12, 0.03], [0, 0.0, 0], K.black),
  P("body", "sphere", [0.32, 0.26, 0.08], [0, 0.6, 0], K.red),
  P("body", "sphere", [0.26, 0.2, 0.08], [0, 0.79, 0], K.red),
  P("decor", "torus", [0.08, 0.08, 0.012], [0, 0.66, 0.04], K.black),
  P("string", "box", [0.03, 0.75, 0.004], [0, 0.4, 0.045], K.steel2),
  P("decor", "box", [0.12, 0.03, 0.02], [0, 0.88, 0.04], K.black),
], [K.red, K.wood2, K.black]);
A("baguette", "Baguette", "sword", "baguette|bread|loaf|french bread|breadstick", 0.85, [24, 34, 12, 30], [
  P("handle", "capsule", [0.08, 0.8, 0.08], [0, 0.4, 0], K.wood, { r: 0.95 }),
  P("decor", "box", [0.05, 0.012, 0.03], [0, 0.25, 0.035], K.bone, { rot: [0, 0, 0.5] }),
  P("decor", "box", [0.05, 0.012, 0.03], [0, 0.42, 0.035], K.bone, { rot: [0, 0, 0.5] }),
  P("decor", "box", [0.05, 0.012, 0.03], [0, 0.59, 0.035], K.bone, { rot: [0, 0, 0.5] }),
], [K.wood, K.bone, K.yellow]);
A("broom", "Broom", "staff", "broom|broomstick|besom|mop", 1.4, [22, 30, 24, 24], [
  ...shaft(0, 1.05, 0.035, K.wood),
  P("ring", "cylinder", [0.06, 0.05, 0.06], [0, 1.07, 0], K.red),
  P("head", "cone", [0.28, 0.35, 0.12], [0, 1.23, 0], K.yellow, { rot: [PI, 0, 0], a: ["wobble", 3, 0.08] }),
], [K.wood, K.yellow, K.red]);
A("rolling_pin", "Rolling Pin", "hammer", "rolling pin|rolling pins", 0.6, [40, 28, 8, 24], [
  P("handle", "cylinder", [0.035, 0.12, 0.035], [0, 0.06, 0], K.wood2),
  P("body", "cylinder", [0.09, 0.38, 0.09], [0, 0.32, 0], K.wood),
  P("handle", "cylinder", [0.035, 0.12, 0.035], [0, 0.57, 0], K.wood2),
  P("pommel", "sphere", [0.045, 0.045, 0.045], [0, 0.0, 0], K.wood2),
], [K.wood, K.wood2, K.bone]);
A("candy_cane", "Candy Cane", "hammer", "candy cane|candy|lollipop|sweet|peppermint", 0.9, [36, 28, 12, 24], [
  P("handle", "cylinder", [0.05, 0.7, 0.05], [0, 0.35, 0], K.white),
  band(0.12, 0.055, K.red, 0.02), band(0.27, 0.055, K.red, 0.02), band(0.42, 0.055, K.red, 0.02), band(0.57, 0.055, K.red, 0.02),
  P("head", "torus", [0.24, 0.24, 0.05], [-0.095, 0.7, 0], K.red, { rot: [0, 0, 0] }),
], [K.white, K.red, K.green]);
A("banana", "Banana", "thrown", "banana|bananas|plantain", 0.4, [20, 36, 26, 18], [
  P("body", "crescent", [0.4, 0.18, 0.06], [0, 0.2, 0], K.yellow, { rot: [0, 0, -H] }),
  P("handle", "cylinder", [0.02, 0.04, 0.02], [-0.03, 0.0, 0], K.wood2),
  P("decor", "sphere", [0.02, 0.02, 0.02], [-0.03, 0.4, 0], K.wood2),
], [K.yellow, K.wood2, K.green]);

// ------------------------------------------------------------------------------------------------ tier 2: arena objects (stand on y = 0)

A("turret", "Turret", "cannon", "turret|turrets|sentry|cannon tower|ballista tower", 1.4, [40, 15, 35, 10], [
  P("body", "cylinder", [0.8, 0.5, 0.8], [0, 0.25, 0], K.stone),
  P("rim", "cylinder", [0.86, 0.06, 0.86], [0, 0.5, 0], K.iron),
  P("head", "box", [0.55, 0.42, 0.55], [0, 0.78, 0], K.iron, { a: ["wobble", 1, 0.15] }),
  P("barrel", "cylinder", [0.13, 0.7, 0.13], [0, 0.82, 0.5], K.dark, { rot: [H, 0, 0], a: ["wobble", 1, 0.15] }),
  P("gem", "sphere", [0.12, 0.12, 0.05], [0, 0.85, 0.28], K.red, { ...glow(K.red, 1.5), a: ["pulse", 3, 0.2] }),
], [K.stone, K.iron, K.red], {}, "arena_object");
A("wall", "Stone Wall", "shield_large", "wall|walls|barricade|pillar|pillars|rampart|palisade|bulwark|barrier", 2.4, [14, 13, 13, 60], [
  P("body", "box", [1.2, 1.0, 0.45], [-0.6, 0.5, 0], K.stone),
  P("body", "box", [1.2, 1.0, 0.45], [0.6, 0.5, 0], K.stone, { rot: [0, 0.05, 0] }),
  P("body", "box", [1.0, 0.9, 0.42], [-0.35, 1.45, 0], K.stone),
  P("body", "box", [1.0, 0.9, 0.42], [0.65, 1.45, 0.02], K.stone),
  P("rim", "box", [0.35, 0.3, 0.5], [-0.9, 2.05, 0], K.stone2, { }),
  P("rim", "box", [0.35, 0.3, 0.5], [0.0, 2.05, 0], K.stone2),
  P("rim", "box", [0.35, 0.3, 0.5], [0.9, 2.05, 0], K.stone2),
  P("decor", "box", [0.3, 0.6, 0.05], [0, 1.0, 0.24], K.red),
], [K.stone, K.iron, K.red], {}, "arena_object");
A("spike_trap", "Spike Trap", "fist", "trap|traps|spike trap|bear trap|snare|mine|caltrops", 1.8, [45, 20, 15, 20], [
  P("body", "cylinder", [1.8, 0.08, 1.8], [0, 0.04, 0], K.iron),
  P("rim", "torus", [1.8, 1.8, 0.06], [0, 0.07, 0], K.dark, { rot: [H, 0, 0] }),
  P("spike", "cone", [0.14, 0.45, 0.14], [0.5, 0.3, 0], K.steel, { mx: "x" }),
  P("spike", "cone", [0.14, 0.45, 0.14], [0, 0.3, 0.5], K.steel, { mx: "z" }),
  P("spike", "cone", [0.14, 0.45, 0.14], [0.35, 0.3, 0.35], K.steel, { mx: "x" }),
  P("spike", "cone", [0.14, 0.45, 0.14], [0.35, 0.3, -0.35], K.steel, { mx: "x" }),
  P("spike", "cone", [0.18, 0.55, 0.18], [0, 0.35, 0], K.steel),
  P("rune", "torus", [1.2, 1.2, 0.03], [0, 0.09, 0], K.red, { rot: [H, 0, 0], ...glow(K.red, 1.2), a: ["pulse", 3, 0.2] }),
], [K.iron, K.steel, K.red], {}, "arena_object");
A("totem", "Totem", "staff", "totem|totems|totem pole|idol|obelisk|monolith|beacon", 1.8, [25, 20, 25, 30], [
  P("body", "box", [0.45, 0.5, 0.45], [0, 0.25, 0], K.wood2),
  P("body", "box", [0.42, 0.5, 0.42], [0, 0.75, 0], K.wood),
  P("body", "box", [0.4, 0.45, 0.4], [0, 1.22, 0], K.wood2),
  P("decor", "box", [0.3, 0.08, 0.05], [0, 0.82, 0.22], K.red),
  P("gem", "sphere", [0.07, 0.07, 0.04], [0.09, 1.28, 0.2], K.yellow, { ...glow(K.yellow, 2), mx: "x" }),
  P("limb", "wedge", [0.5, 0.18, 0.06], [0.42, 1.25, 0], K.teal, { rot: [0, 0, -1.2], mx: "x" }),
  P("orb", "icosahedron", [0.22, 0.22, 0.22], [0, 1.65, 0], K.cyan, { ...glow(K.cyan, 1.6), a: ["float", 2, 0.06] }),
], [K.wood, K.teal, K.cyan], { particles: { kind: "motes", color: K.cyan, rate: 6 } }, "arena_object");

// ------------------------------------------------------------------------------------------------ tier 2: armour (centred)

A("crown", "Crown", "fist", "crown|crowns|tiara|circlet|diadem|halo", 0.36, [20, 20, 20, 40], [
  P("body", "torus", [0.32, 0.32, 0.05], [0, 0, 0], K.gold, { rot: [H, 0, 0] }),
  P("spike", "cone", [0.06, 0.12, 0.03], [0.15, 0.07, 0], K.gold, { mx: "x" }),
  P("spike", "cone", [0.06, 0.12, 0.03], [0, 0.07, 0.15], K.gold, { mx: "z", rot: [0, H, 0] }),
  P("gem", "octahedron", [0.05, 0.06, 0.03], [0, 0.02, 0.16], K.red, { ...glow(K.red, 1.2), a: ["pulse", 2, 0.15] }),
  P("gem", "octahedron", [0.035, 0.045, 0.03], [0.16, 0.02, 0], K.blue, { mx: "x" }),
], [K.gold, K.red, K.blue], {}, "armour");
A("helmet", "Helmet", "fist", "helmet|helmets|helm|hat|hood|mask|visor", 0.36, [20, 20, 20, 40], [
  P("body", "sphere", [0.3, 0.28, 0.32], [0, 0.03, 0], K.steel2),
  P("rim", "torus", [0.31, 0.33, 0.03], [0, -0.04, 0], K.iron, { rot: [H, 0, 0] }),
  P("decor", "box", [0.04, 0.14, 0.3], [0, 0.12, 0], K.red),
  P("guard", "box", [0.03, 0.14, 0.03], [0, -0.06, 0.16], K.iron),
  P("spike", "cone", [0.04, 0.12, 0.04], [0.13, 0.12, 0], K.bone, { rot: [0, 0, -0.9], mx: "x" }),
], [K.steel2, K.iron, K.red], {}, "armour");
A("cape", "Cape", "fist", "cape|capes|cloak|cloaks|mantle|scarf|robe", 0.6, [15, 25, 20, 40], [
  P("cloth", "box", [0.42, 0.55, 0.03], [0, -0.05, 0], K.crimson, { a: ["wobble", 2, 0.06] }),
  P("cloth", "box", [0.45, 0.06, 0.04], [0, 0.22, 0], K.gold),
  P("cloth", "wedge", [0.42, 0.12, 0.03], [0, -0.38, 0], K.crimson, { rot: [0, 0, PI], a: ["wobble", 2.4, 0.08] }),
  P("gem", "sphere", [0.05, 0.05, 0.03], [0.17, 0.22, 0.02], K.gold, { mx: "x" }),
], [K.crimson, K.gold, K.dark], {}, "armour");
A("pauldron", "Pauldron", "fist", "pauldron|pauldrons|shoulder|shoulders|spaulder|epaulette", 0.3, [20, 20, 20, 40], [
  P("body", "sphere", [0.28, 0.18, 0.28], [0, 0, 0], K.steel2),
  P("rim", "sphere", [0.3, 0.06, 0.3], [0, -0.06, 0], K.iron),
  P("spike", "cone", [0.05, 0.14, 0.05], [0.04, 0.1, 0], K.steel, { rot: [0, 0, -0.4] }),
  P("spike", "cone", [0.04, 0.1, 0.04], [-0.06, 0.08, 0.04], K.steel, { rot: [0.3, 0, 0.4] }),
], [K.steel2, K.iron, K.steel], {}, "armour");
A("breastplate", "Breastplate", "fist", "breastplate|chestplate|cuirass|armor|armour|mail|vest|plate", 0.5, [15, 20, 20, 45], [
  P("body", "box", [0.42, 0.42, 0.24], [0, 0, 0], K.steel2),
  P("body", "sphere", [0.36, 0.3, 0.12], [0, 0.04, 0.1], K.steel),
  P("rim", "box", [0.44, 0.05, 0.26], [0, -0.2, 0], K.iron),
  P("decor", "box", [0.04, 0.36, 0.03], [0, 0.0, 0.16], K.gold),
  P("gem", "octahedron", [0.06, 0.07, 0.03], [0, 0.08, 0.17], K.red, { ...glow(K.red, 1.0), a: ["pulse", 2, 0.12] }),
], [K.steel2, K.gold, K.red], {}, "armour");

// ------------------------------------------------------------------------------------------------ tier 2: allies (stand on y = 0, face +Z)

A("wolf", "Wolf", "fist", "wolf|wolves|hound|hounds|dog|dogs|fox|direwolf|warg|cat|tiger|lion", 1.0, [40, 30, 10, 20], [
  P("body", "capsule", [0.3, 0.6, 0.3], [0, 0.45, 0], K.stone, { rot: [H, 0, 0], a: ["float", 3, 0.015] }),
  P("head", "box", [0.24, 0.22, 0.26], [0, 0.62, 0.36], K.stone, { a: ["wobble", 2, 0.06] }),
  P("head", "box", [0.14, 0.1, 0.16], [0, 0.57, 0.53], K.stone2),
  P("spike", "cone", [0.07, 0.12, 0.05], [0.08, 0.78, 0.33], K.stone, { mx: "x" }),
  P("limb", "cylinder", [0.08, 0.3, 0.08], [0.1, 0.15, 0.2], K.stone2, { mx: "x" }),
  P("limb", "cylinder", [0.08, 0.3, 0.08], [0.1, 0.15, -0.2], K.stone2, { mx: "x" }),
  P("limb", "cone", [0.08, 0.32, 0.08], [0, 0.55, -0.4], K.stone, { rot: [-1.0, 0, 0], a: ["wobble", 6, 0.3] }),
  P("gem", "sphere", [0.04, 0.04, 0.02], [0.06, 0.66, 0.49], K.yellow, { ...glow(K.yellow, 2), mx: "x" }),
], [K.stone, K.yellow, K.dark], {}, "ally");
A("golem", "Golem", "fist", "golem|golems|construct|robot|automaton|rock|pet rock|statue|gargoyle", 1.0, [45, 15, 10, 30], [
  P("body", "icosahedron", [0.5, 0.45, 0.38], [0, 0.55, 0], K.stone, { a: ["float", 2, 0.02] }),
  P("head", "box", [0.22, 0.2, 0.2], [0, 0.88, 0.02], K.stone),
  P("gem", "box", [0.14, 0.03, 0.02], [0, 0.9, 0.12], K.cyan, { ...glow(K.cyan, 2), a: ["flicker", 3, 0.25] }),
  P("limb", "box", [0.16, 0.42, 0.16], [0.34, 0.5, 0], K.stone, { rot: [0, 0, 0.12], mx: "x", a: ["wobble", 2, 0.08] }),
  P("limb", "box", [0.16, 0.3, 0.16], [0.13, 0.15, 0], K.stone, { mx: "x" }),
  P("rune", "octahedron", [0.12, 0.14, 0.03], [0, 0.58, 0.19], K.cyan, { ...glow(K.cyan, 1.5), a: ["pulse", 2, 0.2] }),
  P("decor", "box", [0.06, 0.06, 0.06], [0.2, 0.84, 0.04], K.moss, { mx: "x" }),
], [K.stone, K.cyan, K.moss], {}, "ally");
A("bee_swarm", "Bee Swarm", "fist", "bee|bees|wasp|wasps|hornet|swarm|hive|beehive", 0.8, [35, 40, 10, 15], [
  P("body", "sphere", [0.36, 0.42, 0.36], [0, 0.3, 0], K.yellow),
  band(0.3, 0.37, K.brass, 0.04), band(0.42, 0.33, K.brass, 0.035), band(0.18, 0.33, K.brass, 0.035),
  P("decor", "sphere", [0.08, 0.06, 0.03], [0, 0.26, 0.17], K.dark),
  P("orb", "capsule", [0.06, 0.1, 0.06], [0.35, 0.5, 0], K.yellow, { rot: [0, 0, H], a: ["orbit", 3, 0.35] }),
  P("orb", "capsule", [0.06, 0.1, 0.06], [-0.3, 0.6, 0.1], K.yellow, { rot: [0, 0, H], a: ["orbit", 4, 0.3] }),
  P("orb", "capsule", [0.06, 0.1, 0.06], [0.1, 0.7, -0.3], K.yellow, { rot: [0, 0, H], a: ["orbit", 3.5, 0.32] }),
  P("limb", "sphere", [0.08, 0.03, 0.05], [0.35, 0.55, 0], K.white, { a: ["orbit", 3, 0.35] }),
], [K.yellow, K.brass, K.dark], {}, "ally");
A("familiar", "Familiar", "fist", "familiar|companion|pet|minion|sprite|spirit|wisp|owl|bat|dragon|goblin|imp|slime", 0.8, [30, 30, 15, 25], [
  P("body", "icosahedron", [0.4, 0.4, 0.4], [0, 0.45, 0], K.purple, { a: ["float", 2, 0.05] }),
  P("spike", "cone", [0.1, 0.22, 0.08], [0.12, 0.7, 0], K.purple, { rot: [0, 0, -0.3], mx: "x", a: ["float", 2, 0.05] }),
  P("gem", "sphere", [0.08, 0.1, 0.04], [0.08, 0.5, 0.18], K.white, { ...glow(K.yellow, 1.6), mx: "x", a: ["float", 2, 0.05] }),
  P("limb", "wedge", [0.36, 0.22, 0.03], [0.3, 0.5, -0.05], K.pink, { rot: [0, 0.3, -1.3], mx: "x", a: ["wobble", 7, 0.25] }),
  P("limb", "box", [0.14, 0.06, 0.18], [0.1, 0.06, 0.04], K.purple, { mx: "x" }),
], [K.purple, K.pink, K.yellow], { particles: { kind: "motes", color: K.pink, rate: 6 } }, "ally");

// ------------------------------------------------------------------------------------------------ exports

/** Every archetype, in authoring order. */
export const ARCHETYPES: readonly Archetype[] = ALL;
export const ARCHETYPE_IDS: readonly string[] = ALL.map((a) => a.id);
const BY_ID = new Map(ALL.map((a) => [a.id, a]));

export function archetypeById(id: unknown): Archetype | undefined {
  return typeof id === "string" ? BY_ID.get(id) : undefined;
}

/** Default archetype per library family. */
export const FAMILY_DEFAULT: Record<string, string> = {
  dagger: "dagger", sword: "arming_sword", greatsword: "claymore", axe: "battleaxe", hammer: "warhammer",
  spear: "spear", scythe: "scythe", whip: "whip", fist: "gauntlet", bow: "shortbow", crossbow: "crossbow",
  gun: "pistol", cannon: "hand_cannon", thrown: "chakram", staff: "wizard_staff", focus: "orb",
  shield_small: "round_shield", shield_large: "kite_shield",
};

/** Default archetype of a tier-2 category, by a behaviour hint where it matters. */
export function categoryDefault(category: LibraryCategory, hint: "shield" | "ranged" | "magic" | "melee" = "melee"): string {
  if (category === "arena_object") {
    if (hint === "shield") return "wall";
    if (hint === "ranged") return "turret";
    if (hint === "magic") return "totem";
    return "spike_trap";
  }
  if (category === "armour") return "breastplate";
  return "familiar";
}

/** Deep copy of an archetype default model (callers may mutate it). */
export function defaultBlueprint(id: string): ItemBlueprint {
  const a = BY_ID.get(id) ?? BY_ID.get("arming_sword")!;
  return JSON.parse(JSON.stringify(a.defaultBlueprint)) as ItemBlueprint;
}

// Parametric Voxel DSL templates (rules plans): house, tower, wall, statue, bridge, farm, well. The builder module
// answers instantly with these; the AI upgrade replaces them. Pure TypeScript, deterministic.
import type { VoxelOp, VoxelPlan, VoxelVec } from "./voxel.js";
import { expandVoxelPlan, normalizeBlockId } from "./voxel-expand.js";

/** Palette roles, in the order a `palette: string[]` fills them. */
export const VOXEL_PALETTE_ROLES = ["wall", "trim", "roof", "floor", "glass", "accent"] as const;
export type VoxelPaletteRole = (typeof VOXEL_PALETTE_ROLES)[number];

/** Default block per role (Livecraft-style ids; expandVoxelPlan maps them to the game's ids). */
export const DEFAULT_VOXEL_PALETTE: Record<VoxelPaletteRole, string> = {
  wall: "oak_planks", trim: "spruce_log", roof: "bricks", floor: "cobblestone", glass: "glass", accent: "torch",
};

/** A palette as block ids in role order (wall, trim, roof, floor, glass, accent) or as a role -> block map. */
export type VoxelPaletteInput = readonly string[] | Readonly<Record<string, string>>;

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v : lo)));

function paletteOf(input: VoxelPaletteInput | undefined, extra: Record<string, string> = {}): Record<string, string> {
  const p: Record<string, string> = { ...DEFAULT_VOXEL_PALETTE, ...extra };
  if (Array.isArray(input)) {
    input.forEach((b, i) => {
      const id = normalizeBlockId(b);
      if (id && i < VOXEL_PALETTE_ROLES.length) p[VOXEL_PALETTE_ROLES[i]] = id;
    });
  } else if (input) {
    for (const [k, v] of Object.entries(input)) {
      const key = normalizeBlockId(k);
      const id = normalizeBlockId(v);
      if (key && id) p[key] = id;
    }
  }
  return p;
}

// ---------------------------------------------------------------- colours (statues)

/** Wool-style colour blocks with reference colours, for hex -> block mapping. */
export const VOXEL_COLOR_BLOCKS: Record<string, string> = {
  white_wool: "#e9ecec", light_gray_wool: "#8e8e86", gray_wool: "#3e4447", black_wool: "#141519", brown_wool: "#724728",
  red_wool: "#a12722", orange_wool: "#f07613", yellow_wool: "#f8c527", lime_wool: "#70b919", green_wool: "#546d1b",
  cyan_wool: "#158991", light_blue_wool: "#3aafd9", blue_wool: "#35399d", purple_wool: "#792aac", magenta_wool: "#bd44b3",
  pink_wool: "#ed8dac",
};

const rgb = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** A colour ("#rrggbb") or block id -> block id (nearest VOXEL_COLOR_BLOCKS entry for colours). */
export function colorToBlock(color: string): string {
  const c = rgb(color);
  if (!c) return normalizeBlockId(color);
  let best = "white_wool";
  let bestD = Infinity;
  for (const [id, hex] of Object.entries(VOXEL_COLOR_BLOCKS)) {
    const r = rgb(hex)!;
    const d = (r[0] - c[0]) ** 2 * 0.3 + (r[1] - c[1]) ** 2 * 0.59 + (r[2] - c[2]) ** 2 * 0.11;
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

// ---------------------------------------------------------------- templates

function house(w = 7, d = 6, h = 4, palette?: VoxelPaletteInput): VoxelPlan {
  w = clampInt(w, 4, 24);
  d = clampInt(d, 4, 24);
  h = clampInt(h, 3, 10);
  const doorX = 1 + Math.floor((w - 1) / 2);
  const midZ = 1 + Math.floor((d - 1) / 2);
  const cx = (1 + w) / 2;
  const ops: VoxelOp[] = [
    { op: "hollow_box", from: [1, 0, 1], to: [w, h, d], block: "wall" },
    { op: "box", from: [1, 0, 1], to: [w, 0, d], block: "floor" },
    { op: "edges", from: [1, 0, 1], to: [w, h, d], block: "trim" },
    { op: "fill_air", from: [2, 1, 2], to: [w - 1, h - 1, d - 1] },
    { op: "roof", style: "gable", from: [0, h + 1, 0], to: [w + 1, h + 1, d + 1], block: "roof" },
    { op: "door", at: [doorX, 1, 1], facing: "north" },
    { op: "repeat", count: Math.max(1, Math.floor((w - 1) / 2)), step: [2, 0, 0], ops: [{ op: "window", at: [2, 2, d], block: "glass" }] },
    { op: "mirror", axis: "x", at: cx, ops: [{ op: "window", at: [1, 2, midZ], block: "glass" }] },
    { op: "block", at: [2, 1, 2], block: "accent" },
    { op: "block", at: [Math.min(w, doorX + 1), 2, 0], block: "accent" },
  ];
  if (w >= 6) ops.splice(7, 0, { op: "mirror", axis: "x", at: cx, ops: [{ op: "window", at: [2, 2, 1], block: "glass" }] });
  return { name: `Cosy ${w}x${d} house`, palette: paletteOf(palette), ops };
}

function tower(w = 5, h = 10, palette?: VoxelPaletteInput): VoxelPlan {
  w = clampInt(w, 3, 15);
  if (w % 2 === 0) w -= 1;
  h = clampInt(h, 4, 40);
  const r = (w - 1) / 2;
  const ops: VoxelOp[] = [
    { op: "cylinder", center: [r, 0, r], radius: r, height: 1, block: "floor" },
    { op: "cylinder", center: [r, 0, r], radius: r, height: h, hollow: true, block: "stone" },
  ];
  if (r >= 2) {
    ops.push({ op: "cylinder", center: [r, 1, r], radius: r - 1, height: Math.max(1, h - 2), block: "air" });
    ops.push({ op: "cylinder", center: [r, h - 1, r], radius: r - 1, height: 1, block: "floor" });
  }
  ops.push(
    { op: "cylinder", center: [r, h, r], radius: r, height: 1, hollow: true, block: "stone" },
    { op: "mirror", axis: "z", at: r, ops: [{ op: "fill_air", from: [r, h, 0], to: [r, h, 0] }] },
    { op: "mirror", axis: "x", at: r, ops: [{ op: "fill_air", from: [0, h, r], to: [0, h, r] }] },
    { op: "door", at: [r, 1, 0], facing: "north" },
    { op: "repeat", count: Math.max(1, Math.floor((h - 3) / 3)), step: [0, 3, 0], ops: [{ op: "mirror", axis: "x", at: r, ops: [{ op: "window", at: [0, 3, r], block: "glass" }] }] },
    { op: "block", at: [r, 1, r], block: "accent" },
  );
  return { name: `Stone tower (${h} high)`, palette: paletteOf(palette, { stone: "stone_bricks" }), ops };
}

function wall(length = 9, h = 4, palette?: VoxelPaletteInput): VoxelPlan {
  const L = clampInt(length, 3, 64);
  h = clampInt(h, 2, 12);
  const mid = Math.floor((L - 1) / 2);
  const ops: VoxelOp[] = [
    { op: "box", from: [0, 0, 0], to: [L - 1, h - 1, 1], block: "stone" },
    { op: "repeat", count: Math.ceil(L / 2), step: [2, 0, 0], ops: [{ op: "box", from: [0, h, 0], to: [0, h, 1], block: "stone" }] },
  ];
  if (L >= 7 && h >= 4) {
    ops.push({ op: "fill_air", from: [mid, 0, 0], to: [mid, 2, 1] });
    ops.push({ op: "line", from: [mid - 1, 3, 0], to: [mid + 1, 3, 0], block: "trim" });
  }
  return { name: `Wall (${L} long)`, palette: paletteOf(palette, { stone: "stone_bricks" }), ops };
}

/**
 * A blocky humanoid statue on a plinth: torso 2 x 3 x 1 units, arms, legs and head, each unit `scale` blocks.
 * colors = [shirt, trousers, skin, hair] as block ids or "#rrggbb" (mapped with colorToBlock). Faces north (-z).
 */
function statue(colors: readonly string[] = [], scale = 2, palette?: VoxelPaletteInput): VoxelPlan {
  const s = clampInt(scale, 1, 4);
  const col = (i: number, d: string) => (colors[i] ? colorToBlock(colors[i]) || d : d);
  const bz0 = 1 + Math.floor(s / 2);
  const bz1 = bz0 + s - 1;
  const cx = (4 * s + 1) / 2;
  const eyeX = 1 + s + Math.max(0, Math.floor(s / 2) - 1);
  const ops: VoxelOp[] = [
    { op: "box", from: [0, 0, 0], to: [4 * s + 1, 0, 2 * s + 1], block: "base" },
    { op: "box", from: [1 + s, 1, bz0], to: [3 * s, 3 * s, bz1], block: "trousers" },
    { op: "box", from: [1 + s, 3 * s + 1, bz0], to: [3 * s, 6 * s, bz1], block: "shirt" },
    { op: "mirror", axis: "x", at: cx, ops: [
      { op: "box", from: [1, 3 * s + 1, bz0], to: [s, 6 * s, bz1], block: "shirt" },
      { op: "box", from: [1, 3 * s + 1, bz0], to: [s, 3 * s + 1, bz1], block: "skin" },
    ] },
    { op: "box", from: [1 + s, 6 * s + 1, 1], to: [3 * s, 8 * s, 2 * s], block: "skin" },
    { op: "box", from: [1 + s, 8 * s, 1], to: [3 * s, 8 * s, 2 * s], block: "hair" },
  ];
  if (s >= 2) ops.push({ op: "mirror", axis: "x", at: cx, ops: [{ op: "block", at: [eyeX, 7 * s + 1, 1], block: "eyes" }] });
  const pal = paletteOf(palette, {
    base: "stone_bricks", shirt: col(0, "blue_wool"), trousers: col(1, "brown_wool"), skin: col(2, "sand"), hair: col(3, "spruce_planks"), eyes: "obsidian",
  });
  return { name: `Statue (scale ${s})`, palette: pal, ops };
}

function bridge(length = 9, w = 3, palette?: VoxelPaletteInput): VoxelPlan {
  const L = clampInt(length, 3, 64);
  w = clampInt(w, 1, 7);
  const ops: VoxelOp[] = [
    { op: "box", from: [0, 0, 0], to: [L - 1, 0, w + 1], block: "wall" },
    { op: "mirror", axis: "z", at: (w + 1) / 2, ops: [
      { op: "line", from: [0, 1, 0], to: [L - 1, 1, 0], block: "trim" },
      { op: "repeat", count: Math.floor((L - 1) / 4) + 1, step: [4, 0, 0], ops: [{ op: "block", at: [0, 2, 0], block: "accent" }] },
    ] },
  ];
  return { name: `Bridge (${L} long)`, palette: paletteOf(palette), ops };
}

function farm(w = 9, d = 9, palette?: VoxelPaletteInput): VoxelPlan {
  w = clampInt(w, 3, 32);
  d = clampInt(d, 3, 32);
  const mid = Math.floor((d - 1) / 2);
  const ops: VoxelOp[] = [
    { op: "edges", from: [0, 0, 0], to: [w - 1, 0, d - 1], block: "trim" },
    { op: "box", from: [1, 0, 1], to: [w - 2, 0, d - 2], block: "soil" },
    { op: "line", from: [1, 0, mid], to: [w - 2, 0, mid], block: "water" },
    { op: "box", from: [1, 1, 1], to: [w - 2, 1, d - 2], block: "crop" },
    { op: "fill_air", from: [1, 1, mid], to: [w - 2, 1, mid] },
    { op: "mirror", axis: "x", at: (w - 1) / 2, ops: [{ op: "mirror", axis: "z", at: (d - 1) / 2, ops: [{ op: "block", at: [0, 1, 0], block: "accent" }] }] },
  ];
  return { name: `Farm (${w}x${d})`, palette: paletteOf(palette, { soil: "farmland", crop: "wheat", water: "water" }), ops };
}

function well(palette?: VoxelPaletteInput): VoxelPlan {
  const ops: VoxelOp[] = [
    { op: "box", from: [0, 0, 0], to: [4, 0, 4], block: "floor" },
    { op: "box", from: [1, 0, 1], to: [3, 0, 3], block: "water" },
    { op: "edges", from: [0, 1, 0], to: [4, 1, 4], block: "floor" },
    { op: "fill_air", from: [1, 1, 1], to: [3, 3, 3] },
    { op: "mirror", axis: "x", at: 2, ops: [{ op: "mirror", axis: "z", at: 2, ops: [{ op: "line", from: [0, 2, 0], to: [0, 3, 0], block: "trim" }] }] },
    { op: "roof", style: "flat", from: [0, 4, 0], to: [4, 4, 4], block: "roof" },
    { op: "block", at: [2, 5, 2], block: "roof" },
  ];
  return { name: "Village well", palette: paletteOf(palette, { water: "water" }), ops };
}

/**
 * Parametric rules plans. Each returns a VoxelPlan whose footprint starts at the origin (house roofs overhang by one
 * block, so a house(w, d) occupies w+2 x d+2). Use voxelTemplateFor() to size one to a site.
 */
export const VOXEL_TEMPLATES = { house, tower, wall, statue, bridge, farm, well } as const;
export type VoxelTemplateName = keyof typeof VOXEL_TEMPLATES;
export const VOXEL_TEMPLATE_NAMES = Object.keys(VOXEL_TEMPLATES) as VoxelTemplateName[];

/** Size a template to a site [x, y, z]. For statues, `colors` (or the palette) are [shirt, trousers, skin, hair]. */
export function voxelTemplateFor(name: VoxelTemplateName, opts: { size: VoxelVec; palette?: VoxelPaletteInput; colors?: readonly string[] }): VoxelPlan {
  const [sx, sy, sz] = opts.size.map((v) => Math.max(1, Math.round(v)));
  const p = opts.palette;
  switch (name) {
    case "house": {
      const w = clampInt(sx - 2, 4, 24);
      const d = clampInt(sz - 2, 4, 24);
      const layers = Math.ceil((Math.min(w, d) + 2) / 2);
      return house(w, d, clampInt(sy - 1 - layers, 3, 6), p);
    }
    case "tower":
      return tower(Math.min(sx, sz), clampInt(sy - 1, 4, 32), p);
    case "wall":
      return wall(sx, clampInt(sy - 1, 2, 8), p);
    case "statue": {
      const colors = opts.colors ?? (Array.isArray(p) ? (p as readonly string[]) : []);
      const s = clampInt(Math.floor(Math.min((sx - 2) / 4, (sy - 1) / 8, (sz - 2) / 2)), 1, 4);
      return statue(colors, s, Array.isArray(p) ? undefined : p);
    }
    case "bridge":
      return bridge(sx, clampInt(sz - 2, 1, 7), p);
    case "farm":
      return farm(sx, sz, p);
    case "well":
      return well(p);
  }
}

// ---------------------------------------------------------------- prompt -> rules plan

const KEYWORDS: [VoxelTemplateName, RegExp][] = [
  ["statue", /\b(statue|sculpture|monument|likeness|effigy|bust|figure of)\b/],
  ["bridge", /\b(bridge|crossing|footbridge|span)\b/],
  ["farm", /\b(farm|field|crops?|wheat|garden|allotment|plantation|vegetable)\b/],
  ["well", /\b(well|fountain|cistern)\b/],
  ["house", /\b(house|home|hut|cottage|cabin|shack|shelter|inn|tavern|shop|hall|barn|lodge|dwelling|workshop|smithy|bakery|library)\b/],
  ["tower", /\b(tower|turret|lighthouse|keep|spire|watchtower|belfry)\b/],
  ["wall", /\b(wall|walls|rampart|fortification|palisade|barrier|fence|barricade)\b/],
];

const MATERIAL_WORDS: [RegExp, string][] = [
  [/\bstone\b/, "stone_bricks"], [/\bbricks?\b/, "bricks"], [/\bcobble(stone)?\b/, "cobblestone"], [/\bbirch\b/, "birch_planks"],
  [/\bspruce|dark wood\b/, "spruce_planks"], [/\b(oak|wooden|wood|timber)\b/, "oak_planks"], [/\bsand(stone)?|desert\b/, "sand"],
  [/\bsnow|ice\b/, "snow"], [/\bobsidian\b/, "obsidian"], [/\bgold(en)?\b/, "gold_block"], [/\biron\b/, "iron_block"],
  [/\bdiamond\b/, "diamond_block"], [/\bglass\b/, "glass"],
];

/** Keyword -> template (house when nothing matches). */
export function chooseVoxelTemplate(prompt: string): VoxelTemplateName {
  const p = prompt.toLowerCase();
  for (const [name, re] of KEYWORDS) if (re.test(p)) return name;
  return "house";
}

/** Shift every coordinate of ops by d (mirror planes too). */
export function shiftVoxelOps(ops: readonly VoxelOp[], d: VoxelVec): VoxelOp[] {
  const add = (v: VoxelVec): VoxelVec => [v[0] + d[0], v[1] + d[1], v[2] + d[2]];
  return ops.map((o): VoxelOp => {
    switch (o.op) {
      case "repeat": return { ...o, ops: shiftVoxelOps(o.ops, d) };
      case "mirror": return { ...o, at: o.at + (o.axis === "x" ? d[0] : d[2]), ops: shiftVoxelOps(o.ops, d) };
      case "cylinder": case "sphere": return { ...o, center: add(o.center) };
      case "door": case "window": case "block": return { ...o, at: add(o.at) };
      default: return { ...o, from: add(o.from), to: add(o.to) };
    }
  });
}

export interface RulesVoxelPlan {
  plan: VoxelPlan;
  template: VoxelTemplateName | "house+tower";
  /** Rules sentence ("A 7x6 house with a gable roof, 180 blocks: oak_planks, spruce_log, bricks."). */
  summary: string;
}

/**
 * The builder's instant answer: keyword-picked template sized to the site, palette from `palette` (or material words
 * in the prompt, e.g. "stone tower"). "house with a tower" on a wide site combines both. For statues the palette
 * entries are the colours [shirt, trousers, skin, hair].
 */
export function rulesVoxelPlan(params: { prompt: string; size: VoxelVec; palette?: readonly string[] }): RulesVoxelPlan {
  const prompt = (params.prompt ?? "").toLowerCase();
  const size = params.size.map((v) => Math.max(1, Math.round(v))) as VoxelVec;
  let template: RulesVoxelPlan["template"] = chooseVoxelTemplate(prompt);
  let palette: VoxelPaletteInput | undefined = params.palette?.length ? params.palette : undefined;
  if (!palette && template !== "statue") {
    const hit = MATERIAL_WORDS.find(([re]) => re.test(prompt));
    if (hit) palette = template === "tower" || template === "wall" ? { stone: hit[1] } : { wall: hit[1] };
  }
  let plan: VoxelPlan;
  if (template === "house" && /\b(tower|turret)\b/.test(prompt) && size[0] >= 13) {
    const tw = Math.min(5, size[2]);
    const home = voxelTemplateFor("house", { size: [size[0] - tw, size[1], size[2]], palette });
    const tw2 = voxelTemplateFor("tower", { size: [tw, size[1], tw], palette });
    plan = {
      name: "House with a tower",
      palette: { ...tw2.palette, ...home.palette },
      ops: [...home.ops, ...shiftVoxelOps(tw2.ops, [size[0] - tw, 0, Math.max(0, Math.floor((size[2] - tw) / 2))])],
    };
    template = "house+tower";
  } else {
    plan = voxelTemplateFor(template, { size, palette });
  }
  const ex = expandVoxelPlan(plan, { site: size });
  const top = Object.entries(ex.materials).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  const total = Object.values(ex.materials).reduce((a, b) => a + b, 0);
  const span = `${ex.bounds.max[0] - ex.bounds.min[0] + 1}x${ex.bounds.max[2] - ex.bounds.min[2] + 1}`;
  const summary = `${plan.name}: a ${span} ${template.replace("+", " and ")} from the ${template} template, ${total} blocks (mostly ${top.join(", ") || "nothing"}).`;
  return { plan, template, summary };
}

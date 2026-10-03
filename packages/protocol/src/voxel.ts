// Voxel DSL v1 (Livecraft spec §3): a compact, engine-neutral build plan an LLM (or a rules template) writes and a
// game expands into an ordered block list. Pure TypeScript (zod only for the wire schema), so every SDK can reuse it.
//
//   { "name": "Cosy tower house", "palette": {"wall": "oak_planks", "roof": "bricks"},
//     "ops": [ {"op": "hollow_box", "from": [0,0,0], "to": [6,4,5], "block": "wall"},
//              {"op": "roof", "style": "gable", "from": [-1,5,-1], "to": [7,5,6], "block": "roof"},
//              {"op": "door", "at": [3,1,0], "facing": "north"} ] }
//
// Coordinates are integers relative to the site origin; y = 0 is ground level (the floor layer). Axes: +x east,
// +z south, +y up (north = -z). `block` is a palette key or a block id.
// - clampVoxelPlan(raw, limits)   untrusted JSON (LLM output, either the spec form or the flat structured-output form) -> VoxelPlan
// - expandVoxelPlan(plan, opts)   VoxelPlan -> ordered, de-duplicated block list (voxel-expand.ts)
// - voxelPlanJsonSchema()         the Anthropic structured-output schema (flat ops, nullable unused fields)
// - VOXEL_TEMPLATES               parametric rules plans (voxel-templates.ts)
import { z } from "zod";
import { cleanText, clampNum, isObj } from "./common.js";
import { countVoxelCells, normalizeBlockId } from "./voxel-expand.js";

export type VoxelVec = [number, number, number];

/** north = -z, south = +z, east = +x, west = -x. A door's facing is the side it opens toward (outside). */
export const VOXEL_FACINGS = ["north", "south", "east", "west"] as const;
export type VoxelFacing = (typeof VOXEL_FACINGS)[number];
export const VOXEL_ROOF_STYLES = ["gable", "hip", "flat"] as const;
export type VoxelRoofStyle = (typeof VOXEL_ROOF_STYLES)[number];
/** Every op name. `block` (one voxel) is a Liveforge addition to the spec's list. */
export const VOXEL_OPS = [
  "box", "hollow_box", "edges", "line", "cylinder", "sphere", "roof", "door", "window", "stairs", "fill_air", "block", "repeat", "mirror",
] as const;
export type VoxelOpName = (typeof VOXEL_OPS)[number];

/** Default limits (spec §3): ops before / after repeat expansion and blocks. */
export const VOXEL_LIMITS = { maxOps: 60, maxExpandedOps: 200, maxBlocks: 4000, maxRepeat: 32, maxRadius: 24, maxHeight: 128, maxNesting: 2 } as const;

// ---------------------------------------------------------------- op types

/** Solid box from-to (inclusive corners, any order). */
export interface VoxelBoxOp { op: "box"; from: VoxelVec; to: VoxelVec; block: string }
/** The box's shell (walls, floor and ceiling). */
export interface VoxelHollowBoxOp { op: "hollow_box"; from: VoxelVec; to: VoxelVec; block: string }
/** The box's 12 edges (frames, trim). */
export interface VoxelEdgesOp { op: "edges"; from: VoxelVec; to: VoxelVec; block: string }
/** A straight 3D line. */
export interface VoxelLineOp { op: "line"; from: VoxelVec; to: VoxelVec; block: string }
/** Vertical cylinder standing on `center` (its bottom centre), `height` blocks tall; hollow = walls only. */
export interface VoxelCylinderOp { op: "cylinder"; center: VoxelVec; radius: number; height: number; hollow?: boolean; block: string }
/** Sphere around `center`; hollow = shell only. */
export interface VoxelSphereOp { op: "sphere"; center: VoxelVec; radius: number; hollow?: boolean; block: string }
/**
 * Roof over the from-to footprint, starting at from.y. gable: two slopes, ridge along the longer axis (or `axis`),
 * filled end triangles; hip: four slopes (stepped rings); flat: the from-to box.
 */
export interface VoxelRoofOp { op: "roof"; style: VoxelRoofStyle; from: VoxelVec; to: VoxelVec; block: string; axis?: "x" | "z" }
/** A 2-tall opening (air) with a door block in the lower half. Default block "door". */
export interface VoxelDoorOp { op: "door"; at: VoxelVec; facing?: VoxelFacing; block?: string }
/** A single window block (default "glass"). */
export interface VoxelWindowOp { op: "window"; at: VoxelVec; block?: string }
/** One step per layer from `from` up (or down) to `to`, along the longer horizontal axis; the other axis is the width. */
export interface VoxelStairsOp { op: "stairs"; from: VoxelVec; to: VoxelVec; block: string }
/** Clear a box (air): interiors, doorways, terrain inside a footprint. */
export interface VoxelFillAirOp { op: "fill_air"; from: VoxelVec; to: VoxelVec }
/** One block (torch, chest, bed ...). */
export interface VoxelBlockOp { op: "block"; at: VoxelVec; block: string }
/** Run `ops` `count` times, offset by step * i (i = 0..count-1). */
export interface VoxelRepeatOp { op: "repeat"; count: number; step: VoxelVec; ops: VoxelOp[] }
/** Run `ops`, plus a copy mirrored across the plane axis = at (x' = 2*at - x; .5 planes allowed for even widths). */
export interface VoxelMirrorOp { op: "mirror"; axis: "x" | "z"; at: number; ops: VoxelOp[] }

export type VoxelOp =
  | VoxelBoxOp | VoxelHollowBoxOp | VoxelEdgesOp | VoxelLineOp | VoxelCylinderOp | VoxelSphereOp | VoxelRoofOp
  | VoxelDoorOp | VoxelWindowOp | VoxelStairsOp | VoxelFillAirOp | VoxelBlockOp | VoxelRepeatOp | VoxelMirrorOp;

/** A build plan. `palette` maps short keys ("wall") to block ids ("oak_planks"); ops reference either. */
export interface VoxelPlan {
  name: string;
  palette: Record<string, string>;
  ops: VoxelOp[];
  /** One-sentence description (LLM plans fill it). */
  summary?: string;
}

// ---------------------------------------------------------------- zod (wire validation + JSON Schema emit)

const Coord = z.number().int().min(-512).max(512);
const V3 = z.tuple([Coord, Coord, Coord]);
const BlockRef = z.string().min(1).max(64);
const FromTo = { from: V3, to: V3 };

export const VoxelOp: z.ZodType<VoxelOp> = z.lazy(() =>
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("box"), ...FromTo, block: BlockRef }),
    z.object({ op: z.literal("hollow_box"), ...FromTo, block: BlockRef }),
    z.object({ op: z.literal("edges"), ...FromTo, block: BlockRef }),
    z.object({ op: z.literal("line"), ...FromTo, block: BlockRef }),
    z.object({ op: z.literal("cylinder"), center: V3, radius: z.number().int().min(1).max(VOXEL_LIMITS.maxRadius), height: z.number().int().min(1).max(VOXEL_LIMITS.maxHeight), hollow: z.boolean().optional(), block: BlockRef }),
    z.object({ op: z.literal("sphere"), center: V3, radius: z.number().int().min(1).max(VOXEL_LIMITS.maxRadius), hollow: z.boolean().optional(), block: BlockRef }),
    z.object({ op: z.literal("roof"), style: z.enum(VOXEL_ROOF_STYLES), ...FromTo, block: BlockRef, axis: z.enum(["x", "z"]).optional() }),
    z.object({ op: z.literal("door"), at: V3, facing: z.enum(VOXEL_FACINGS).optional(), block: BlockRef.optional() }),
    z.object({ op: z.literal("window"), at: V3, block: BlockRef.optional() }),
    z.object({ op: z.literal("stairs"), ...FromTo, block: BlockRef }),
    z.object({ op: z.literal("fill_air"), ...FromTo }),
    z.object({ op: z.literal("block"), at: V3, block: BlockRef }),
    z.object({ op: z.literal("repeat"), count: z.number().int().min(1).max(VOXEL_LIMITS.maxRepeat), step: V3, ops: z.array(VoxelOp).max(VOXEL_LIMITS.maxOps) }),
    z.object({ op: z.literal("mirror"), axis: z.enum(["x", "z"]), at: z.number(), ops: z.array(VoxelOp).max(VOXEL_LIMITS.maxOps) }),
  ]),
);

export const VoxelPlan: z.ZodType<VoxelPlan> = z.object({
  name: z.string().max(80),
  palette: z.record(z.string(), z.string()),
  ops: z.array(VoxelOp).max(VOXEL_LIMITS.maxOps),
  summary: z.string().max(300).optional(),
});

/** One expanded voxel (world coordinates when `origin` was passed to expandVoxelPlan). `block` "air" = clear it. */
export const VoxelBlock = z.object({
  x: z.number().int(), y: z.number().int(), z: z.number().int(),
  block: z.string(),
  /** Doors and stairs: which way they face. */
  facing: z.enum(VOXEL_FACINGS).optional(),
});
export type VoxelBlock = z.infer<typeof VoxelBlock>;

/** expandVoxelPlan output: blocks in build order (layer by layer, structure first, details, then air). */
export const ExpandedPlan = z.object({
  blocks: z.array(VoxelBlock),
  /** block id -> count (air excluded). */
  materials: z.record(z.string(), z.number().int()),
  bounds: z.object({ min: z.tuple([z.number(), z.number(), z.number()]), max: z.tuple([z.number(), z.number(), z.number()]) }),
  warnings: z.array(z.string()),
});
export type ExpandedPlan = z.infer<typeof ExpandedPlan>;

// ---------------------------------------------------------------- clamp (untrusted input -> VoxelPlan)

export interface VoxelClampOptions {
  /** Max op nodes (repeat / mirror and their children each count). Default 60. */
  maxOps?: number;
  /** Max primitive ops after repeat / mirror expansion. Default 200. */
  maxExpandedOps?: number;
  /** Max non-air blocks; trailing ops are dropped until the plan fits. Default 4000. */
  maxBlocks?: number;
  /** Site size [x, y, z]: corners are clamped into 0..size-1 (box ops are trimmed to the site). */
  site?: VoxelVec;
}

const OP_ALIASES: Record<string, VoxelOpName> = {
  cube: "box", fill: "box", solid: "box", hollow: "hollow_box", hollowbox: "hollow_box", shell: "hollow_box", walls: "hollow_box",
  frame: "edges", outline: "edges", air: "fill_air", clear: "fill_air", carve: "fill_air", cyl: "cylinder", tower: "cylinder",
  ball: "sphere", dome: "sphere", stair: "stairs", staircase: "stairs", set: "block", single: "block", place: "block", torch: "block",
  loop: "repeat", array: "repeat", symmetry: "mirror", flip: "mirror",
};

const LEAF_OPS = new Set<VoxelOpName>(["box", "hollow_box", "edges", "line", "cylinder", "sphere", "roof", "door", "window", "stairs", "fill_air", "block"]);

function clampPalette(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (k: unknown, b: unknown) => {
    const key = normalizeBlockId(k);
    const block = normalizeBlockId(b);
    if (key && block && Object.keys(out).length < 16) out[key] = block;
  };
  if (Array.isArray(v)) {
    for (const e of v) if (isObj(e)) add(e.key ?? e.name ?? e.role, e.block ?? e.id ?? e.value);
  } else if (isObj(v)) {
    for (const [k, b] of Object.entries(v)) add(k, b);
  }
  return out;
}

interface ClampState {
  nodes: number;
  expanded: number;
  maxOps: number;
  maxExpanded: number;
  site: VoxelVec | null;
  defaultBlock: string;
}

const LOOSE = 256;

function vecOf(v: unknown): VoxelVec | null {
  let a: unknown[] | null = null;
  if (Array.isArray(v)) a = v;
  else if (isObj(v)) a = [v.x, v.y, v.z];
  if (!a || a.length < 3) return null;
  const n = a.slice(0, 3).map((x) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x) : typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x)) ? Math.round(Number(x)) : NaN));
  return n.some((x) => Number.isNaN(x)) ? null : [n[0], n[1], n[2]];
}

/** Clamp a point into the site (or a loose sanity range without one). */
function inSite(p: VoxelVec, s: ClampState): VoxelVec {
  if (!s.site) return p.map((x) => Math.max(-LOOSE, Math.min(LOOSE, x))) as VoxelVec;
  return p.map((x, i) => Math.max(0, Math.min(s.site![i] - 1, x))) as VoxelVec;
}

function blockOf(v: unknown, s: ClampState, fallback?: string): string {
  return normalizeBlockId(v) || fallback || s.defaultBlock;
}

/** Number of primitive ops a raw op list expands to (repeat * count, mirror * 2), capped. */
function rawLeafCount(list: unknown, depth = 0): number {
  if (!Array.isArray(list) || depth > 3) return 0;
  let n = 0;
  for (const o of list.slice(0, 200)) {
    if (!isObj(o)) continue;
    const name = opName(o.op);
    if (name === "repeat") n += Math.max(1, Math.min(VOXEL_LIMITS.maxRepeat, Math.round(clampNum(o.count, 1, VOXEL_LIMITS.maxRepeat, 1)))) * rawLeafCount(o.ops, depth + 1);
    else if (name === "mirror") n += 2 * rawLeafCount(o.ops, depth + 1);
    else if (name) n += 1;
    if (n > 10_000) return n;
  }
  return n;
}

function opName(v: unknown): VoxelOpName | null {
  const k = typeof v === "string" ? v.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if ((VOXEL_OPS as readonly string[]).includes(k)) return k as VoxelOpName;
  return OP_ALIASES[k.replace(/_/g, "")] ?? OP_ALIASES[k] ?? null;
}

function clampLeaf(name: VoxelOpName, o: Record<string, unknown>, s: ClampState): VoxelOp | null {
  const from = vecOf(o.from ?? o.start ?? o.min);
  const to = vecOf(o.to ?? o.end ?? o.max);
  const at = vecOf(o.at ?? o.pos ?? o.position);
  const center = vecOf(o.center ?? o.at ?? o.pos);
  const block = blockOf(o.block, s);
  const box = () => (from && to ? { from: inSite(from, s), to: inSite(to, s) } : null);
  const maxH = s.site ? s.site[1] : VOXEL_LIMITS.maxHeight;
  const maxR = s.site ? Math.max(1, Math.min(VOXEL_LIMITS.maxRadius, Math.ceil(Math.max(s.site[0], s.site[2]) / 2) + 1)) : VOXEL_LIMITS.maxRadius;
  switch (name) {
    case "box": case "hollow_box": case "edges": case "line": case "stairs": {
      const b = box();
      return b ? { op: name, ...b, block } : null;
    }
    case "fill_air": {
      const b = box();
      return b ? { op: "fill_air", ...b } : null;
    }
    case "roof": {
      const b = box();
      if (!b) return null;
      const style = (VOXEL_ROOF_STYLES as readonly string[]).includes(String(o.style)) ? (o.style as VoxelRoofStyle) : "gable";
      const axis = o.axis === "x" || o.axis === "z" ? o.axis : undefined;
      return { op: "roof", style, ...b, block, ...(axis ? { axis } : {}) };
    }
    case "cylinder": {
      if (!center) return null;
      const radius = Math.round(clampNum(o.radius ?? o.r, 1, maxR, 2));
      const height = Math.round(clampNum(o.height ?? o.h, 1, maxH, 4));
      return { op: "cylinder", center: inSite(center, s), radius, height, ...(o.hollow === true ? { hollow: true } : {}), block };
    }
    case "sphere": {
      if (!center) return null;
      const radius = Math.round(clampNum(o.radius ?? o.r, 1, maxR, 2));
      return { op: "sphere", center: inSite(center, s), radius, ...(o.hollow === true ? { hollow: true } : {}), block };
    }
    case "door": {
      if (!at) return null;
      const facing = (VOXEL_FACINGS as readonly string[]).includes(String(o.facing)) ? (o.facing as VoxelFacing) : undefined;
      const b = normalizeBlockId(o.block);
      return { op: "door", at: inSite(at, s), ...(facing ? { facing } : {}), ...(b ? { block: b } : {}) };
    }
    case "window": {
      if (!at) return null;
      const b = normalizeBlockId(o.block);
      return { op: "window", at: inSite(at, s), ...(b ? { block: b } : {}) };
    }
    case "block": {
      const p = at ?? center;
      if (!p) return null;
      return { op: "block", at: inSite(p, s), block: blockOf(o.block, s, typeof o.op === "string" && o.op.toLowerCase() === "torch" ? "torch" : undefined) };
    }
    default:
      return null;
  }
}

function clampOps(list: unknown, s: ClampState, depth: number, mult: number): VoxelOp[] {
  const out: VoxelOp[] = [];
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    if (s.nodes >= s.maxOps || s.expanded >= s.maxExpanded) break;
    if (!isObj(raw)) continue;
    const name = opName(raw.op ?? raw.type);
    if (!name) continue;
    if (LEAF_OPS.has(name)) {
      if (s.expanded + mult > s.maxExpanded) break;
      const op = clampLeaf(name, raw, s);
      if (!op) continue;
      s.nodes++;
      s.expanded += mult;
      out.push(op);
      continue;
    }
    if (depth >= VOXEL_LIMITS.maxNesting) continue;
    const leaves = Math.max(1, rawLeafCount(raw.ops, depth + 1));
    const room = Math.floor((s.maxExpanded - s.expanded) / (mult * leaves));
    if (name === "repeat") {
      const step = vecOf(raw.step ?? raw.offset) ?? [1, 0, 0];
      const count = Math.min(Math.round(clampNum(raw.count ?? raw.times, 1, VOXEL_LIMITS.maxRepeat, 1)), Math.max(1, room));
      s.nodes++;
      const ops = clampOps(raw.ops, s, depth + 1, mult * count);
      if (ops.length) out.push({ op: "repeat", count, step: step.map((x) => Math.max(-64, Math.min(64, x))) as VoxelVec, ops });
    } else if (name === "mirror") {
      const axis: "x" | "z" = raw.axis === "z" ? "z" : "x";
      const atRaw = raw.at ?? raw.plane;
      const atVec = vecOf(atRaw);
      const atNum = typeof atRaw === "number" && Number.isFinite(atRaw) ? atRaw : atVec ? atVec[axis === "x" ? 0 : 2] : NaN;
      if (!Number.isFinite(atNum)) continue;
      const at = Math.round(Math.max(-LOOSE, Math.min(LOOSE, atNum)) * 2) / 2;
      s.nodes++;
      const ops = clampOps(raw.ops, s, depth + 1, mult * 2);
      if (ops.length) out.push({ op: "mirror", axis, at, ops });
    }
  }
  return out;
}

/**
 * Turns untrusted JSON (an LLM answer in the spec form or the flat structured-output form of voxelPlanJsonSchema, or
 * a JSON string) into a valid VoxelPlan: unknown ops dropped, coordinates rounded and clamped to the site, limits
 * enforced (op count, expanded op count, block count). Never throws.
 */
export function clampVoxelPlan(raw: unknown, opts: VoxelClampOptions = {}): VoxelPlan {
  let r: unknown = raw;
  if (typeof r === "string") {
    try { r = JSON.parse(r); } catch { r = null; }
  }
  if (!isObj(r)) return { name: "Empty plan", palette: {}, ops: [] };
  const palette = clampPalette(r.palette);
  const site = opts.site ? (opts.site.map((x) => Math.max(1, Math.min(LOOSE, Math.round(x)))) as VoxelVec) : null;
  const state: ClampState = {
    nodes: 0,
    expanded: 0,
    maxOps: Math.max(1, Math.round(opts.maxOps ?? VOXEL_LIMITS.maxOps)),
    maxExpanded: Math.max(1, Math.round(opts.maxExpandedOps ?? VOXEL_LIMITS.maxExpandedOps)),
    site,
    defaultBlock: Object.keys(palette)[0] ?? "stone",
  };
  const plan: VoxelPlan = {
    name: cleanText(r.name ?? r.title, 64) || "Untitled build",
    palette,
    ops: clampOps(r.ops ?? r.operations, state, 0, 1),
  };
  const summary = cleanText(r.summary ?? r.description, 300);
  if (summary) plan.summary = summary;
  const maxBlocks = Math.max(1, Math.round(opts.maxBlocks ?? VOXEL_LIMITS.maxBlocks));
  for (let guard = 0; guard < VOXEL_LIMITS.maxOps && plan.ops.length; guard++) {
    if (countVoxelCells(plan, site ?? undefined) <= maxBlocks) break;
    plan.ops.pop();
  }
  return plan;
}

// ---------------------------------------------------------------- structured-output schema (flat)

/**
 * JSON Schema for an LLM VoxelPlan answer in the Anthropic structured-output subset: every object has
 * additionalProperties:false and every property required. Ops are flat objects carrying every field (null when
 * unused); repeat / mirror nest one level of the same flat op. Always pass the answer through clampVoxelPlan.
 */
export function voxelPlanJsonSchema(): Record<string, unknown> {
  const str = { type: "string" };
  const nul = (s: Record<string, unknown>) => ({ anyOf: [s, { type: "null" }] });
  const obj = (properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, properties, required: Object.keys(properties) });
  const vec = { type: "array", items: { type: "number" } };
  const fields = {
    op: { type: "string", enum: [...VOXEL_OPS] },
    from: nul(vec),
    to: nul(vec),
    at: nul(vec),
    center: nul(vec),
    radius: nul({ type: "integer" }),
    height: nul({ type: "integer" }),
    hollow: nul({ type: "boolean" }),
    style: nul({ type: "string", enum: [...VOXEL_ROOF_STYLES] }),
    axis: nul({ type: "string", enum: ["x", "z"] }),
    facing: nul({ type: "string", enum: [...VOXEL_FACINGS] }),
    count: nul({ type: "integer" }),
    step: nul(vec),
    block: nul(str),
  };
  const inner = obj(fields);
  const outer = obj({ ...fields, ops: nul({ type: "array", items: inner }) });
  return obj({
    name: str,
    summary: str,
    palette: { type: "array", items: obj({ key: str, block: str }) },
    ops: { type: "array", items: outer },
  });
}

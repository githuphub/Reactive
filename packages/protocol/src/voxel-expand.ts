// Voxel DSL expansion: VoxelPlan -> ordered, de-duplicated block list. Deterministic: same plan + options, same
// output. Pure TypeScript, no dependencies (types only from voxel.ts).
import type { ExpandedPlan, VoxelBlock, VoxelFacing, VoxelOp, VoxelPlan, VoxelVec } from "./voxel.js";

/** Block id / palette key hygiene: lowercase, spaces -> _, no "minecraft:"-style namespace, only [a-z0-9_]. */
export function normalizeBlockId(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.trim().toLowerCase().replace(/^[a-z0-9_]+:/, "").replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 48);
}

/**
 * Built-in aliases for common LLM block words -> candidate ids (the first one the game knows wins). Used only when
 * `blockIds` is passed to expandVoxelPlan; caller `aliases` take precedence.
 */
export const DEFAULT_VOXEL_ALIASES: Record<string, string[]> = {
  wood: ["oak_planks", "planks"], planks: ["oak_planks"], plank: ["oak_planks"], wood_planks: ["oak_planks"], wooden_planks: ["oak_planks"],
  log: ["oak_log"], wood_log: ["oak_log"], trunk: ["oak_log"], beam: ["oak_log", "spruce_log"], timber: ["spruce_log", "oak_log"],
  brick: ["bricks"], red_bricks: ["bricks"], brick_block: ["bricks"], clay_bricks: ["bricks"],
  stone_brick: ["stone_bricks"], stonebrick: ["stone_bricks"], castle_stone: ["stone_bricks"], slab: ["stone_bricks", "cobblestone"],
  cobble: ["cobblestone"], cobblestone_wall: ["cobblestone"], rubble: ["cobblestone"], rock: ["stone"],
  glass_pane: ["glass"], pane: ["glass"], window: ["glass"], glass_block: ["glass"],
  leaves: ["oak_leaves"], leaf: ["oak_leaves"], hedge: ["oak_leaves"],
  wool: ["white_wool"], carpet: ["white_wool"], cloth: ["white_wool"],
  wooden_door: ["door", "oak_door"], oak_door: ["door"], door_block: ["door"],
  lamp: ["torch", "lantern"], lantern: ["torch"], light: ["torch"], torches: ["torch"], wall_torch: ["torch"],
  roof_tiles: ["bricks"], tiles: ["bricks"], shingles: ["spruce_planks", "bricks"], roof: ["bricks"],
  thatch: ["hay", "hay_block"], straw: ["hay", "hay_block"], hay_bale: ["hay", "hay_block"], hay_block: ["hay"],
  grass_block: ["grass"], lawn: ["grass"], soil: ["dirt"], mud: ["dirt"],
  path: ["gravel"], gravel_path: ["gravel"], road: ["gravel", "cobblestone"],
  fence: ["oak_fence", "fence", "oak_log"], railing: ["oak_fence", "fence", "oak_log"], post: ["oak_log"],
  marble: ["quartz_block", "stone_bricks"], quartz: ["quartz_block", "stone_bricks"],
  gold: ["gold_block"], iron: ["iron_block"], diamond: ["diamond_block"],
  water_source: ["water"], pool: ["water"], fire: ["torch"],
  crops: ["wheat"], crop: ["wheat"], farmland_block: ["farmland"], tilled_soil: ["farmland"],
};

/** expandVoxelPlan options. */
export interface VoxelExpandOptions {
  /** Site size [x, y, z]: blocks outside 0..size-1 are dropped (with a warning). */
  site?: VoxelVec;
  /** Added to every output coordinate (e.g. the plot's world position). Applied after site clipping. */
  origin?: VoxelVec;
  /** Block ids the game knows. Unknown ids map to the nearest known one (aliases, then name similarity), else `fallback`. */
  blockIds?: readonly string[];
  /** Extra aliases: word -> block id (checked before the built-in DEFAULT_VOXEL_ALIASES). */
  aliases?: Record<string, string>;
  /** Block for unresolvable ids (default: the palette's first entry, else the first of blockIds). */
  fallback?: string;
  /** Max non-air blocks in the output (later layers are dropped). Default 4000. */
  maxBlocks?: number;
}

const MAX_CELLS = 120_000;
const MAX_PRIMITIVES = 1_000;
const MAX_SPAN = 128;
const DETAIL_ID = /torch|lantern|ladder|door|sign|button|lever|carpet|flower/;

interface Cell {
  x: number;
  y: number;
  z: number;
  ref: string;
  detail: boolean;
  facing?: VoxelFacing;
  seq: number;
}

type Xf = { p: (x: number, y: number, z: number) => VoxelVec; f: (f: VoxelFacing | undefined) => VoxelFacing | undefined };
const IDENTITY: Xf = { p: (x, y, z) => [x, y, z], f: (f) => f };

class Grid {
  readonly cells = new Map<string, Cell>();
  private seq = 0;
  primitives = 0;
  truncated = false;
  put(xf: Xf, x: number, y: number, z: number, ref: string, detail = false, facing?: VoxelFacing): void {
    const [px, py, pz] = xf.p(x, y, z);
    const key = `${px},${py},${pz}`;
    const prev = this.cells.get(key);
    if (!prev && this.cells.size >= MAX_CELLS) {
      this.truncated = true;
      return;
    }
    const fc = xf.f(facing);
    this.cells.set(key, { x: px, y: py, z: pz, ref, detail, ...(fc ? { facing: fc } : {}), seq: this.seq++ });
  }
}

const sgn = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);
const span = (a: number, b: number): [number, number] => {
  const lo = Math.min(a, b);
  return [lo, Math.min(Math.max(a, b), lo + MAX_SPAN - 1)];
};

function forBox(from: VoxelVec, to: VoxelVec, fn: (x: number, y: number, z: number, edge: number) => void): void {
  const [x0, x1] = span(from[0], to[0]);
  const [y0, y1] = span(from[1], to[1]);
  const [z0, z1] = span(from[2], to[2]);
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    // edge = how many of the 3 axes are at a boundary (1 = face, 2 = edge, 3 = corner)
    fn(x, y, z, Number(x === x0 || x === x1) + Number(y === y0 || y === y1) + Number(z === z0 || z === z1));
  }
}

function forLine(a: VoxelVec, b: VoxelVec, fn: (x: number, y: number, z: number) => void): void {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const n = Math.min(MAX_SPAN * 2, Math.max(Math.abs(d[0]), Math.abs(d[1]), Math.abs(d[2])));
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    fn(Math.round(a[0] + d[0] * t), Math.round(a[1] + d[1] * t), Math.round(a[2] + d[2] * t));
  }
}

const inDisc = (d2: number, r: number) => r >= 0 && d2 <= r * r + r;

const FACING_X: Record<number, VoxelFacing> = { 1: "east", [-1]: "west" };
const FACING_Z: Record<number, VoxelFacing> = { 1: "south", [-1]: "north" };

function emit(op: VoxelOp, xf: Xf, g: Grid, depth: number): void {
  if (g.primitives >= MAX_PRIMITIVES || depth > 4) return;
  const put = (x: number, y: number, z: number, ref: string, detail = false, facing?: VoxelFacing) => g.put(xf, x, y, z, ref, detail, facing);
  switch (op.op) {
    case "box":
      g.primitives++;
      forBox(op.from, op.to, (x, y, z) => put(x, y, z, op.block));
      return;
    case "hollow_box":
      g.primitives++;
      forBox(op.from, op.to, (x, y, z, e) => e >= 1 && put(x, y, z, op.block));
      return;
    case "edges":
      g.primitives++;
      forBox(op.from, op.to, (x, y, z, e) => e >= 2 && put(x, y, z, op.block));
      return;
    case "fill_air":
      g.primitives++;
      forBox(op.from, op.to, (x, y, z) => put(x, y, z, "air"));
      return;
    case "line":
      g.primitives++;
      forLine(op.from, op.to, (x, y, z) => put(x, y, z, op.block));
      return;
    case "cylinder": {
      g.primitives++;
      const [cx, cy, cz] = op.center;
      const r = Math.max(1, Math.min(32, Math.round(op.radius)));
      const h = Math.max(1, Math.min(MAX_SPAN, Math.round(op.height)));
      for (let y = cy; y < cy + h; y++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dz * dz;
        if (inDisc(d2, r) && !(op.hollow && inDisc(d2, r - 1))) put(cx + dx, y, cz + dz, op.block);
      }
      return;
    }
    case "sphere": {
      g.primitives++;
      const [cx, cy, cz] = op.center;
      const r = Math.max(1, Math.min(32, Math.round(op.radius)));
      for (let dy = -r; dy <= r; dy++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dy * dy + dz * dz;
        if (inDisc(d2, r) && !(op.hollow && inDisc(d2, r - 1))) put(cx + dx, cy + dy, cz + dz, op.block);
      }
      return;
    }
    case "roof": {
      g.primitives++;
      const [x0, x1] = span(op.from[0], op.to[0]);
      const [z0, z1] = span(op.from[2], op.to[2]);
      const y0 = Math.min(op.from[1], op.to[1]);
      if (op.style === "flat") {
        forBox(op.from, op.to, (x, y, z) => put(x, y, z, op.block));
        return;
      }
      if (op.style === "hip") {
        for (let k = 0; k < MAX_SPAN; k++) {
          const xa = x0 + k, xb = x1 - k, za = z0 + k, zb = z1 - k;
          if (xa > xb || za > zb) break;
          for (let x = xa; x <= xb; x++) { put(x, y0 + k, za, op.block); put(x, y0 + k, zb, op.block); }
          for (let z = za; z <= zb; z++) { put(xa, y0 + k, z, op.block); put(xb, y0 + k, z, op.block); }
        }
        return;
      }
      // gable: ridge along the longer axis (or op.axis); slopes on the long sides, filled end triangles
      const ridgeX = op.axis ? op.axis === "x" : x1 - x0 >= z1 - z0;
      for (let k = 0; k < MAX_SPAN; k++) {
        const y = y0 + k;
        if (ridgeX) {
          const za = z0 + k, zb = z1 - k;
          if (za > zb) break;
          for (let x = x0; x <= x1; x++) { put(x, y, za, op.block); put(x, y, zb, op.block); }
          for (let z = za + 1; z < zb; z++) { put(x0, y, z, op.block); put(x1, y, z, op.block); }
        } else {
          const xa = x0 + k, xb = x1 - k;
          if (xa > xb) break;
          for (let z = z0; z <= z1; z++) { put(xa, y, z, op.block); put(xb, y, z, op.block); }
          for (let x = xa + 1; x < xb; x++) { put(x, y, z0, op.block); put(x, y, z1, op.block); }
        }
      }
      return;
    }
    case "door": {
      g.primitives++;
      const [x, y, z] = op.at;
      put(x, y, z, "air");
      put(x, y + 1, z, "air");
      put(x, y, z, op.block ?? "door", true, op.facing);
      return;
    }
    case "window":
      g.primitives++;
      put(op.at[0], op.at[1], op.at[2], op.block ?? "glass", true);
      return;
    case "block":
      g.primitives++;
      put(op.at[0], op.at[1], op.at[2], op.block);
      return;
    case "stairs": {
      g.primitives++;
      const d = [op.to[0] - op.from[0], op.to[1] - op.from[1], op.to[2] - op.from[2]];
      const runX = Math.abs(d[0]) >= Math.abs(d[2]);
      const run = runX ? d[0] : d[2];
      const [w0, w1] = span(runX ? op.from[2] : op.from[0], runX ? op.to[2] : op.to[0]);
      const steps = Math.min(MAX_SPAN, Math.max(Math.abs(d[1]), Math.abs(run)));
      const up = d[1] >= 0 ? sgn(run) : -sgn(run);
      const facing = up === 0 ? undefined : runX ? FACING_X[up] : FACING_Z[up];
      for (let i = 0; i <= steps; i++) {
        const r = (runX ? op.from[0] : op.from[2]) + sgn(run) * Math.min(i, Math.abs(run));
        const y = op.from[1] + sgn(d[1]) * Math.min(i, Math.abs(d[1]));
        for (let w = w0; w <= w1; w++) runX ? put(r, y, w, op.block, true, facing) : put(w, y, r, op.block, true, facing);
      }
      return;
    }
    case "repeat": {
      const count = Math.max(1, Math.min(64, Math.round(op.count)));
      for (let i = 0; i < count; i++) {
        const [sx, sy, sz] = [op.step[0] * i, op.step[1] * i, op.step[2] * i];
        const inner: Xf = { p: (x, y, z) => xf.p(x + sx, y + sy, z + sz), f: xf.f };
        for (const o of op.ops) emit(o, inner, g, depth + 1);
      }
      return;
    }
    case "mirror": {
      for (const o of op.ops) emit(o, xf, g, depth + 1);
      const swap: Record<string, VoxelFacing> = op.axis === "x" ? { east: "west", west: "east" } : { north: "south", south: "north" };
      const mirrored: Xf = {
        p: (x, y, z) => (op.axis === "x" ? xf.p(Math.round(2 * op.at - x), y, z) : xf.p(x, y, Math.round(2 * op.at - z))),
        f: (f) => xf.f(f ? (swap[f] ?? f) : f),
      };
      for (const o of op.ops) emit(o, mirrored, g, depth + 1);
      return;
    }
  }
}

function collect(plan: VoxelPlan): Grid {
  const g = new Grid();
  for (const op of plan.ops ?? []) emit(op, IDENTITY, g, 0);
  return g;
}

const insideSite = (c: { x: number; y: number; z: number }, site?: VoxelVec) =>
  !site || (c.x >= 0 && c.y >= 0 && c.z >= 0 && c.x < site[0] && c.y < site[1] && c.z < site[2]);

/** Non-air cells a plan produces inside the site (palette refs resolved, no block-id mapping). Used by clamp. */
export function countVoxelCells(plan: VoxelPlan, site?: VoxelVec): number {
  let n = 0;
  for (const c of collect(plan).cells.values()) {
    if (!insideSite(c, site)) continue;
    const id = normalizeBlockId(plan.palette?.[c.ref] ?? c.ref);
    if (id !== "air") n++;
  }
  return n;
}

const AIR_IDS = new Set(["air", "cave_air", "void", "void_air", "empty", "none"]);

/** Builds the palette-ref -> block-id resolver (palette lookup, then known-id mapping). */
function resolver(palette: Record<string, string>, opts: VoxelExpandOptions, warnings: string[]): (ref: string) => string {
  const known = opts.blockIds?.length ? opts.blockIds.map(normalizeBlockId).filter(Boolean) : null;
  const knownSet = known ? new Set(known) : null;
  const userAliases: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.aliases ?? {})) userAliases[normalizeBlockId(k)] = normalizeBlockId(v);
  const cache = new Map<string, string>();
  const tokens = (id: string) => id.split("_").filter((t) => t.length > 1 && t !== "block");
  const nearest = (id: string): string | null => {
    if (!known) return null;
    const mine = tokens(id);
    let best: string | null = null;
    let bestScore = 0;
    for (const cand of known) {
      const theirs = tokens(cand);
      let score = 0;
      for (const t of mine) {
        if (theirs.includes(t)) score += 1;
        else if (t.length >= 4 && theirs.some((u) => u.length >= 4 && (u.startsWith(t) || t.startsWith(u)))) score += 0.5;
      }
      score -= 0.01 * Math.abs(theirs.length - mine.length);
      if (score > bestScore) { bestScore = score; best = cand; }
    }
    return bestScore >= 0.5 ? best : null;
  };
  const toKnown = (id: string): string | null => {
    if (!knownSet) return id;
    if (knownSet.has(id)) return id;
    const cands = [userAliases[id], ...(DEFAULT_VOXEL_ALIASES[id] ?? []), `${id}s`, id.replace(/s$/, ""), id.replace(/_block$/, ""), `${id}_block`];
    for (const c of cands) if (c && knownSet.has(c)) return c;
    return nearest(id);
  };
  const fallbackId = (): string => {
    const f = normalizeBlockId(opts.fallback);
    if (f && (!knownSet || knownSet.has(f))) return f;
    const first = normalizeBlockId(Object.values(palette)[0]);
    const firstKnown = first ? toKnown(first) : null;
    if (firstKnown && !AIR_IDS.has(firstKnown)) return firstKnown;
    return known?.[0] ?? "stone";
  };
  return (ref: string) => {
    const hit = cache.get(ref);
    if (hit) return hit;
    const raw = normalizeBlockId(palette[ref] ?? palette[normalizeBlockId(ref)] ?? ref);
    let id: string;
    if (AIR_IDS.has(raw)) id = "air";
    else if (!raw) id = fallbackId();
    else {
      const k = toKnown(raw);
      if (k) {
        if (k !== raw) warnings.push(`block "${raw}" mapped to "${k}"`);
        id = k;
      } else {
        id = fallbackId();
        warnings.push(`unknown block "${raw}", using "${id}"`);
      }
    }
    cache.set(ref, id);
    return id;
  };
}

/**
 * Expands a plan into an ordered block list: de-duplicated (last write wins), sorted by layer (y ascending), then
 * structure before details (doors, windows, stairs, torches), then air in that layer; ties keep write order.
 * Block refs resolve through the palette, then (with `blockIds`) to the nearest known id. Deterministic.
 *
 * ```ts
 * const { blocks, materials } = expandVoxelPlan(plan, { site: [12, 16, 12], origin: [plotX, groundY, plotZ], blockIds });
 * for (const b of blocks) world.set(b.x, b.y, b.z, b.block);
 * ```
 */
export function expandVoxelPlan(plan: VoxelPlan, opts: VoxelExpandOptions = {}): ExpandedPlan {
  const warnings: string[] = [];
  const g = collect(plan);
  if (g.truncated) warnings.push(`plan too large: stopped at ${MAX_CELLS} cells`);
  if (g.primitives >= MAX_PRIMITIVES) warnings.push(`plan too large: stopped at ${MAX_PRIMITIVES} primitive ops`);
  const resolve = resolver(plan.palette ?? {}, opts, warnings);
  type Out = VoxelBlock & { cat: number; seq: number };
  const out: Out[] = [];
  let clipped = 0;
  for (const c of g.cells.values()) {
    if (!insideSite(c, opts.site)) { clipped++; continue; }
    const block = resolve(c.ref);
    const cat = block === "air" ? 2 : c.detail || DETAIL_ID.test(block) ? 1 : 0;
    out.push({ x: c.x, y: c.y, z: c.z, block, ...(c.facing ? { facing: c.facing } : {}), cat, seq: c.seq });
  }
  if (clipped) warnings.push(`${clipped} block(s) outside the site were dropped`);
  out.sort((a, b) => a.y - b.y || a.cat - b.cat || a.seq - b.seq);
  const maxBlocks = Math.max(0, Math.round(opts.maxBlocks ?? 4000));
  const [ox, oy, oz] = opts.origin ?? [0, 0, 0];
  const blocks: VoxelBlock[] = [];
  const materials: Record<string, number> = {};
  let solid = 0;
  let dropped = 0;
  const min: VoxelVec = [Infinity, Infinity, Infinity];
  const max: VoxelVec = [-Infinity, -Infinity, -Infinity];
  for (const b of out) {
    if (b.block !== "air") {
      if (solid >= maxBlocks) { dropped++; continue; }
      solid++;
      materials[b.block] = (materials[b.block] ?? 0) + 1;
    } else if (dropped) continue;
    const v: VoxelBlock = { x: b.x + ox, y: b.y + oy, z: b.z + oz, block: b.block, ...(b.facing ? { facing: b.facing } : {}) };
    blocks.push(v);
    if (b.block !== "air") {
      min[0] = Math.min(min[0], v.x); min[1] = Math.min(min[1], v.y); min[2] = Math.min(min[2], v.z);
      max[0] = Math.max(max[0], v.x); max[1] = Math.max(max[1], v.y); max[2] = Math.max(max[2], v.z);
    }
  }
  if (dropped) warnings.push(`${dropped} block(s) over the ${maxBlocks}-block limit were dropped`);
  const bounds = solid ? { min, max } : { min: [ox, oy, oz] as VoxelVec, max: [ox, oy, oz] as VoxelVec };
  return { blocks, materials, bounds, warnings: [...new Set(warnings)] };
}

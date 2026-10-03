/**
 * Village decor drawn in world coordinates: roads and paths, the plaza, well, bell, notice
 * board, lamp posts, the east gate, farms, Bram's plot, a scarecrow and a small green.
 * Pure functions of their inputs, shared by the gen worker and the main thread.
 */
import { BLOCK } from '../../engine/blocks';
import { hash01 } from '../../engine/random';
import type { VoxelSink } from './local';
import type { Palette } from './palette';

/** Inclusive rectangle in world x/z. */
export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/** Clears plants/grass above ground in a rect (y0 = ground block y). */
export function clearAbove(s: VoxelSink, r: Rect, y0: number, h = 3): void {
  for (let y = y0 + 1; y <= y0 + h; y++) for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) s.set(x, y, z, BLOCK.air);
}

/** A road or path: `pal.path` in the middle, a speckled gravel edge on wide roads. */
export function drawRoad(s: VoxelSink, r: Rect, y0: number, pal: Palette, seed: number): void {
  const wide = Math.min(r.x1 - r.x0, r.z1 - r.z0) >= 2;
  for (let z = r.z0; z <= r.z1; z++)
    for (let x = r.x0; x <= r.x1; x++) {
      const edge = wide && (x === r.x0 || x === r.x1 || z === r.z0 || z === r.z1);
      const n = hash01(seed ^ 0x5a7e, x, z);
      const id = edge ? (n < 0.55 ? pal.pathEdge : pal.path) : n < 0.07 ? pal.pathEdge : pal.path;
      s.set(x, y0, z, id);
      s.set(x, y0 - 1, z, pal.fill);
    }
  clearAbove(s, r, y0, 3);
}

/** Paved plaza with a stone border and a radial accent pattern. */
export function drawPlaza(s: VoxelSink, r: Rect, cx: number, cz: number, y0: number, pal: Palette, seed: number): void {
  for (let z = r.z0; z <= r.z1; z++)
    for (let x = r.x0; x <= r.x1; x++) {
      const border = x === r.x0 || x === r.x1 || z === r.z0 || z === r.z1;
      const ring = Math.round(Math.hypot(x - cx + 0.5, z - cz + 0.5));
      const n = hash01(seed ^ 0x91a2, x, z);
      let id = border ? pal.plazaAccent : ring % 3 === 0 ? pal.plazaAccent : n < 0.25 ? pal.path : pal.plaza;
      if (!border && n > 0.93) id = BLOCK.mossy_cobblestone;
      s.set(x, y0, z, id);
      s.set(x, y0 - 1, z, pal.fill);
    }
  clearAbove(s, r, y0, 4);
}

/** The well: a 4×4 cobblestone rim around 2×2 water, log posts and a plank canopy. (x, z) is the NW corner. */
export function drawWell(s: VoxelSink, x: number, z: number, y0: number, pal: Palette): void {
  for (let dz = 0; dz < 4; dz++)
    for (let dx = 0; dx < 4; dx++) {
      const inner = dx >= 1 && dx <= 2 && dz >= 1 && dz <= 2;
      if (inner) {
        for (let y = y0 - 4; y <= y0; y++) s.set(x + dx, y, z + dz, BLOCK.water);
        s.set(x + dx, y0 - 5, z + dz, pal.foundation);
      } else {
        for (let y = y0 - 4; y <= y0; y++) s.set(x + dx, y, z + dz, pal.foundation);
        s.set(x + dx, y0 + 1, z + dz, pal.foundation);
      }
    }
  for (const [dx, dz] of [[0, 0], [3, 0], [0, 3], [3, 3]]) for (let y = y0 + 2; y <= y0 + 3; y++) s.set(x + dx, y, z + dz, BLOCK.oak_log);
  for (let dz = 0; dz < 4; dz++) for (let dx = 0; dx < 4; dx++) s.set(x + dx, y0 + 4, z + dz, BLOCK.spruce_planks);
  for (let dz = 1; dz <= 2; dz++) for (let dx = 1; dx <= 2; dx++) s.set(x + dx, y0 + 5, z + dz, BLOCK.spruce_planks);
}

/** A bell frame: two log posts, a beam and a gold bell. (x, z) is the west post; the frame runs east. */
export function drawBell(s: VoxelSink, x: number, z: number, y0: number): void {
  for (let y = y0 + 1; y <= y0 + 3; y++) {
    s.set(x, y, z, BLOCK.oak_log);
    s.set(x + 2, y, z, BLOCK.oak_log);
  }
  for (let dx = 0; dx <= 2; dx++) s.set(x + dx, y0 + 4, z, BLOCK.spruce_planks);
  s.set(x + 1, y0 + 3, z, BLOCK.gold_block);
  s.set(x, y0 + 5, z, BLOCK.torch, 0);
  s.set(x + 2, y0 + 5, z, BLOCK.torch, 0);
}

/** A notice board with pinned notes. (x, z) is the west post; the board runs east. */
export function drawNoticeBoard(s: VoxelSink, x: number, z: number, y0: number): void {
  for (let y = y0 + 1; y <= y0 + 3; y++) {
    s.set(x, y, z, BLOCK.spruce_log);
    s.set(x + 3, y, z, BLOCK.spruce_log);
  }
  s.set(x + 1, y0 + 2, z, BLOCK.white_wool);
  s.set(x + 2, y0 + 2, z, BLOCK.oak_planks);
  s.set(x + 1, y0 + 3, z, BLOCK.oak_planks);
  s.set(x + 2, y0 + 3, z, BLOCK.yellow_wool);
  for (let dx = -1; dx <= 4; dx++) s.set(x + dx, y0 + 4, z, BLOCK.spruce_planks);
}

/** Lamp post: three logs with a torch, or a glow lamp for plaza lamps. */
export function drawLamp(s: VoxelSink, x: number, z: number, y0: number, glow: boolean): void {
  s.set(x, y0, z, BLOCK.cobblestone);
  for (let y = y0 + 1; y <= y0 + 3; y++) s.set(x, y, z, BLOCK.spruce_log);
  if (glow) s.set(x, y0 + 4, z, BLOCK.glow_lamp);
  else s.set(x, y0 + 4, z, BLOCK.torch, 0);
}

/** The east gate: two stone pillars and a timber lintel over the road (z0..z1 = road width). */
export function drawGate(s: VoxelSink, x: number, z0: number, z1: number, y0: number, pal: Palette): void {
  for (const z of [z0 - 1, z1 + 1]) {
    for (let y = y0; y <= y0 + 4; y++) s.set(x, y, z, pal.tower);
    s.set(x, y0 + 5, z, BLOCK.glow_lamp);
  }
  for (let z = z0 - 1; z <= z1 + 1; z++) s.set(x, y0 + 5, z, BLOCK.spruce_log);
  for (let z = z0; z <= z1; z++) s.set(x, y0 + 6, z, BLOCK.spruce_planks);
  s.set(x, y0 + 4, z0 + ((z1 - z0) >> 1), BLOCK.blue_wool);
}

/**
 * A wheat farm: log border, farmland rows, a central water channel, wheat at mixed growth
 * stages and a scarecrow outside one corner. Returns the farmland cells (x, z).
 */
export function drawFarm(s: VoxelSink, r: Rect, y0: number, seed: number, scarecrow: boolean): { x: number; z: number }[] {
  const cells: { x: number; z: number }[] = [];
  const midZ = (r.z0 + r.z1) >> 1;
  clearAbove(s, { x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1 }, y0, 3);
  for (let z = r.z0; z <= r.z1; z++)
    for (let x = r.x0; x <= r.x1; x++) {
      const border = x === r.x0 || x === r.x1 || z === r.z0 || z === r.z1;
      s.set(x, y0 - 1, z, BLOCK.dirt);
      if (border) s.set(x, y0, z, BLOCK.oak_log);
      else if (z === midZ) {
        s.set(x, y0, z, BLOCK.water);
        s.set(x, y0 - 1, z, BLOCK.clay);
      } else {
        s.set(x, y0, z, BLOCK.farmland);
        const stage = Math.min(7, Math.floor(hash01(seed ^ 0xfa53, x, z) * 9));
        s.set(x, y0 + 1, z, BLOCK.wheat, stage);
        cells.push({ x, z });
      }
    }
  if (scarecrow) {
    const x = r.x0 - 1, z = r.z0 - 1;
    s.set(x, y0 + 1, z, BLOCK.oak_log);
    s.set(x, y0 + 2, z, BLOCK.hay_bale);
    s.set(x, y0 + 3, z, BLOCK.pumpkin, 2);
  }
  return cells;
}

/** Bram's build plot: a cleared, level lot of coarse dirt, corner posts and a sign post. */
export function drawPlot(s: VoxelSink, r: Rect, y0: number, sign: { x: number; z: number }, pal: Palette): void {
  const big: Rect = { x0: r.x0 - 1, z0: r.z0 - 1, x1: r.x1 + 1, z1: r.z1 + 1 };
  clearAbove(s, big, y0, 24);
  for (let z = big.z0; z <= big.z1; z++)
    for (let x = big.x0; x <= big.x1; x++) {
      const inside = x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
      s.set(x, y0, z, inside ? (pal.ground === BLOCK.sand ? BLOCK.sand : BLOCK.dirt) : pal.ground);
      s.set(x, y0 - 1, z, pal.fill);
    }
  for (const [x, z] of [[big.x0, big.z0], [big.x1, big.z0], [big.x0, big.z1], [big.x1, big.z1]]) {
    s.set(x, y0 + 1, z, BLOCK.oak_log);
    s.set(x, y0 + 2, z, BLOCK.torch, 0);
  }
  s.set(sign.x, y0 + 1, sign.z, BLOCK.oak_log);
  s.set(sign.x, y0 + 2, sign.z, BLOCK.oak_planks);
  s.set(sign.x - 1, y0 + 2, sign.z, BLOCK.oak_planks);
  s.set(sign.x + 1, y0 + 2, sign.z, BLOCK.oak_planks);
}

/** A small green: flower beds, a bench and a hedge corner. */
export function drawGreen(s: VoxelSink, r: Rect, y0: number, pal: Palette, seed: number): void {
  clearAbove(s, r, y0, 3);
  for (let z = r.z0; z <= r.z1; z++)
    for (let x = r.x0; x <= r.x1; x++) {
      s.set(x, y0, z, pal.ground);
      const n = hash01(seed ^ 0x6ee7, x, z);
      if (n < 0.18) s.set(x, y0 + 1, z, n < 0.09 ? BLOCK.red_flower : BLOCK.yellow_flower);
      else if (n > 0.94) s.set(x, y0 + 1, z, BLOCK.oak_leaves);
    }
  const bx = (r.x0 + r.x1) >> 1, bz = (r.z0 + r.z1) >> 1;
  for (let dx = -1; dx <= 1; dx++) s.set(bx + dx, y0 + 1, bz, BLOCK.spruce_planks);
  s.set(bx - 2, y0 + 1, bz, BLOCK.oak_leaves);
  s.set(bx + 2, y0 + 1, bz, BLOCK.oak_leaves);
}

/** A tiny fenced garden patch: pumpkins, hay and flowers inside a leaf hedge. */
export function drawGarden(s: VoxelSink, r: Rect, y0: number): void {
  clearAbove(s, r, y0, 3);
  for (let z = r.z0; z <= r.z1; z++)
    for (let x = r.x0; x <= r.x1; x++) {
      const edge = x === r.x0 || x === r.x1 || z === r.z0 || z === r.z1;
      s.set(x, y0, z, edge ? BLOCK.grass : BLOCK.farmland);
      if (edge) s.set(x, y0 + 1, z, BLOCK.oak_leaves);
    }
  s.set(r.x0 + 1, y0 + 1, r.z0 + 1, BLOCK.pumpkin, 2);
  if (r.x1 - r.x0 >= 3) s.set(r.x0 + 2, y0 + 1, r.z0 + 1, BLOCK.wheat, 7);
  s.set(r.x1 - 1, y0 + 1, r.z1 - 1, BLOCK.pumpkin, 1);
}

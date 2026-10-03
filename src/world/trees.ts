/**
 * Tree and plant placement. Trees are placed on a jittered grid so that every chunk can
 * deterministically draw the parts of neighbouring trees that overlap it.
 */
import { BLOCK, BLOCK_FLAGS, F_REPLACEABLE } from '../engine/blocks';
import { hash01 } from '../engine/random';
import { BIOME } from './biomes';
import type { Terrain } from './terrain';

export type TreeKind = 'oak' | 'birch' | 'spruce' | 'cactus';

export interface TreeSpot {
  x: number;
  z: number;
  /** y of the ground block the tree stands on. */
  ground: number;
  kind: TreeKind;
  height: number;
  /** Per-tree random seed for leaf shapes. */
  seed: number;
}

/** Writes into the chunk being generated (out-of-chunk writes are ignored). */
export interface BlockWriter {
  get(x: number, y: number, z: number): number;
  set(x: number, y: number, z: number, id: number): void;
}

export const TREE_CELL = 4;

/** Chance per 4×4 cell that a tree grows, by biome. */
const DENSITY: Record<number, number> = {
  [BIOME.plains]: 0.025,
  [BIOME.forest]: 0.6,
  [BIOME.desert]: 0.07,
  [BIOME.snowy_taiga]: 0.42,
  [BIOME.mountains]: 0.12,
  [BIOME.beach]: 0,
  [BIOME.lake]: 0,
};

/** The tree whose trunk sits in grid cell (gx, gz), if any. */
export function treeInCell(t: Terrain, gx: number, gz: number): TreeSpot | null {
  const seed = t.seed;
  const x = gx * TREE_CELL + Math.floor(hash01(seed ^ 0x51ed, gx, gz) * TREE_CELL);
  const z = gz * TREE_CELL + Math.floor(hash01(seed ^ 0x7ab3, gx, gz) * TREE_CELL);
  if (t.flattenWeight(x, z) > 0) return null;
  const col = t.column(x, z);
  const roll = hash01(seed ^ 0x3c3c, gx, gz);
  if (roll >= (DENSITY[col.biome] ?? 0)) return null;
  if (col.biome === BIOME.mountains && col.height > 96) return null;
  if (t.isCave(x, col.height, z, col.height) || t.isCave(x, col.height - 1, z, col.height)) return null;
  const r = hash01(seed ^ 0x9e37, gx, gz);
  let kind: TreeKind;
  if (col.biome === BIOME.desert) kind = 'cactus';
  else if (col.biome === BIOME.snowy_taiga || col.biome === BIOME.mountains) kind = 'spruce';
  else if (col.biome === BIOME.forest) kind = r < 0.68 ? 'oak' : 'birch';
  else kind = r < 0.85 ? 'oak' : 'birch';
  const hr = hash01(seed ^ 0x1234, gx, gz);
  const height =
    kind === 'cactus' ? 1 + Math.floor(hr * 3) : kind === 'spruce' ? 6 + Math.floor(hr * 4) : kind === 'birch' ? 5 + Math.floor(hr * 3) : 4 + Math.floor(hr * 3);
  return { x, z, ground: col.height, kind, height, seed: hash01(seed ^ 0x4321, gx, gz) * 1e9 };
}

function leaf(w: BlockWriter, x: number, y: number, z: number, id: number): void {
  const cur = w.get(x, y, z);
  if (cur === BLOCK.air || BLOCK_FLAGS[cur] & F_REPLACEABLE) w.set(x, y, z, id);
}

/** Draws a tree through the writer (clipped to the current chunk by the writer). */
export function drawTree(w: BlockWriter, tree: TreeSpot): void {
  const { x, z, ground, height } = tree;
  const top = ground + height;
  const rnd = (a: number, b: number, c: number) => hash01(tree.seed | 0, a, b, c);
  switch (tree.kind) {
    case 'cactus':
      for (let y = ground + 1; y <= top; y++) w.set(x, y, z, BLOCK.cactus);
      return;
    case 'oak':
    case 'birch': {
      const log = tree.kind === 'oak' ? BLOCK.oak_log : BLOCK.birch_log;
      const leaves = tree.kind === 'oak' ? BLOCK.oak_leaves : BLOCK.birch_leaves;
      for (let y = top - 3; y <= top + 1; y++) {
        const r = y >= top ? 1 : 2;
        for (let dx = -r; dx <= r; dx++)
          for (let dz = -r; dz <= r; dz++) {
            const corner = Math.abs(dx) === r && Math.abs(dz) === r;
            if (corner && (y === top + 1 || rnd(dx, y, dz) < 0.5)) continue;
            if (y === top + 1 && (dx !== 0 || dz !== 0) && Math.abs(dx) + Math.abs(dz) > 1) continue;
            leaf(w, x + dx, y, z + dz, leaves);
          }
      }
      for (let y = ground + 1; y <= top; y++) w.set(x, y, z, log);
      w.set(x, ground, z, BLOCK.dirt);
      return;
    }
    case 'spruce': {
      const leafStart = ground + 2 + Math.floor(rnd(0, 0, 0) * 2);
      let r = 1;
      for (let y = top; y >= leafStart; y--) {
        const rr = y === top ? 0 : r;
        for (let dx = -rr; dx <= rr; dx++)
          for (let dz = -rr; dz <= rr; dz++) {
            if (rr > 0 && Math.abs(dx) === rr && Math.abs(dz) === rr) continue;
            leaf(w, x + dx, y, z + dz, BLOCK.spruce_leaves);
          }
        r = r >= 2 + Math.floor((top - y) / 4) ? 1 : r + 1;
        if (r > 3) r = 1;
      }
      leaf(w, x, top + 1, z, BLOCK.spruce_leaves);
      for (let y = ground + 1; y < top; y++) w.set(x, y, z, BLOCK.spruce_log);
      w.set(x, ground, z, BLOCK.dirt);
      return;
    }
  }
}

/**
 * Blueprint placement math: rotate the plan's blocks in 90° steps (clockwise seen from above) and anchor the
 * footprint so it starts at the anchor block and extends away from the player, centred across the view.
 * Plan axes: +x east, +z south, front (door) on the north side, so with rotation 0 extra the front faces the player.
 */
import type { VoxelBlock } from '@liveforge/sdk';

type Facing = NonNullable<VoxelBlock['facing']>;
const FACINGS: Facing[] = ['north', 'east', 'south', 'west'];

/** Rotated blocks, shifted so the footprint starts at x = 0, z = 0 (y unchanged). */
export interface Arranged {
  blocks: VoxelBlock[];
  /** Footprint width (x) and depth (z) after rotation; min / max y of the plan. */
  w: number;
  d: number;
  minY: number;
  maxY: number;
}

/** Rotates by `k` quarter turns clockwise: (x, z) → (−z, x) per step; facings turn with it. */
export function arrange(blocks: readonly VoxelBlock[], k: number): Arranged {
  const q = ((k % 4) + 4) % 4;
  const rot = (x: number, z: number): [number, number] => {
    for (let i = 0; i < q; i++) [x, z] = [-z, x];
    return [x, z];
  };
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
  const out: VoxelBlock[] = blocks.map((b) => {
    const [x, z] = rot(b.x, b.z);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
    minY = Math.min(minY, b.y);
    maxY = Math.max(maxY, b.y);
    const facing = b.facing ? FACINGS[(FACINGS.indexOf(b.facing) + q) & 3] : undefined;
    return { x, y: b.y, z, block: b.block, ...(facing ? { facing } : {}) };
  });
  if (!out.length) return { blocks: [], w: 0, d: 0, minY: 0, maxY: 0 };
  for (const b of out) {
    b.x -= minX;
    b.z -= minZ;
  }
  return { blocks: out, w: maxX - minX + 1, d: maxZ - minZ + 1, minY, maxY };
}

/** Rotation that turns the plan's front (north) towards a player looking along `facing` (0 N, 1 E, 2 S, 3 W). */
export const facingRotation = (facing: number): number => (facing + 2) & 3;

/**
 * World offset of an arranged footprint: its near edge sits on the anchor block, centred across the view, and it
 * extends in the player's facing direction. `anchor.y` is the layer the plan's y = 0 goes to.
 */
export function anchorOffset(anchor: { x: number; y: number; z: number }, facing: number, w: number, d: number): { x: number; y: number; z: number } {
  const cx = anchor.x - Math.floor((w - 1) / 2), cz = anchor.z - Math.floor((d - 1) / 2);
  switch (facing & 3) {
    case 0: return { x: cx, y: anchor.y, z: anchor.z - (d - 1) };
    case 1: return { x: anchor.x, y: anchor.y, z: cz };
    case 2: return { x: cx, y: anchor.y, z: anchor.z };
    default: return { x: anchor.x - (w - 1), y: anchor.y, z: cz };
  }
}

/**
 * Local-frame block writer for building templates.
 *
 * Templates draw in a local frame: `lx` across the width (0..w-1), `lz` front-to-back (0 = back
 * wall, d-1 = front wall with the door), `ly` up (0 = the ground/foundation layer). The writer
 * rotates that frame to the building's world facing and rotates block metadata (orientable
 * blocks, doors, ladders, wall torches) to match. Works in the gen worker and on the main thread.
 */
import { BLOCK } from '../../engine/blocks';

/** Something that accepts world-space block writes (gen ctx, recorder, world store adapter). */
export interface VoxelSink {
  set(x: number, y: number, z: number, id: number, meta?: number): void;
}

/** 0 north (-z), 1 east (+x), 2 south (+z), 3 west (-x). */
export type Facing = 0 | 1 | 2 | 3;

export const FACING_DX = [0, 1, 0, -1] as const;
export const FACING_DZ = [-1, 0, 1, 0] as const;

/** Local facings (the local front is south). */
export const L_NORTH = 0, L_EAST = 1, L_SOUTH = 2, L_WEST = 3;

export interface WorldPos {
  x: number;
  y: number;
  z: number;
}

export class Local {
  /** World facing of the front (the side the door is on). */
  readonly facing: Facing;

  /**
   * @param x0,z0 world min corner of the rotated footprint
   * @param y0 world y of local ly = 0
   * @param w,d local width and depth (footprint is d×w in world when facing east/west)
   */
  constructor(
    readonly sink: VoxelSink,
    readonly x0: number,
    readonly y0: number,
    readonly z0: number,
    readonly w: number,
    readonly d: number,
    facing: Facing,
  ) {
    this.facing = facing;
  }

  /** World footprint size [sizeX, sizeZ] for a local w×d facing `facing`. */
  static footprint(w: number, d: number, facing: Facing): [number, number] {
    return facing === 1 || facing === 3 ? [d, w] : [w, d];
  }

  /** Local → world position. */
  pos(lx: number, ly: number, lz: number): WorldPos {
    const { x0, z0, w, d } = this;
    let x: number, z: number;
    switch (this.facing) {
      case 2: x = x0 + lx; z = z0 + lz; break;
      case 0: x = x0 + w - 1 - lx; z = z0 + d - 1 - lz; break;
      case 1: x = x0 + lz; z = z0 + w - 1 - lx; break;
      default: x = x0 + d - 1 - lz; z = z0 + lx; break;
    }
    return { x, y: this.y0 + ly, z };
  }

  /** Local facing → world facing. */
  face(f: number): Facing {
    return ((f + this.facing - 2 + 8) & 3) as Facing;
  }

  set(lx: number, ly: number, lz: number, id: number, meta = 0): void {
    const p = this.pos(lx, ly, lz);
    this.sink.set(p.x, p.y, p.z, id, meta);
  }

  /** Fills an inclusive local box. */
  fill(lx0: number, ly0: number, lz0: number, lx1: number, ly1: number, lz1: number, id: number, meta = 0): void {
    for (let ly = Math.min(ly0, ly1); ly <= Math.max(ly0, ly1); ly++)
      for (let lz = Math.min(lz0, lz1); lz <= Math.max(lz0, lz1); lz++)
        for (let lx = Math.min(lx0, lx1); lx <= Math.max(lx0, lx1); lx++) this.set(lx, ly, lz, id, meta);
  }

  /** An orientable block (furnace, chest, ...) whose front faces local facing `f`. */
  oriented(lx: number, ly: number, lz: number, id: number, f: number): void {
    this.set(lx, ly, lz, id, this.face(f));
  }

  /** A ladder hanging on the wall in local direction `wall`. */
  ladder(lx: number, ly: number, lz: number, wall: number): void {
    this.set(lx, ly, lz, BLOCK.ladder, this.face(wall));
  }

  /** A floor torch, or a wall torch on the wall in local direction `wall`. */
  torch(lx: number, ly: number, lz: number, wall?: number): void {
    this.set(lx, ly, lz, BLOCK.torch, wall === undefined ? 0 : this.face(wall) + 1);
  }

  /** A closed two-block door whose panel sits on local side `side`. */
  door(lx: number, ly: number, lz: number, side: number = L_SOUTH): void {
    const f = this.face(side);
    this.set(lx, ly, lz, BLOCK.door, f);
    this.set(lx, ly + 1, lz, BLOCK.door, f | 8);
  }
}

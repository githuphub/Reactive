/**
 * Collision and selection shapes per block (unit-cube space, [x0, y0, z0, x1, y1, z1]).
 */
import { BLOCK_FLAGS, F_SOLID, blockById } from './blocks';
import { DOOR_BOXES } from './mesher';

export type Box = readonly [number, number, number, number, number, number];

const FULL: Box = [0, 0, 0, 1, 1, 1];
const NONE: readonly Box[] = [];
const FULL_LIST: readonly Box[] = [FULL];

function doorBox(meta: number): Box {
  const facing = meta & 3;
  const open = (meta & 4) !== 0;
  const [x0, z0, x1, z1] = DOOR_BOXES[open ? (facing + 1) & 3 : facing];
  return [x0, 0, z0, x1, 1, z1];
}

/** Boxes that block movement. */
export function collisionBoxes(id: number, meta: number): readonly Box[] {
  if (!(BLOCK_FLAGS[id] & F_SOLID)) return NONE;
  const def = blockById(id);
  if (def.renderType === 'door') return [doorBox(meta)];
  return FULL_LIST;
}

/** Box used for targeting/highlighting, or null if the block can't be targeted. */
export function selectionBox(id: number, meta: number): Box | null {
  if (id === 0) return null;
  const def = blockById(id);
  switch (def.renderType) {
    case 'none':
    case 'liquid':
      return null;
    case 'cross':
      return [0.15, 0, 0.15, 0.85, def.tags.includes('crop') ? 0.25 + (meta / 7) * 0.7 : 0.8, 0.85];
    case 'torch': {
      if (meta >= 1 && meta <= 4) {
        const f = meta - 1;
        const ox = [0, 1, 0, -1][f] * (6 / 16);
        const oz = [-1, 0, 1, 0][f] * (6 / 16);
        return [0.38 + ox, 3 / 16, 0.38 + oz, 0.62 + ox, 13 / 16, 0.62 + oz];
      }
      return [0.38, 0, 0.38, 0.62, 0.65, 0.62];
    }
    case 'ladder': {
      const f = meta & 3;
      const e = 2 / 16;
      if (f === 0) return [0, 0, 0, 1, 1, e];
      if (f === 1) return [1 - e, 0, 0, 1, 1, 1];
      if (f === 2) return [0, 0, 1 - e, 1, 1, 1];
      return [0, 0, 0, e, 1, 1];
    }
    case 'door':
      return doorBox(meta);
    default:
      return FULL;
  }
}

export function isFullBox(b: Box): boolean {
  return b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 1 && b[4] === 1 && b[5] === 1;
}

/**
 * Compact typed-array snapshot of the block registry + atlas slots, posted to mesh workers.
 */
import { BLOCK_FLAGS, allBlocks, type RenderType } from './blocks';
import type { TextureAtlas } from './atlas';

export const R_NONE = 0;
export const R_CUBE = 1;
export const R_CROSS = 2;
export const R_LIQUID = 3;
export const R_DOOR = 4;
export const R_LADDER = 5;
export const R_TORCH = 6;

export const PASS_OPAQUE = 0;
export const PASS_CUTOUT = 1;
export const PASS_TRANSPARENT = 2;

const RENDER_CODE: Record<RenderType, number> = {
  none: R_NONE, cube: R_CUBE, cross: R_CROSS, liquid: R_LIQUID, door: R_DOOR, ladder: R_LADDER, torch: R_TORCH,
};

export interface BlockTable {
  count: number;
  slotsPerRow: number;
  render: Uint8Array;
  pass: Uint8Array;
  flags: Uint8Array;
  /** count × 6 atlas slots (+X, -X, +Y, -Y, +Z, -Z). */
  faces: Uint16Array;
  /** count × 6 animation frame counts. */
  anim: Uint8Array;
  orient: Uint8Array;
  /** Cull faces between two blocks of the same type (glass, leaves, ice). */
  cullSame: Uint8Array;
  stageStart: Int16Array;
  stageCount: Uint8Array;
  stageSlots: Uint16Array;
}

export function buildBlockTable(atlas: TextureAtlas, slotsPerRow: number): BlockTable {
  const defs = allBlocks();
  const n = defs.length;
  const t: BlockTable = {
    count: n,
    slotsPerRow,
    render: new Uint8Array(n),
    pass: new Uint8Array(n),
    flags: BLOCK_FLAGS.slice(0, n),
    faces: new Uint16Array(n * 6),
    anim: new Uint8Array(n * 6),
    orient: new Uint8Array(n),
    cullSame: new Uint8Array(n),
    stageStart: new Int16Array(n).fill(-1),
    stageCount: new Uint8Array(n),
    stageSlots: new Uint16Array(0),
  };
  const stages: number[] = [];
  for (const d of defs) {
    t.render[d.id] = RENDER_CODE[d.renderType];
    t.pass[d.id] = d.pass === 'opaque' ? PASS_OPAQUE : d.pass === 'cutout' ? PASS_CUTOUT : PASS_TRANSPARENT;
    t.orient[d.id] = d.orientable ? 1 : 0;
    t.cullSame[d.id] = d.renderType === 'cube' && !d.opaque ? 1 : 0;
    for (let f = 0; f < 6; f++) {
      t.faces[d.id * 6 + f] = atlas.slot(d.faces[f]);
      t.anim[d.id * 6 + f] = atlas.frames(d.faces[f]);
    }
    if (d.stages.length) {
      t.stageStart[d.id] = stages.length;
      t.stageCount[d.id] = d.stages.length;
      for (const s of d.stages) stages.push(atlas.slot(s));
    }
  }
  t.stageSlots = Uint16Array.from(stages);
  atlas.flush();
  return t;
}

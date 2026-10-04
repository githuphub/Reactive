/**
 * World dimensions and block-value packing shared by the main thread and all workers.
 *
 * A stored block value is a Uint16: the low 12 bits are the block type id, the high 4 bits
 * are per-block metadata (facing, door state, crop stage, liquid level, ...).
 */

/** Chunk width and depth in blocks. */
export const CHUNK_SIZE = 16;
/** World height in blocks (y = 0 .. 127). */
export const CHUNK_HEIGHT = 128;
/** Vertical 16³ sections per chunk column (meshing unit). */
export const SECTION_COUNT = CHUNK_HEIGHT / 16;
/** Water surface level. */
export const SEA_LEVEL = 62;
/** Blocks per chunk column. */
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * CHUNK_HEIGHT;

export const ID_MASK = 0x0fff;
export const META_SHIFT = 12;
export const MAX_BLOCK_TYPES = 4096;

/** Index into a chunk's flat arrays. x, z in 0..15, y in 0..127. */
export function chunkIndex(x: number, y: number, z: number): number {
  return x | (z << 4) | (y << 8);
}

/** Packs a block type id and its 4-bit metadata into a stored value. */
export function packBlock(id: number, meta = 0): number {
  return (id & ID_MASK) | ((meta & 0xf) << META_SHIFT);
}

/** Numeric key for a chunk column (cx, cz in -32768..32767). */
export function chunkKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768);
}

export function chunkKeyX(key: number): number {
  return Math.floor(key / 65536) - 32768;
}

export function chunkKeyZ(key: number): number {
  return (key % 65536) - 32768;
}

/** Numeric key for a 16³ section. */
export function sectionKey(cx: number, cz: number, sy: number): number {
  return chunkKey(cx, cz) * 8 + sy;
}

/** Horizontal facing used in block metadata: 0 north (-z), 1 east (+x), 2 south (+z), 3 west (-x). */
export type Facing = 0 | 1 | 2 | 3;
export const FACING_DX = [0, 1, 0, -1] as const;
export const FACING_DZ = [-1, 0, 1, 0] as const;

/** Face order used by meshing and block textures: +X, -X, +Y, -Y, +Z, -Z. */
export const FACE_EAST = 0;
export const FACE_WEST = 1;
export const FACE_TOP = 2;
export const FACE_BOTTOM = 3;
export const FACE_SOUTH = 4;
export const FACE_NORTH = 5;

/** Texture atlas layout (see engine/atlas.ts): 1024² canvas of 32 px slots with 8 px padding. */
export const ATLAS_SIZE = 1024;
export const SLOT_SIZE = 32;
export const SLOT_PAD = 8;
export const SLOTS_PER_ROW = ATLAS_SIZE / SLOT_SIZE;

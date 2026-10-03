/**
 * One 16×16×128 chunk column. Blocks are packed Uint16 (12-bit id + 4-bit meta);
 * light is Uint8 (high nibble sky light, low nibble block light).
 */
import { CHUNK_HEIGHT, CHUNK_VOLUME, ID_MASK, META_SHIFT, chunkIndex, chunkKey } from './constants';

export class Chunk {
  readonly cx: number;
  readonly cz: number;
  readonly key: number;
  readonly blocks: Uint16Array;
  readonly light: Uint8Array;
  /** Per column (x + z*16): y of the highest non-air block, or -1. */
  readonly heights: Int16Array;
  /** Per column biome id (see world/biomes). */
  readonly biomes: Uint8Array;
  /** Non-air block count per 16³ section (lets the mesher skip empty sections). */
  readonly sectionCounts: Uint16Array;

  constructor(cx: number, cz: number, blocks?: Uint16Array, light?: Uint8Array, biomes?: Uint8Array) {
    this.cx = cx;
    this.cz = cz;
    this.key = chunkKey(cx, cz);
    this.blocks = blocks ?? new Uint16Array(CHUNK_VOLUME);
    this.light = light ?? new Uint8Array(CHUNK_VOLUME);
    this.biomes = biomes ?? new Uint8Array(256);
    this.heights = new Int16Array(256);
    this.sectionCounts = new Uint16Array(CHUNK_HEIGHT / 16);
    this.recount();
  }

  /** Recomputes heights and section counts from the block array. */
  recount(): void {
    this.sectionCounts.fill(0);
    this.heights.fill(-1);
    const b = this.blocks;
    for (let y = 0; y < CHUNK_HEIGHT; y++) {
      const base = y << 8;
      let n = 0;
      for (let i = 0; i < 256; i++) {
        if ((b[base + i] & ID_MASK) !== 0) {
          n++;
          this.heights[i] = y;
        }
      }
      this.sectionCounts[y >> 4] += n;
    }
  }

  getId(x: number, y: number, z: number): number {
    return this.blocks[chunkIndex(x, y, z)] & ID_MASK;
  }

  getRaw(x: number, y: number, z: number): number {
    return this.blocks[chunkIndex(x, y, z)];
  }

  getMeta(x: number, y: number, z: number): number {
    return this.blocks[chunkIndex(x, y, z)] >> META_SHIFT;
  }

  /** Writes a raw value and keeps heights/section counts in sync. Returns the previous raw value. */
  setRaw(x: number, y: number, z: number, raw: number): number {
    const i = chunkIndex(x, y, z);
    const prev = this.blocks[i];
    if (prev === raw) return prev;
    this.blocks[i] = raw;
    const wasAir = (prev & ID_MASK) === 0;
    const isAir = (raw & ID_MASK) === 0;
    if (wasAir !== isAir) {
      this.sectionCounts[y >> 4] += isAir ? -1 : 1;
      const col = x | (z << 4);
      if (!isAir && y > this.heights[col]) this.heights[col] = y;
      else if (isAir && y === this.heights[col]) {
        let h = y - 1;
        while (h >= 0 && (this.blocks[(h << 8) | col] & ID_MASK) === 0) h--;
        this.heights[col] = h;
      }
    }
    return prev;
  }

  skyLight(x: number, y: number, z: number): number {
    return this.light[chunkIndex(x, y, z)] >> 4;
  }

  blockLight(x: number, y: number, z: number): number {
    return this.light[chunkIndex(x, y, z)] & 15;
  }
}

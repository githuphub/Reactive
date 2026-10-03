/**
 * Flood-fill lighting. Two channels share one byte per block: sky light (high nibble) and block
 * light (low nibble). Sky light of 15 travels straight down without loss.
 *
 * - {@link lightChunkLocal}: full light for a freshly generated chunk, ignoring neighbours (gen worker).
 * - {@link LightEngine}: main-thread seams between chunks and bounded incremental updates on setBlock.
 */
import { BLOCK_EMISSION, BLOCK_FILTER, BLOCK_FLAGS, F_OPAQUE } from './blocks';
import { CHUNK_HEIGHT, ID_MASK } from './constants';
import type { Chunk } from './chunk';

const SKY = 4;
const BLK = 0;

// ---------------------------------------------------------------------------------------------
// Chunk-local lighting (worker)
// ---------------------------------------------------------------------------------------------

const LQ_SIZE = 1 << 17;
const LQ_MASK = LQ_SIZE - 1;
let localQueue: Int32Array | null = null;

/** Computes sky and block light for one chunk in isolation. Overwrites `light`. */
export function lightChunkLocal(blocks: Uint16Array, light: Uint8Array): void {
  const q = (localQueue ??= new Int32Array(LQ_SIZE));
  light.fill(0);
  // Sky columns.
  for (let col = 0; col < 256; col++) {
    let level = 15;
    for (let y = CHUNK_HEIGHT - 1; y >= 0; y--) {
      const i = (y << 8) | col;
      const id = blocks[i] & ID_MASK;
      if (BLOCK_FLAGS[id] & F_OPAQUE) level = 0;
      else if (level > 0) level = Math.max(0, level - BLOCK_FILTER[id]);
      light[i] = level << 4;
      if (level === 0 && BLOCK_FLAGS[id] & F_OPAQUE) {
        // Everything below stays 0 until spreading.
        for (let yy = y - 1; yy >= 0; yy--) light[(yy << 8) | col] = 0;
        break;
      }
    }
  }
  // Seed sky spreading where a lit cell borders a darker horizontal neighbour.
  let tail = 0;
  for (let i = 0; i < blocks.length; i++) {
    const l = light[i] >> 4;
    if (l <= 1) continue;
    const x = i & 15;
    const z = (i >> 4) & 15;
    if (
      (x > 0 && light[i - 1] >> 4 < l - 1) ||
      (x < 15 && light[i + 1] >> 4 < l - 1) ||
      (z > 0 && light[i - 16] >> 4 < l - 1) ||
      (z < 15 && light[i + 16] >> 4 < l - 1)
    ) {
      q[tail++ & LQ_MASK] = i;
    }
  }
  spreadLocal(blocks, light, q, 0, tail, SKY);
  // Block light from emitters.
  tail = 0;
  for (let i = 0; i < blocks.length; i++) {
    const e = BLOCK_EMISSION[blocks[i] & ID_MASK];
    if (e > 0) {
      light[i] = (light[i] & 0xf0) | e;
      q[tail++ & LQ_MASK] = i;
    }
  }
  spreadLocal(blocks, light, q, 0, tail, BLK);
}

function spreadLocal(blocks: Uint16Array, light: Uint8Array, q: Int32Array, head: number, tail: number, shift: number): void {
  const keep = shift === SKY ? 0x0f : 0xf0;
  while (head !== tail) {
    const i = q[head++ & LQ_MASK];
    const L = (light[i] >> shift) & 15;
    if (L <= 1) continue;
    const x = i & 15;
    const z = (i >> 4) & 15;
    const y = i >> 8;
    for (let d = 0; d < 6; d++) {
      let j: number;
      if (d === 0) { if (x === 15) continue; j = i + 1; }
      else if (d === 1) { if (x === 0) continue; j = i - 1; }
      else if (d === 2) { if (y === CHUNK_HEIGHT - 1) continue; j = i + 256; }
      else if (d === 3) { if (y === 0) continue; j = i - 256; }
      else if (d === 4) { if (z === 15) continue; j = i + 16; }
      else { if (z === 0) continue; j = i - 16; }
      const id = blocks[j] & ID_MASK;
      if (BLOCK_FLAGS[id] & F_OPAQUE) continue;
      const f = BLOCK_FILTER[id];
      const nl = shift === SKY && d === 3 && L === 15 && f === 0 ? 15 : L - 1 - f;
      if (nl > ((light[j] >> shift) & 15)) {
        light[j] = (light[j] & keep) | (nl << shift);
        q[tail++ & LQ_MASK] = j;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// World lighting (main thread)
// ---------------------------------------------------------------------------------------------

/** What the light engine needs from the world store. */
export interface LightAccess {
  chunk(cx: number, cz: number): Chunk | undefined;
  /** Called for every cell whose light changed (used to mark meshes dirty). */
  lightChanged(x: number, y: number, z: number): void;
}

const CAP = 1 << 18;
const CAP_MASK = CAP - 1;
const DX = [1, -1, 0, 0, 0, 0];
const DY = [0, 0, 1, -1, 0, 0];
const DZ = [0, 0, 0, 0, 1, -1];
/** Upper bound of BFS steps per update, so a pathological edit can't freeze a frame. */
const MAX_STEPS = 400_000;

export class LightEngine {
  private readonly ix = new Int32Array(CAP);
  private readonly iy = new Int32Array(CAP);
  private readonly iz = new Int32Array(CAP);
  private ih = 0;
  private it = 0;
  private readonly rx = new Int32Array(CAP);
  private readonly ry = new Int32Array(CAP);
  private readonly rz = new Int32Array(CAP);
  private readonly rl = new Uint8Array(CAP);
  private rh = 0;
  private rt = 0;
  private readonly emitters: number[] = [];
  private cache: Chunk | undefined;

  constructor(private readonly world: LightAccess) {}

  /** Re-lights around a changed block (both channels). */
  update(x: number, y: number, z: number): void {
    if (y < 0 || y >= CHUNK_HEIGHT) return;
    for (const shift of [SKY, BLK]) {
      const old = this.level(x, y, z, shift);
      if (old < 0) continue;
      if (old > 0) {
        this.setLevel(x, y, z, shift, 0);
        this.pushRemove(x, y, z, old);
      }
      this.runRemove(shift);
      const id = this.id(x, y, z);
      if (shift === BLK && BLOCK_EMISSION[id] > 0) {
        this.setLevel(x, y, z, BLK, BLOCK_EMISSION[id]);
        this.pushInc(x, y, z);
      }
      for (let d = 0; d < 6; d++) {
        if (this.level(x + DX[d], y + DY[d], z + DZ[d], shift) > 0) this.pushInc(x + DX[d], y + DY[d], z + DZ[d]);
      }
      this.runInc(shift);
    }
  }

  /** Propagates light across the borders between a newly loaded chunk and its loaded neighbours. */
  stitch(chunk: Chunk): void {
    const neighbours = [
      this.world.chunk(chunk.cx - 1, chunk.cz),
      this.world.chunk(chunk.cx + 1, chunk.cz),
      this.world.chunk(chunk.cx, chunk.cz - 1),
      this.world.chunk(chunk.cx, chunk.cz + 1),
    ];
    const bx = chunk.cx * 16;
    const bz = chunk.cz * 16;
    for (const shift of [SKY, BLK]) {
      for (let s = 0; s < 4; s++) {
        if (!neighbours[s]) continue;
        for (let k = 0; k < 16; k++) {
          // a: cell on this chunk's edge, b: the cell across the border.
          const ax = s === 0 ? bx : s === 1 ? bx + 15 : bx + k;
          const az = s === 2 ? bz : s === 3 ? bz + 15 : bz + k;
          const nx = s === 0 ? ax - 1 : s === 1 ? ax + 1 : ax;
          const nz = s === 2 ? az - 1 : s === 3 ? az + 1 : az;
          for (let y = 0; y < CHUNK_HEIGHT; y++) {
            const a = this.level(ax, y, az, shift);
            const b = this.level(nx, y, nz, shift);
            if (a < 0 || b < 0) continue;
            if (a > b + 1) this.pushInc(ax, y, az);
            else if (b > a + 1) this.pushInc(nx, y, nz);
          }
        }
      }
      this.runInc(shift);
    }
  }

  // -- queue helpers ---------------------------------------------------------------------------

  private pushInc(x: number, y: number, z: number): void {
    if (this.it - this.ih >= CAP) return;
    const i = this.it++ & CAP_MASK;
    this.ix[i] = x;
    this.iy[i] = y;
    this.iz[i] = z;
  }

  private pushRemove(x: number, y: number, z: number, l: number): void {
    if (this.rt - this.rh >= CAP) return;
    const i = this.rt++ & CAP_MASK;
    this.rx[i] = x;
    this.ry[i] = y;
    this.rz[i] = z;
    this.rl[i] = l;
  }

  private runRemove(shift: number): void {
    let steps = 0;
    while (this.rh !== this.rt && steps++ < MAX_STEPS) {
      const i = this.rh++ & CAP_MASK;
      const x = this.rx[i], y = this.ry[i], z = this.rz[i], L = this.rl[i];
      for (let d = 0; d < 6; d++) {
        const nx = x + DX[d], ny = y + DY[d], nz = z + DZ[d];
        const nl = this.level(nx, ny, nz, shift);
        if (nl <= 0) continue;
        if (nl < L || (shift === SKY && d === 3 && L === 15 && nl === 15)) {
          this.setLevel(nx, ny, nz, shift, 0);
          this.pushRemove(nx, ny, nz, nl);
          if (shift === BLK && BLOCK_EMISSION[this.id(nx, ny, nz)] > 0) this.emitters.push(nx, ny, nz);
        } else {
          this.pushInc(nx, ny, nz);
        }
      }
    }
    this.rh = this.rt = 0;
    for (let k = 0; k < this.emitters.length; k += 3) {
      const x = this.emitters[k], y = this.emitters[k + 1], z = this.emitters[k + 2];
      this.setLevel(x, y, z, BLK, BLOCK_EMISSION[this.id(x, y, z)]);
      this.pushInc(x, y, z);
    }
    this.emitters.length = 0;
  }

  private runInc(shift: number): void {
    let steps = 0;
    while (this.ih !== this.it && steps++ < MAX_STEPS) {
      const i = this.ih++ & CAP_MASK;
      const x = this.ix[i], y = this.iy[i], z = this.iz[i];
      const L = this.level(x, y, z, shift);
      if (L <= 1) continue;
      for (let d = 0; d < 6; d++) {
        const nx = x + DX[d], ny = y + DY[d], nz = z + DZ[d];
        if (ny < 0 || ny >= CHUNK_HEIGHT) continue;
        const c = this.chunkAt(nx, nz);
        if (!c) continue;
        const li = (nx & 15) | ((nz & 15) << 4) | (ny << 8);
        const id = c.blocks[li] & ID_MASK;
        if (BLOCK_FLAGS[id] & F_OPAQUE) continue;
        const f = BLOCK_FILTER[id];
        const nl = shift === SKY && d === 3 && L === 15 && f === 0 ? 15 : L - 1 - f;
        const cur = (c.light[li] >> shift) & 15;
        if (nl > cur) {
          c.light[li] = (c.light[li] & (shift === SKY ? 0x0f : 0xf0)) | (nl << shift);
          this.world.lightChanged(nx, ny, nz);
          this.pushInc(nx, ny, nz);
        }
      }
    }
    this.ih = this.it = 0;
  }

  // -- world access ----------------------------------------------------------------------------

  private chunkAt(x: number, z: number): Chunk | undefined {
    const cx = x >> 4;
    const cz = z >> 4;
    const c = this.cache;
    if (c && c.cx === cx && c.cz === cz) return c;
    const n = this.world.chunk(cx, cz);
    if (n) this.cache = n;
    return n;
  }

  private id(x: number, y: number, z: number): number {
    const c = this.chunkAt(x, z);
    if (!c || y < 0 || y >= CHUNK_HEIGHT) return 0;
    return c.blocks[(x & 15) | ((z & 15) << 4) | (y << 8)] & ID_MASK;
  }

  /** Light level of a channel, or -1 if unloaded / out of range. */
  private level(x: number, y: number, z: number, shift: number): number {
    if (y < 0 || y >= CHUNK_HEIGHT) return -1;
    const c = this.chunkAt(x, z);
    if (!c) return -1;
    return (c.light[(x & 15) | ((z & 15) << 4) | (y << 8)] >> shift) & 15;
  }

  private setLevel(x: number, y: number, z: number, shift: number, v: number): void {
    const c = this.chunkAt(x, z);
    if (!c) return;
    const li = (x & 15) | ((z & 15) << 4) | (y << 8);
    c.light[li] = (c.light[li] & (shift === SKY ? 0x0f : 0xf0)) | (v << shift);
    this.world.lightChanged(x, y, z);
  }

  /** Drops the cached chunk reference (call when chunks unload). */
  invalidate(): void {
    this.cache = undefined;
  }
}


/**
 * The loaded world: chunk storage, block/light queries, setBlock with events + lighting +
 * remesh marking, support rules, and DDA raycasting.
 */
import {
  BLOCK, BLOCK_FLAGS, F_LIQUID, F_OPAQUE, F_REPLACEABLE, F_SOLID, blockById, blockId,
} from './blocks';
import { Chunk } from './chunk';
import { CHUNK_HEIGHT, ID_MASK, META_SHIFT, chunkIndex, chunkKey, packBlock, sectionKey } from './constants';
import type { ItemStack } from './items';
import { LightEngine } from './light';
import { isFullBox, selectionBox } from './shapes';
import type { BlockSource, EventBus, GameEvents } from '../game/events';
import type { Terrain } from '../world/terrain';
import { biomeName, type BiomeName } from '../world/biomes';
import type { Entity } from './entity';

export interface SetBlockOptions {
  /** 4-bit metadata (facing, door state, crop stage, liquid level). Default 0. */
  meta?: number;
  /** Who changed it; carried into events. Default 'system'. */
  source?: BlockSource;
  /** Drops to report in `blockBroken` (see Game.breakBlock, which rolls them). */
  drops?: ItemStack[];
  tool?: ItemStack | null;
  entity?: Entity;
  /** Skip events (bulk edits); lighting and remeshing still happen. */
  silent?: boolean;
}

export interface RaycastHit {
  /** Block coordinates of the hit block. */
  x: number; y: number; z: number;
  id: number;
  meta: number;
  /** Face index hit (0 +X, 1 -X, 2 +Y, 3 -Y, 4 +Z, 5 -Z). */
  face: number;
  normal: [number, number, number];
  /** Cell where a block would be placed against this face. */
  place: { x: number; y: number; z: number };
  distance: number;
  point: { x: number; y: number; z: number };
}

export interface RaycastOptions {
  /** Also stop at liquids. Default false. */
  liquids?: boolean;
  /** Return false to ignore a block type. */
  filter?: (id: number) => boolean;
}

const FACE_NORMALS: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export class WorldStore {
  readonly chunks = new Map<number, Chunk>();
  /** Section keys needing a remesh (consumed by the ChunkManager). */
  readonly dirty = new Set<number>();
  /** Sections the player just edited: remeshed and uploaded first. */
  readonly urgent = new Set<number>();
  readonly light: LightEngine;
  /** Called for every block edit after generation, for saving diffs. */
  onEdit: ((x: number, y: number, z: number, raw: number) => void) | null = null;
  private cache: Chunk | undefined;

  constructor(readonly events: EventBus<GameEvents>, readonly terrain: Terrain) {
    this.light = new LightEngine({
      chunk: (cx, cz) => this.chunks.get(chunkKey(cx, cz)),
      lightChanged: (x, y, z) => this.markDirty(x, y, z, false),
    });
  }

  // -- chunks ----------------------------------------------------------------------------------

  chunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  /** Chunk containing world column (x, z). */
  chunkAt(x: number, z: number): Chunk | undefined {
    const cx = x >> 4, cz = z >> 4;
    const c = this.cache;
    if (c && c.cx === cx && c.cz === cz) return c;
    const n = this.chunks.get(chunkKey(cx, cz));
    if (n) this.cache = n;
    return n;
  }

  isLoaded(x: number, z: number): boolean {
    return this.chunkAt(Math.floor(x), Math.floor(z)) !== undefined;
  }

  /** Inserts a generated chunk, stitches light with neighbours and marks sections dirty. */
  addChunk(chunk: Chunk): void {
    this.chunks.set(chunk.key, chunk);
    this.light.stitch(chunk);
    for (let sy = 0; sy < 8; sy++) this.dirty.add(sectionKey(chunk.cx, chunk.cz, sy));
    this.events.emit('chunkLoaded', { cx: chunk.cx, cz: chunk.cz });
  }

  removeChunk(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    if (!this.chunks.delete(key)) return;
    this.cache = undefined;
    this.light.invalidate();
    for (let sy = 0; sy < 8; sy++) {
      this.dirty.delete(sectionKey(cx, cz, sy));
      this.urgent.delete(sectionKey(cx, cz, sy));
    }
    this.events.emit('chunkUnloaded', { cx, cz });
  }

  // -- queries ---------------------------------------------------------------------------------

  /** Block type id at integer coords (air if unloaded or out of range). */
  getBlock(x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_HEIGHT) return BLOCK.air;
    const c = this.chunkAt(x, z);
    return c ? c.blocks[chunkIndex(x & 15, y, z & 15)] & ID_MASK : BLOCK.air;
  }

  /** 4-bit metadata at integer coords. */
  getMeta(x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_HEIGHT) return 0;
    const c = this.chunkAt(x, z);
    return c ? c.blocks[chunkIndex(x & 15, y, z & 15)] >> META_SHIFT : 0;
  }

  /** Raw packed value (id | meta << 12). */
  getRaw(x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_HEIGHT) return 0;
    const c = this.chunkAt(x, z);
    return c ? c.blocks[chunkIndex(x & 15, y, z & 15)] : 0;
  }

  /** Block name at integer coords. */
  getBlockName(x: number, y: number, z: number): string {
    return blockById(this.getBlock(x, y, z)).name;
  }

  getSkyLight(x: number, y: number, z: number): number {
    if (y >= CHUNK_HEIGHT) return 15;
    if (y < 0) return 0;
    const c = this.chunkAt(x, z);
    return c ? c.light[chunkIndex(x & 15, y, z & 15)] >> 4 : 15;
  }

  getBlockLight(x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_HEIGHT) return 0;
    const c = this.chunkAt(x, z);
    return c ? c.light[chunkIndex(x & 15, y, z & 15)] & 15 : 0;
  }

  /**
   * Effective light 0..15 at a block, with sky light scaled by `daylight` (0..1).
   * Mob spawning: hostile if `getLight(x, y, z, daylight) <= 7`.
   */
  getLight(x: number, y: number, z: number, daylight = 1): number {
    const sky = this.getSkyLight(x, y, z);
    const blk = this.getBlockLight(x, y, z);
    return Math.max(blk, Math.round(sky - (1 - daylight) * 11));
  }

  isSolid(x: number, y: number, z: number): boolean {
    return (BLOCK_FLAGS[this.getBlock(x, y, z)] & F_SOLID) !== 0;
  }

  isOpaque(x: number, y: number, z: number): boolean {
    return (BLOCK_FLAGS[this.getBlock(x, y, z)] & F_OPAQUE) !== 0;
  }

  isLiquid(x: number, y: number, z: number): boolean {
    return (BLOCK_FLAGS[this.getBlock(x, y, z)] & F_LIQUID) !== 0;
  }

  isReplaceable(x: number, y: number, z: number): boolean {
    return (BLOCK_FLAGS[this.getBlock(x, y, z)] & F_REPLACEABLE) !== 0;
  }

  /** y of the highest non-air block in a column (terrain estimate if the chunk isn't loaded). */
  heightAt(x: number, z: number): number {
    x = Math.floor(x);
    z = Math.floor(z);
    const c = this.chunkAt(x, z);
    if (!c) return this.terrain.heightAt(x, z);
    return c.heights[(x & 15) | ((z & 15) << 4)];
  }

  /** y of the highest solid (collidable) block in a column, or -1. */
  topSolidY(x: number, z: number): number {
    x = Math.floor(x);
    z = Math.floor(z);
    for (let y = this.heightAt(x, z); y >= 0; y--) if (this.isSolid(x, y, z)) return y;
    return -1;
  }

  /**
   * Finds a standing position: the lowest y <= fromY (default: column top) where the block below
   * is solid and two blocks of headroom are free. Returns the feet y, or null.
   */
  findGround(x: number, z: number, fromY?: number): number | null {
    x = Math.floor(x);
    z = Math.floor(z);
    if (!this.chunkAt(x, z)) return this.terrain.heightAt(x, z) + 1;
    const start = Math.min(CHUNK_HEIGHT - 2, fromY ?? this.heightAt(x, z) + 1);
    for (let y = start; y >= 1; y--) {
      if (this.isSolid(x, y - 1, z) && !this.isSolid(x, y, z) && !this.isSolid(x, y + 1, z) && !this.isLiquid(x, y, z)) return y;
    }
    return null;
  }

  biomeAt(x: number, z: number): BiomeName {
    x = Math.floor(x);
    z = Math.floor(z);
    const c = this.chunkAt(x, z);
    return biomeName(c ? c.biomes[(x & 15) | ((z & 15) << 4)] : this.terrain.biomeAt(x, z));
  }

  // -- edits -----------------------------------------------------------------------------------

  /**
   * Sets a block. Fires `blockChanged` plus `blockBroken`/`blockPlaced`, relights, marks sections
   * (and neighbours) for remesh, records the save diff, and applies support rules (plants, torches,
   * doors). Returns false if the chunk isn't loaded or nothing changed.
   */
  setBlock(x: number, y: number, z: number, id: number, opts: SetBlockOptions = {}): boolean {
    x = Math.floor(x);
    y = Math.floor(y);
    z = Math.floor(z);
    if (y < 0 || y >= CHUNK_HEIGHT) return false;
    const c = this.chunkAt(x, z);
    if (!c) return false;
    const meta = opts.meta ?? 0;
    const raw = packBlock(id, meta);
    const lx = x & 15, lz = z & 15;
    const prevRaw = c.getRaw(lx, y, lz);
    if (prevRaw === raw) return false;
    c.setRaw(lx, y, lz, raw);
    const prevId = prevRaw & ID_MASK;
    const prevMeta = prevRaw >> META_SHIFT;
    this.onEdit?.(x, y, z, raw);
    this.markDirty(x, y, z, true);
    this.light.update(x, y, z);
    const source = opts.source ?? 'system';
    if (!opts.silent) {
      this.events.emit('blockChanged', { x, y, z, id, meta, prevId, prevMeta, source });
      const prevDef = blockById(prevId);
      if (prevId !== BLOCK.air && !prevDef.liquid && (id === BLOCK.air || BLOCK_FLAGS[id] & F_LIQUID)) {
        this.events.emit('blockBroken', {
          x, y, z, id: prevId, meta: prevMeta, source, tool: opts.tool ?? null, drops: opts.drops ?? [], dropsHandled: false, entity: opts.entity,
        });
      } else if (id !== BLOCK.air && !(BLOCK_FLAGS[id] & F_LIQUID)) {
        this.events.emit('blockPlaced', { x, y, z, id, meta, prevId, source, entity: opts.entity });
      }
    }
    if (prevId !== id) this.applySupport(x, y, z, prevId, prevMeta);
    return true;
  }

  /** Sets a block by name (convenience for scripts and other lanes). */
  setBlockByName(x: number, y: number, z: number, name: string, opts?: SetBlockOptions): boolean {
    return this.setBlock(x, y, z, blockId(name), opts);
  }

  /** Remove blocks that lost their support after (x, y, z) changed. */
  private applySupport(x: number, y: number, z: number, prevId: number, prevMeta: number): void {
    const nowSolid = this.isSolid(x, y, z);
    // Door: remove the other half.
    if (blockById(prevId).renderType === 'door') {
      const oy = prevMeta & 8 ? y - 1 : y + 1;
      if (this.getBlock(x, oy, z) === prevId) this.setBlock(x, oy, z, BLOCK.air, { source: 'support' });
    }
    if (nowSolid) return;
    // Things standing on top.
    const above = this.getBlock(x, y + 1, z);
    const aDef = blockById(above);
    if (aDef.needsSupport && !(aDef.renderType === 'torch' && this.getMeta(x, y + 1, z) !== 0)) {
      this.breakNaturally(x, y + 1, z);
    } else if (aDef.renderType === 'door' && !(this.getMeta(x, y + 1, z) & 8)) {
      this.breakNaturally(x, y + 1, z);
    }
    // Wall torches and ladders attached to this block.
    // For a neighbour at (x+dx, z+dz) facing f, the wall it hangs on is at (x+dx)+FACING_DX[f].
    for (const [dx, , dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const nx = x + dx, nz = z + dz;
      const nid = this.getBlock(nx, y, nz);
      const nd = blockById(nid);
      if (nd.renderType !== 'torch' && nd.renderType !== 'ladder') continue;
      const m = this.getMeta(nx, y, nz);
      const f = nd.renderType === 'torch' ? m - 1 : m & 3;
      if (f < 0 || f > 3) continue;
      const wx = nx + [0, 1, 0, -1][f];
      const wz = nz + [-1, 0, 1, 0][f];
      if (wx === x && wz === z) this.breakNaturally(nx, y, nz);
    }
  }

  /** Breaks a block with natural drops (no tool), source 'support'. */
  private breakNaturally(x: number, y: number, z: number): void {
    const id = this.getBlock(x, y, z);
    const def = blockById(id);
    const drops: ItemStack[] = [];
    for (const d of def.dropsByMeta?.(this.getMeta(x, y, z)) ?? def.drops) {
      if (d.chance !== undefined && Math.random() >= d.chance) continue;
      const n = typeof d.count === 'number' ? d.count : d.count ? d.count[0] : 1;
      if (n > 0) drops.push({ item: d.item, count: n });
    }
    this.setBlock(x, y, z, BLOCK.air, { source: 'support', drops });
  }

  /** Marks the section containing (x, y, z) and any neighbour sections it borders as dirty. */
  markDirty(x: number, y: number, z: number, urgent: boolean): void {
    const cx = x >> 4, cz = z >> 4, sy = y >> 4;
    const lx = x & 15, ly = y & 15, lz = z & 15;
    const x0 = lx === 0 ? -1 : 0, x1 = lx === 15 ? 1 : 0;
    const y0 = ly === 0 && sy > 0 ? -1 : 0, y1 = ly === 15 && sy < 7 ? 1 : 0;
    const z0 = lz === 0 ? -1 : 0, z1 = lz === 15 ? 1 : 0;
    for (let dy = y0; dy <= y1; dy++)
      for (let dz = z0; dz <= z1; dz++)
        for (let dx = x0; dx <= x1; dx++) {
          const k = sectionKey(cx + dx, cz + dz, sy + dy);
          this.dirty.add(k);
          if (urgent) this.urgent.add(k);
        }
  }

  // -- raycast ---------------------------------------------------------------------------------

  /**
   * Voxel DDA raycast from `origin` along `dir` (need not be normalised) up to `maxDist` blocks.
   * Partial blocks (plants, torches, doors) are tested against their selection box.
   */
  raycast(
    origin: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    maxDist: number,
    opts: RaycastOptions = {},
  ): RaycastHit | null {
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    const dx = dir.x / len, dy = dir.y / len, dz = dir.z / len;
    let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
    const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const sz = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const tdx = sx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = sy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tdz = sz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tmx = sx > 0 ? (x + 1 - origin.x) * tdx : sx < 0 ? (origin.x - x) * tdx : Infinity;
    let tmy = sy > 0 ? (y + 1 - origin.y) * tdy : sy < 0 ? (origin.y - y) * tdy : Infinity;
    let tmz = sz > 0 ? (z + 1 - origin.z) * tdz : sz < 0 ? (origin.z - z) * tdz : Infinity;
    let face = -1;
    let t = 0;
    for (let steps = 0; steps < 512 && t <= maxDist; steps++) {
      const raw = this.getRaw(x, y, z);
      const id = raw & ID_MASK;
      if (id !== BLOCK.air && (!opts.filter || opts.filter(id))) {
        const isLiquid = (BLOCK_FLAGS[id] & F_LIQUID) !== 0;
        if (isLiquid && opts.liquids) {
          return this.hit(x, y, z, raw, face < 0 ? 2 : face, t, origin, dx, dy, dz);
        }
        const box = selectionBox(id, raw >> META_SHIFT);
        if (box) {
          if (isFullBox(box) && face >= 0) return this.hit(x, y, z, raw, face, t, origin, dx, dy, dz);
          const r = rayBox(origin.x - x, origin.y - y, origin.z - z, dx, dy, dz, box);
          if (r && r.t <= maxDist) return this.hit(x, y, z, raw, r.face, r.t, origin, dx, dy, dz);
        }
      }
      if (tmx < tmy && tmx < tmz) {
        x += sx; t = tmx; tmx += tdx; face = sx > 0 ? 1 : 0;
      } else if (tmy < tmz) {
        y += sy; t = tmy; tmy += tdy; face = sy > 0 ? 3 : 2;
      } else {
        z += sz; t = tmz; tmz += tdz; face = sz > 0 ? 5 : 4;
      }
    }
    return null;
  }

  private hit(
    x: number, y: number, z: number, raw: number, face: number, t: number,
    o: { x: number; y: number; z: number }, dx: number, dy: number, dz: number,
  ): RaycastHit {
    const n = FACE_NORMALS[face];
    return {
      x, y, z,
      id: raw & ID_MASK,
      meta: raw >> META_SHIFT,
      face,
      normal: [n[0], n[1], n[2]],
      place: { x: x + n[0], y: y + n[1], z: z + n[2] },
      distance: t,
      point: { x: o.x + dx * t, y: o.y + dy * t, z: o.z + dz * t },
    };
  }
}

/** Slab test of a ray (origin relative to the cell) against a box; returns entry t and face. */
function rayBox(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  b: readonly number[],
): { t: number; face: number } | null {
  let tmin = -Infinity, tmax = Infinity, face = -1;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  for (let a = 0; a < 3; a++) {
    const lo = b[a], hi = b[a + 3];
    if (Math.abs(d[a]) < 1e-9) {
      if (o[a] < lo || o[a] > hi) return null;
      continue;
    }
    let t1 = (lo - o[a]) / d[a];
    let t2 = (hi - o[a]) / d[a];
    let f1 = a * 2 + 1; // entering through the low side → face points negative
    let f2 = a * 2;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      [f1, f2] = [f2, f1];
    }
    if (t1 > tmin) {
      tmin = t1;
      face = f1;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  // Face index: axis*2 → +axis face, axis*2+1 → -axis face (matches mesh face order).
  return { t: Math.max(0, tmin), face: face < 0 ? 2 : face };
}


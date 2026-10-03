/**
 * Streams chunks around the player: generation requests (gen worker pool), light stitching,
 * section meshing (mesh worker pool, nearest first), frame-budgeted GPU upload, and unloading.
 */
import * as THREE from 'three';
import { buildBlockTable, type BlockTable } from './block-table';
import { BLOCK, onBlockRegistered } from './blocks';
import { Chunk } from './chunk';
import { CHUNK_HEIGHT, SLOTS_PER_ROW, chunkKey, chunkKeyX, chunkKeyZ } from './constants';
import type { ChunkMaterials } from './chunk-material';
import type { TextureAtlas } from './atlas';
import { PAD, PAD2, PAD_VOLUME, type MeshArrays, type SectionMesh } from './mesher';
import { WorkerPool, defaultWorkerCount } from './worker-pool';
import type { WorldStore } from './world-store';
import type { GenRequest, GenResponse } from '../world/gen.worker';
import type { MeshRequest, MeshResponse } from './mesh.worker';
import GenWorker from '../world/gen.worker?worker';
import MeshWorker from './mesh.worker?worker';

interface SectionRender {
  meshes: [THREE.Mesh | null, THREE.Mesh | null, THREE.Mesh | null];
  /** Incremented on every dispatch. */
  dispatched: number;
  /** Version currently shown. */
  applied: number;
}

interface PendingMesh {
  key: number;
  version: number;
  mesh: SectionMesh | null;
}

export interface ChunkManagerOptions {
  world: WorldStore;
  materials: ChunkMaterials;
  atlas: TextureAtlas;
  seed: number;
  /** Saved block edits for a chunk as [index, raw, ...]. */
  diffsFor(cx: number, cz: number): Uint32Array | undefined;
}

export interface ChunkStats {
  loaded: number;
  sections: number;
  meshes: number;
  pendingGen: number;
  pendingMesh: number;
  dirty: number;
}

/** Max ms per frame spent integrating chunks and uploading meshes. */
const FRAME_BUDGET_MS = 4;

export class ChunkManager {
  /** Parent of all section meshes (add to the scene). */
  readonly group = new THREE.Group();
  private renderDistance = 6;
  private readonly genPool: WorkerPool<GenRequest, GenResponse>;
  private readonly meshPool: WorkerPool<MeshRequest, MeshResponse>;
  private readonly requested = new Set<number>();
  private readonly genResults: GenResponse[] = [];
  private readonly meshResults: PendingMesh[] = [];
  private readonly sections = new Map<number, SectionRender>();
  private wanted: number[] = [];
  private candidates: number[] = [];
  private candidatesAt = 0;
  private lastDirtySize = -1;
  private centerX = NaN;
  private centerZ = NaN;
  private table: BlockTable;
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly opts: ChunkManagerOptions) {
    this.group.name = 'chunks';
    const n = defaultWorkerCount();
    this.genPool = new WorkerPool<GenRequest, GenResponse>(() => new GenWorker(), Math.max(1, Math.ceil(n / 2)), 2);
    this.meshPool = new WorkerPool<MeshRequest, MeshResponse>(() => new MeshWorker(), n, 2);
    this.table = buildBlockTable(opts.atlas, SLOTS_PER_ROW);
    this.meshPool.broadcast({ type: 'table', table: this.table });
    this.unsubscribe = onBlockRegistered(() => {
      this.table = buildBlockTable(opts.atlas, SLOTS_PER_ROW);
      this.meshPool.broadcast({ type: 'table', table: this.table });
    });
  }

  get distance(): number {
    return this.renderDistance;
  }

  /** Sets the render distance in chunks (2..10). */
  setRenderDistance(rd: number): void {
    this.renderDistance = Math.max(2, Math.min(10, Math.round(rd)));
    this.centerX = NaN;
  }

  /** Call every frame with the player position. */
  update(px: number, pz: number, now = performance.now()): void {
    if (this.disposed) return;
    const world = this.opts.world;
    const cx = Math.floor(px / 16), cz = Math.floor(pz / 16);
    if (cx !== this.centerX || cz !== this.centerZ) {
      this.centerX = cx;
      this.centerZ = cz;
      this.recenter();
    }

    // 1. Dispatch generation, nearest first.
    if (this.genPool.idle > 0) {
      for (const key of this.wanted) {
        if (this.genPool.idle <= 0) break;
        if (this.requested.has(key) || world.chunks.has(key)) continue;
        this.requestChunk(key);
      }
    }

    const t0 = performance.now();
    // 2. Integrate finished chunks.
    while (this.genResults.length && performance.now() - t0 < FRAME_BUDGET_MS) {
      const r = this.genResults.shift()!;
      const key = chunkKey(r.cx, r.cz);
      this.requested.delete(key);
      if (!this.inRange(r.cx, r.cz, this.renderDistance + 1.6) || world.chunks.has(key)) continue;
      world.addChunk(new Chunk(r.cx, r.cz, r.blocks, r.light, r.biomes));
    }

    // 3. Dispatch meshing: urgent (player edits) first, then nearest dirty sections.
    for (const key of world.urgent) {
      if (this.isMeshable(key)) {
        world.urgent.delete(key);
        world.dirty.delete(key);
        this.dispatchMesh(key);
      } else if (!world.chunks.has(Math.floor(key / 8))) world.urgent.delete(key);
    }
    if (this.meshPool.idle > 0) {
      if (world.dirty.size !== this.lastDirtySize || now - this.candidatesAt > 250 || this.candidates.length === 0) {
        this.rebuildCandidates(now);
      }
      while (this.meshPool.idle > 0 && this.candidates.length) {
        const key = this.candidates.shift()!;
        if (!world.dirty.has(key) || !this.isMeshable(key)) continue;
        world.dirty.delete(key);
        this.dispatchMesh(key);
      }
    }

    // 4. Upload meshes within the remaining budget (always at least one).
    let uploaded = 0;
    while (this.meshResults.length && (uploaded === 0 || performance.now() - t0 < FRAME_BUDGET_MS)) {
      this.applyMesh(this.meshResults.shift()!);
      uploaded++;
    }
  }

  /** Fraction (0..1) of chunks within `radius` of a chunk that are loaded and fully meshed. */
  readiness(cx: number, cz: number, radius: number): number {
    let total = 0, ready = 0;
    const world = this.opts.world;
    for (let dz = -radius; dz <= radius; dz++)
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dz * dz > radius * radius) continue;
        total++;
        const key = chunkKey(cx + dx, cz + dz);
        if (!world.chunks.has(key)) continue;
        let clean = true;
        for (let sy = 0; sy < 8 && clean; sy++) {
          const sk = key * 8 + sy;
          if (world.dirty.has(sk)) clean = false;
          const s = this.sections.get(sk);
          if (s && s.dispatched !== s.applied) clean = false;
        }
        if (clean) ready++;
      }
    return total ? ready / total : 1;
  }

  stats(): ChunkStats {
    let meshes = 0;
    for (const s of this.sections.values()) for (const m of s.meshes) if (m) meshes++;
    return {
      loaded: this.opts.world.chunks.size,
      sections: this.sections.size,
      meshes,
      pendingGen: this.requested.size + this.genResults.length,
      pendingMesh: this.meshPool.inFlight + this.meshResults.length,
      dirty: this.opts.world.dirty.size,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    this.genPool.dispose();
    this.meshPool.dispose();
    for (const s of this.sections.values()) for (const m of s.meshes) if (m) m.geometry.dispose();
    this.sections.clear();
    this.group.clear();
  }

  // -- internals -------------------------------------------------------------------------------

  private inRange(cx: number, cz: number, r: number): boolean {
    const dx = cx - this.centerX, dz = cz - this.centerZ;
    return dx * dx + dz * dz <= r * r;
  }

  private recenter(): void {
    const rd = this.renderDistance;
    const genR = rd + 1.6;
    const r = Math.ceil(genR);
    const list: { key: number; d: number }[] = [];
    for (let dz = -r; dz <= r; dz++)
      for (let dx = -r; dx <= r; dx++) {
        const d = dx * dx + dz * dz;
        if (d <= genR * genR) list.push({ key: chunkKey(this.centerX + dx, this.centerZ + dz), d });
      }
    list.sort((a, b) => a.d - b.d);
    this.wanted = list.map((e) => e.key);
    // Unload far chunks.
    const world = this.opts.world;
    const unloadR = rd + 3;
    for (const key of [...world.chunks.keys()]) {
      const cx = chunkKeyX(key), cz = chunkKeyZ(key);
      if (!this.inRange(cx, cz, unloadR)) this.unloadChunk(cx, cz);
    }
    // Hide sections beyond the render distance (they stay loaded as neighbours).
    for (const [sk, s] of this.sections) {
      const ck = Math.floor(sk / 8);
      const visible = this.inRange(chunkKeyX(ck), chunkKeyZ(ck), rd + 0.5);
      for (const m of s.meshes) if (m) m.visible = visible;
    }
    this.candidatesAt = 0;
  }

  private requestChunk(key: number): void {
    const cx = chunkKeyX(key), cz = chunkKeyZ(key);
    this.requested.add(key);
    const diffs = this.opts.diffsFor(cx, cz);
    const copy = diffs ? diffs.slice() : undefined;
    this.genPool
      .run({ seed: this.opts.seed, cx, cz, diffs: copy }, copy ? [copy.buffer] : [])
      .then((r) => {
        if (!this.disposed) this.genResults.push(r);
      })
      .catch(() => this.requested.delete(key));
  }

  private unloadChunk(cx: number, cz: number): void {
    const key = chunkKey(cx, cz);
    for (let sy = 0; sy < 8; sy++) this.removeSection(key * 8 + sy);
    this.opts.world.removeChunk(cx, cz);
  }

  private removeSection(sk: number): void {
    const s = this.sections.get(sk);
    if (!s) return;
    for (const m of s.meshes) {
      if (!m) continue;
      m.geometry.dispose();
      this.group.remove(m);
    }
    this.sections.delete(sk);
  }

  private rebuildCandidates(now: number): void {
    const world = this.opts.world;
    this.lastDirtySize = world.dirty.size;
    this.candidatesAt = now;
    const rd = this.renderDistance + 0.5;
    const list: { key: number; d: number }[] = [];
    for (const sk of world.dirty) {
      const ck = Math.floor(sk / 8);
      if (!world.chunks.has(ck)) {
        world.dirty.delete(sk);
        continue;
      }
      const dx = chunkKeyX(ck) - this.centerX, dz = chunkKeyZ(ck) - this.centerZ;
      const d = dx * dx + dz * dz;
      if (d > rd * rd) continue;
      list.push({ key: sk, d: d * 4 + Math.abs((sk % 8) - 4) * 0.1 });
    }
    list.sort((a, b) => a.d - b.d);
    this.candidates = list.map((e) => e.key);
  }

  private isMeshable(sk: number): boolean {
    const ck = Math.floor(sk / 8);
    const cx = chunkKeyX(ck), cz = chunkKeyZ(ck);
    const chunks = this.opts.world.chunks;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!chunks.has(chunkKey(cx + dx, cz + dz))) return false;
    return true;
  }

  private dispatchMesh(sk: number): void {
    const ck = Math.floor(sk / 8);
    const sy = sk % 8;
    const cx = chunkKeyX(ck), cz = chunkKeyZ(ck);
    const world = this.opts.world;
    const chunk = world.chunks.get(ck);
    if (!chunk) return;
    let s = this.sections.get(sk);
    if (!s) {
      s = { meshes: [null, null, null], dispatched: 0, applied: 0 };
      this.sections.set(sk, s);
    }
    const version = ++s.dispatched;
    if (chunk.sectionCounts[sy] === 0) {
      this.meshResults.push({ key: sk, version, mesh: null });
      return;
    }
    const blocks = new Uint16Array(PAD_VOLUME);
    const light = new Uint8Array(PAD_VOLUME);
    const near: (Chunk | undefined)[] = [];
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) near.push(world.chunks.get(chunkKey(cx + dx, cz + dz)));
    const y0 = sy * 16;
    for (let pz = 0; pz < PAD; pz++)
      for (let px = 0; px < PAD; px++) {
        const lx = px - 1, lz = pz - 1;
        const ci = (lx < 0 ? 0 : lx > 15 ? 2 : 1) + (lz < 0 ? 0 : lz > 15 ? 2 : 1) * 3;
        const c = near[ci];
        const sx = lx & 15, sz = lz & 15;
        for (let py = 0; py < PAD; py++) {
          const wy = y0 + py - 1;
          const pi = px + pz * PAD + py * PAD2;
          if (wy < 0) {
            blocks[pi] = BLOCK.bedrock; // below the world: hides bottom faces
            continue;
          }
          if (wy >= CHUNK_HEIGHT) {
            light[pi] = 0xf0;
            continue;
          }
          if (!c) continue;
          const i = sx | (sz << 4) | (wy << 8);
          blocks[pi] = c.blocks[i];
          light[pi] = c.light[i];
        }
      }
    this.meshPool
      .run({ type: 'mesh', blocks, light, wx: cx * 16, wy: y0, wz: cz * 16 }, [blocks.buffer, light.buffer])
      .then((r) => {
        if (!this.disposed) this.meshResults.push({ key: sk, version, mesh: r.mesh });
      })
      .catch(() => {});
  }

  private applyMesh(p: PendingMesh): void {
    const s = this.sections.get(p.key);
    if (!s || p.version < s.applied) return;
    s.applied = p.version;
    const ck = Math.floor(p.key / 8);
    const sy = p.key % 8;
    const cx = chunkKeyX(ck), cz = chunkKeyZ(ck);
    const mats = this.opts.materials;
    const passes: (MeshArrays | null)[] = p.mesh ? [p.mesh.opaque, p.mesh.cutout, p.mesh.transparent] : [null, null, null];
    const materials = [mats.opaque, mats.cutout, mats.transparent];
    const visible = this.inRange(cx, cz, this.renderDistance + 0.5);
    for (let i = 0; i < 3; i++) {
      const arr = passes[i];
      let mesh = s.meshes[i];
      if (!arr) {
        if (mesh) {
          mesh.geometry.dispose();
          this.group.remove(mesh);
          s.meshes[i] = null;
        }
        continue;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(arr.positions, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(arr.uvs, 2));
      geo.setAttribute('light', new THREE.BufferAttribute(arr.lights, 4, true));
      geo.setIndex(new THREE.BufferAttribute(arr.indices, 1));
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(8, 8, 8), 14);
      geo.boundingBox = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(16, 16, 16));
      if (mesh) {
        mesh.geometry.dispose();
        mesh.geometry = geo;
      } else {
        mesh = new THREE.Mesh(geo, materials[i]);
        mesh.matrixAutoUpdate = false;
        mesh.position.set(cx * 16, sy * 16, cz * 16);
        mesh.updateMatrix();
        mesh.renderOrder = i;
        this.group.add(mesh);
        s.meshes[i] = mesh;
      }
      mesh.visible = visible;
    }
  }
}

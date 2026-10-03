/**
 * Grid A* over voxels for mobs, villagers and golems.
 *
 * A node is a block position where a body's feet can stand: the block below is solid (or the
 * body swims, hangs on a ladder or clings to a wall), and `height` blocks of air are free.
 * Moves: walk (4 + diagonal), step up 1 (jump), drop up to `maxDrop`, ladders, swimming,
 * optional wall climbing (spiders, `climb_pillar`), doors and digging (`tunnel`).
 *
 * Two ways to use it:
 * - `findPath(world, from, to, opts)` (or `pathfind(from, to, opts)` from mobs/index.ts) runs
 *   synchronously within `maxNodes`.
 * - `getPathfinder(game).request(from, to, opts)` is time-sliced across frames (a few ms per
 *   frame for all mobs together), cached, and returns a {@link PathRequest} you poll or await.
 *
 * Paths are partial by default: when the goal can't be reached (player on a pillar), the path
 * ends at the reachable node closest to the goal.
 */
import { BLOCK, BLOCK_FLAGS, F_CLIMBABLE, F_LIQUID, F_SOLID, blockById } from '../engine/blocks';
import type { WorldStore } from '../engine/world-store';
import type { Game } from '../game/game';
import { service } from '../survival/service';

export type MoveKind = 'walk' | 'jump' | 'drop' | 'climb' | 'swim' | 'ladder' | 'dig';

export interface PathNode {
  x: number;
  y: number;
  z: number;
  /** How this node is entered from the previous one. */
  move: MoveKind;
  /** Solid cells that must be dug out before entering (tunnel paths only). */
  dig?: [number, number, number][];
}

export interface Path {
  nodes: PathNode[];
  /** False when the goal was unreachable and the path ends at the closest reachable node. */
  complete: boolean;
  cost: number;
  /** Nodes expanded (for debugging and budgets). */
  expanded: number;
}

/** Path search options. Every field has a sensible default. */
export interface PathOptions {
  /** Max nodes to expand before giving up (returns a partial path). Default 2500. */
  maxNodes?: number;
  /** Accept any node within this horizontal distance of the goal (and 1.5 vertically). Default 1. */
  range?: number;
  /** Body height in blocks (rounded up). Default 2. */
  height?: number;
  /** Max blocks the body may drop down. Default 3. */
  maxDrop?: number;
  /** May step up 1 block by jumping. Default true. */
  jump?: boolean;
  /** May use ladders. Default true. */
  ladders?: boolean;
  /** May climb any vertical wall (spiders). Default false. */
  climb?: boolean;
  /** May walk through doors (villagers open them). Default false. */
  doors?: boolean;
  /** May swim through water. Default true. */
  swim?: boolean;
  /** May dig through soft blocks (tunnel tactic). Default false. */
  dig?: boolean;
  /** Hardest block that digging may remove. Default 2.5 (cobblestone yes, obsidian/bedrock never). */
  digMaxHardness?: number;
  /** Allow diagonal steps. Default true. */
  diagonal?: boolean;
  /** Return the closest reachable partial path when the goal is unreachable. Default true. */
  partial?: boolean;
  /** Heuristic weight (>1 = faster, less optimal). Default 1.4. */
  greed?: number;
}

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

interface Resolved {
  maxNodes: number;
  range: number;
  height: number;
  maxDrop: number;
  jump: boolean;
  ladders: boolean;
  climb: boolean;
  doors: boolean;
  swim: boolean;
  dig: boolean;
  digMaxHardness: number;
  diagonal: boolean;
  partial: boolean;
  greed: number;
}

function resolve(o: PathOptions): Resolved {
  return {
    maxNodes: o.maxNodes ?? 2500,
    range: o.range ?? 1,
    height: Math.max(1, Math.ceil(o.height ?? 2)),
    maxDrop: o.maxDrop ?? 3,
    jump: o.jump ?? true,
    ladders: o.ladders ?? true,
    climb: o.climb ?? false,
    doors: o.doors ?? false,
    swim: o.swim ?? true,
    dig: o.dig ?? false,
    digMaxHardness: o.digMaxHardness ?? 2.5,
    diagonal: o.diagonal ?? true,
    partial: o.partial ?? true,
    greed: o.greed ?? 1.4,
  };
}

/** Stable key for caching paths by options. */
function optionsKey(o: Resolved): string {
  return `${o.height}${o.maxDrop}${+o.jump}${+o.ladders}${+o.climb}${+o.doors}${+o.swim}${+o.dig}${o.digMaxHardness}${o.range}`;
}

// Cell classification.
const BLOCKED = 0;
const OPEN = 1;
const WATER = 2;
const DIGGABLE = 3;

const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

function key(x: number, y: number, z: number): number {
  // 2^21 range on x/z (±1M blocks), 7 bits for y. Safe integer arithmetic.
  return ((x + 1048576) * 2097152 + (z + 1048576)) * 128 + y;
}

/** Binary min-heap of node indices keyed by f. */
class Heap {
  private readonly items: number[] = [];
  private readonly f: number[] = [];
  get size(): number {
    return this.items.length;
  }
  push(item: number, f: number): void {
    const a = this.items, fs = this.f;
    let i = a.length;
    a.push(item);
    fs.push(f);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (fs[p] <= f) break;
      a[i] = a[p];
      fs[i] = fs[p];
      i = p;
    }
    a[i] = item;
    fs[i] = f;
  }
  pop(): number {
    const a = this.items, fs = this.f;
    const top = a[0];
    const last = a.pop()!;
    const lf = fs.pop()!;
    const n = a.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        let mf = lf;
        if (l < n && fs[l] < mf) {
          m = l;
          mf = fs[l];
        }
        if (r < n && fs[r] < mf) m = r;
        if (m === i) break;
        a[i] = a[m];
        fs[i] = fs[m];
        i = m;
      }
      a[i] = last;
      fs[i] = lf;
    }
    return top;
  }
}

interface Rec {
  x: number;
  y: number;
  z: number;
  g: number;
  parent: number;
  move: MoveKind;
  dig: [number, number, number][] | undefined;
  closed: boolean;
}

/**
 * One resumable A* search. Call `step(iterations)` until it returns true, then read `result`.
 */
export class PathSearch {
  result: Path | null = null;
  done = false;
  private readonly o: Resolved;
  private readonly recs: Rec[] = [];
  private readonly index = new Map<number, number>();
  private readonly open = new Heap();
  private readonly cellCache = new Map<number, number>();
  private best = -1;
  private bestH = Infinity;
  private expanded = 0;
  private readonly gx: number;
  private readonly gy: number;
  private readonly gz: number;

  constructor(private readonly world: WorldStore, from: Vec3Like, to: Vec3Like, opts: PathOptions = {}) {
    this.o = resolve(opts);
    this.gx = Math.floor(to.x);
    this.gy = Math.floor(to.y);
    this.gz = Math.floor(to.z);
    const s = this.startNode(Math.floor(from.x), Math.floor(from.y + 0.01), Math.floor(from.z));
    this.add(s.x, s.y, s.z, 0, -1, 'walk', undefined);
  }

  /** Expands up to `iterations` nodes. Returns true when finished. */
  step(iterations: number): boolean {
    if (this.done) return true;
    const o = this.o;
    for (let it = 0; it < iterations; it++) {
      if (this.open.size === 0 || this.expanded >= o.maxNodes) {
        this.finish(this.best, false);
        return true;
      }
      const ci = this.open.pop();
      const c = this.recs[ci];
      if (c.closed) continue;
      c.closed = true;
      this.expanded++;
      const h = this.h(c.x, c.y, c.z);
      if (h < this.bestH) {
        this.bestH = h;
        this.best = ci;
      }
      if (this.isGoal(c.x, c.y, c.z)) {
        this.finish(ci, true);
        return true;
      }
      this.expand(ci, c);
    }
    return false;
  }

  private finish(ci: number, complete: boolean): void {
    this.done = true;
    if (ci < 0 || (!complete && !this.o.partial)) {
      this.result = null;
      return;
    }
    const nodes: PathNode[] = [];
    let i = ci;
    while (i >= 0) {
      const r = this.recs[i];
      nodes.push({ x: r.x, y: r.y, z: r.z, move: r.move, dig: r.dig });
      i = r.parent;
    }
    nodes.reverse();
    this.result = { nodes, complete, cost: this.recs[ci].g, expanded: this.expanded };
  }

  private isGoal(x: number, y: number, z: number): boolean {
    const dx = x - this.gx, dz = z - this.gz;
    return dx * dx + dz * dz <= this.o.range * this.o.range + 0.01 && Math.abs(y - this.gy) <= 1.5;
  }

  private h(x: number, y: number, z: number): number {
    const dx = Math.abs(x - this.gx), dz = Math.abs(z - this.gz), dy = Math.abs(y - this.gy);
    const diag = Math.min(dx, dz);
    return (diag * 1.414 + (Math.max(dx, dz) - diag) + dy * 1.2) * this.o.greed;
  }

  private add(x: number, y: number, z: number, g: number, parent: number, move: MoveKind, dig: [number, number, number][] | undefined): void {
    const k = key(x, y, z);
    const existing = this.index.get(k);
    if (existing !== undefined) {
      const r = this.recs[existing];
      if (r.closed || r.g <= g) return;
      r.g = g;
      r.parent = parent;
      r.move = move;
      r.dig = dig;
      this.open.push(existing, g + this.h(x, y, z));
      return;
    }
    const idx = this.recs.length;
    this.recs.push({ x, y, z, g, parent, move, dig, closed: false });
    this.index.set(k, idx);
    this.open.push(idx, g + this.h(x, y, z));
  }

  // -- world classification ----------------------------------------------------------------------

  private cell(x: number, y: number, z: number): number {
    if (y < 0) return BLOCKED;
    if (y >= 127) return OPEN;
    const k = key(x, y, z);
    const c = this.cellCache.get(k);
    if (c !== undefined) return c;
    let v: number;
    if (!this.world.isLoaded(x, z)) v = BLOCKED;
    else {
      const id = this.world.getBlock(x, y, z);
      const f = BLOCK_FLAGS[id];
      if (id === BLOCK.lava) v = BLOCKED;
      else if (f & F_LIQUID) v = this.o.swim ? WATER : BLOCKED;
      else if (f & F_SOLID) {
        const def = blockById(id);
        if (def.renderType === 'door' && this.o.doors) v = OPEN;
        else if (this.o.dig && def.hardness >= 0 && def.hardness <= this.o.digMaxHardness && def.renderType !== 'door' && !def.tags.includes('interactive')) v = DIGGABLE;
        else v = BLOCKED;
      } else if (id === BLOCK.cactus) v = BLOCKED;
      else v = OPEN;
    }
    this.cellCache.set(k, v);
    return v;
  }

  private solidBelow(x: number, y: number, z: number): boolean {
    if (y - 1 < 0) return false;
    const id = this.world.getBlock(x, y - 1, z);
    if (id === BLOCK.cactus || id === BLOCK.lava) return false;
    if (!(BLOCK_FLAGS[id] & F_SOLID)) return false;
    // A closed door below isn't a floor you can stand on in a useful way, but is solid; allow it.
    return true;
  }

  private climbable(x: number, y: number, z: number): boolean {
    return this.o.ladders && (BLOCK_FLAGS[this.world.getBlock(x, y, z)] & F_CLIMBABLE) !== 0;
  }

  private wallAdjacent(x: number, y: number, z: number): boolean {
    for (let i = 0; i < 4; i++) {
      const [dx, dz] = DIRS[i];
      if (BLOCK_FLAGS[this.world.getBlock(x + dx, y, z + dz)] & F_SOLID) return true;
    }
    return false;
  }

  /**
   * Checks the body's column at (x,y,z). Returns -1 if blocked, else the number of cells that
   * must be dug (0 = free), and fills `digOut` when digging is needed.
   */
  private column(x: number, y: number, z: number, digOut: [number, number, number][] | null): number {
    let digs = 0;
    for (let i = 0; i < this.o.height; i++) {
      const c = this.cell(x, y + i, z);
      if (c === BLOCKED) return -1;
      if (c === DIGGABLE) {
        digs++;
        digOut?.push([x, y + i, z]);
      }
    }
    return digs;
  }

  /** True if a body can rest at (x,y,z) without falling. */
  private supported(x: number, y: number, z: number): boolean {
    if (this.solidBelow(x, y, z)) return true;
    if (this.cell(x, y, z) === WATER) return true;
    if (this.climbable(x, y, z)) return true;
    if (this.o.climb && this.wallAdjacent(x, y, z)) return true;
    return false;
  }

  private startNode(x: number, y: number, z: number): { x: number; y: number; z: number } {
    for (let d = 0; d <= 4; d++) {
      if (this.column(x, y - d, z, null) >= 0 && this.supported(x, y - d, z)) return { x, y: y - d, z };
    }
    return { x, y, z };
  }

  private digCost(cells: [number, number, number][]): number {
    let c = 0;
    for (const [x, y, z] of cells) c += 3 + blockById(this.world.getBlock(x, y, z)).hardness * 2;
    return c;
  }

  private expand(ci: number, c: Rec): void {
    const o = this.o;
    const { x, y, z, g } = c;
    const inWater = this.cell(x, y, z) === WATER;
    const dirCount = o.diagonal ? 8 : 4;
    for (let d = 0; d < dirCount; d++) {
      const [dx, dz] = DIRS[d];
      const nx = x + dx, nz = z + dz;
      const diagonal = d >= 4;
      if (diagonal) {
        // Both side cells must be free (no corner cutting, no digging diagonally).
        if (this.column(x + dx, y, z, null) !== 0 || this.column(x, y, z + dz, null) !== 0) continue;
      }
      const stepCost = diagonal ? 1.414 : 1;
      // 1. Same level.
      const digs: [number, number, number][] = [];
      const free = this.column(nx, y, nz, diagonal ? null : digs);
      if (free === 0 || (free > 0 && !diagonal)) {
        if (this.supported(nx, y, nz)) {
          const water = this.cell(nx, y, nz) === WATER;
          if (free > 0) this.add(nx, y, nz, g + stepCost + this.digCost(digs), ci, 'dig', digs);
          else this.add(nx, y, nz, g + stepCost * (water ? 2 : 1), ci, water ? 'swim' : 'walk', undefined);
          continue;
        }
        if (free === 0) {
          // 3. Drop down.
          for (let drop = 1; drop <= o.maxDrop + (inWater ? 0 : 0); drop++) {
            const cy = y - drop;
            const cc = this.cell(nx, cy, nz);
            if (cc === BLOCKED || cc === DIGGABLE) break;
            if (this.supported(nx, cy, nz)) {
              this.add(nx, cy, nz, g + stepCost + drop * 0.5, ci, 'drop', undefined);
              break;
            }
          }
          // Below water drops are handled by swimming down.
        }
      }
      // 2. Step up (cardinal only).
      if (!diagonal && (o.jump || inWater)) {
        const head = this.cell(x, y + o.height, z);
        if (head === OPEN || head === WATER) {
          const updigs: [number, number, number][] = [];
          const upFree = this.column(nx, y + 1, nz, updigs);
          if (upFree >= 0 && this.supported(nx, y + 1, nz)) {
            if (upFree === 0) this.add(nx, y + 1, nz, g + 2, ci, 'jump', undefined);
            else if (o.dig) this.add(nx, y + 1, nz, g + 2 + this.digCost(updigs), ci, 'dig', updigs);
          }
        }
      }
    }
    // 4. Vertical: ladders, water, wall climbing.
    const canRise = this.climbable(x, y, z) || inWater || (o.climb && this.wallAdjacent(x, y, z));
    if (canRise) {
      const up = this.cell(x, y + o.height, z);
      if ((up === OPEN || up === WATER) && this.supported(x, y + 1, z)) {
        this.add(x, y + 1, z, g + 1.5, ci, inWater ? 'swim' : this.climbable(x, y, z) ? 'ladder' : 'climb', undefined);
      }
    }
    if (y > 0) {
      const below = this.cell(x, y - 1, z);
      if ((below === OPEN || below === WATER) && (this.climbable(x, y - 1, z) || below === WATER || (o.climb && this.wallAdjacent(x, y - 1, z)))) {
        this.add(x, y - 1, z, g + 1.5, ci, below === WATER ? 'swim' : 'climb', undefined);
      }
    }
    // 5. Dig straight down / up towards the goal (tunnelling to a hiding player).
    if (o.dig) {
      if (this.gy < y && this.cell(x, y - 1, z) === DIGGABLE) {
        const cells: [number, number, number][] = [[x, y - 1, z]];
        this.add(x, y - 1, z, g + 1 + this.digCost(cells), ci, 'dig', cells);
      }
    }
  }
}

/**
 * Synchronous path search (runs up to `maxNodes`). Returns null only when no partial path is
 * possible (or `partial: false` and the goal is unreachable).
 *
 * ```ts
 * const path = findPath(game.world, mob.position, game.player.position, { maxDrop: 3 });
 * ```
 */
export function findPath(world: WorldStore, from: Vec3Like, to: Vec3Like, opts: PathOptions = {}): Path | null {
  const s = new PathSearch(world, from, to, opts);
  s.step(Infinity);
  return s.result;
}

/** A queued, time-sliced path request. */
export class PathRequest {
  done = false;
  result: Path | null = null;
  cancelled = false;
  /** Resolves when the search finishes (null if cancelled or impossible). */
  readonly promise: Promise<Path | null>;
  private resolveFn!: (p: Path | null) => void;
  /** @internal */
  search: PathSearch | null = null;

  constructor(readonly from: Vec3Like, readonly to: Vec3Like, readonly opts: PathOptions, readonly cacheKey: string) {
    this.promise = new Promise((r) => (this.resolveFn = r));
  }

  /** Stops the search (the promise resolves with null). */
  cancel(): void {
    if (this.done) return;
    this.cancelled = true;
    this.complete(null);
  }

  /** @internal */
  complete(p: Path | null): void {
    if (this.done) return;
    this.done = true;
    this.result = p;
    this.resolveFn(p);
  }
}

interface CacheEntry {
  path: Path | null;
  time: number;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * The shared, time-sliced path service. Searches from all mobs share one per-frame budget, and
 * recent results are cached until a block changes near them.
 */
export class Pathfinder {
  /** Milliseconds of A* per frame for all requests together. Default 2.5. */
  budgetMs = 2.5;
  /** Cache lifetime in seconds. */
  cacheSeconds = 2;
  private readonly queue: PathRequest[] = [];
  private readonly cache = new Map<string, CacheEntry>();
  private readonly listeners = new Set<(x: number, y: number, z: number) => void>();
  private now = 0;

  constructor(private readonly game: Game) {
    game.addSystem({ name: 'pathfinder', update: (dt) => this.update(dt) });
    game.events.on('blockChanged', (e) => this.onBlockChanged(e.x, e.y, e.z));
  }

  /**
   * Queues a search. Identical recent requests are served from the cache immediately.
   * Keep the returned request and poll `done` / `result`, or `await request.promise`.
   */
  request(from: Vec3Like, to: Vec3Like, opts: PathOptions = {}): PathRequest {
    const r = resolve(opts);
    const ck = `${Math.floor(from.x)},${Math.floor(from.y + 0.01)},${Math.floor(from.z)}>${Math.floor(to.x)},${Math.floor(to.y)},${Math.floor(to.z)}|${optionsKey(r)}`;
    const req = new PathRequest(from, to, opts, ck);
    const hit = this.cache.get(ck);
    if (hit && this.now - hit.time < this.cacheSeconds) {
      req.complete(hit.path ? clonePath(hit.path) : null);
      return req;
    }
    this.queue.push(req);
    return req;
  }

  /** Runs a search to completion right now (bypasses the budget, still cached). */
  findNow(from: Vec3Like, to: Vec3Like, opts: PathOptions = {}): Path | null {
    return findPath(this.game.world, from, to, opts);
  }

  /** Subscribes to nearby block changes (used by MobBrain to repath). */
  onChange(cb: (x: number, y: number, z: number) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Requests waiting or in progress. */
  get pending(): number {
    return this.queue.length;
  }

  private update(dt: number): void {
    this.now += dt;
    const t0 = performance.now();
    while (this.queue.length) {
      const req = this.queue[0];
      if (req.done) {
        this.queue.shift();
        continue;
      }
      if (!req.search) req.search = new PathSearch(this.game.world, req.from, req.to, req.opts);
      let finished = false;
      while (!finished && performance.now() - t0 < this.budgetMs) finished = req.search.step(64);
      if (!finished) break;
      this.queue.shift();
      const path = req.search.result;
      this.store(req.cacheKey, path);
      req.complete(path);
    }
    if (this.cache.size > 400) {
      for (const [k, v] of this.cache) if (this.now - v.time > this.cacheSeconds) this.cache.delete(k);
    }
  }

  private store(k: string, path: Path | null): void {
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const n of path?.nodes ?? []) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      minZ = Math.min(minZ, n.z);
      maxX = Math.max(maxX, n.x);
      maxY = Math.max(maxY, n.y);
      maxZ = Math.max(maxZ, n.z);
    }
    this.cache.set(k, { path: path ? clonePath(path) : null, time: this.now, minX, minY, minZ, maxX, maxY, maxZ });
  }

  private onBlockChanged(x: number, y: number, z: number): void {
    for (const [k, v] of this.cache) {
      if (!v.path || (x >= v.minX - 2 && x <= v.maxX + 2 && y >= v.minY - 3 && y <= v.maxY + 3 && z >= v.minZ - 2 && z <= v.maxZ + 2)) this.cache.delete(k);
    }
    for (const l of this.listeners) l(x, y, z);
  }
}

function clonePath(p: Path): Path {
  return { ...p, nodes: p.nodes.map((n) => ({ ...n, dig: n.dig?.map((d) => [...d] as [number, number, number]) })) };
}

/** The game's shared path service (created on first use). */
export const getPathfinder = service((game) => new Pathfinder(game));

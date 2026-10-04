/**
 * Villager navigation: a small grid A* over standable block cells.
 *
 * Moves: 8-way walking (diagonals only when both sides are clear), 1-block step ups, drops of up to
 * `maxFall`, ladder climbing and swimming. Doors count as passable (villagers open them).
 * Lava is never entered. V3 may swap this for V1's pathfinder behind the same {@link Navigator}.
 */
import { BLOCK, BLOCK_FLAGS, F_CLIMBABLE, F_SOLID, blockById } from '../engine/blocks';
import type { WorldStore } from '../engine/world-store';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface NavOptions {
  /** Succeed at the first cell within this distance of `to` (default 1.2). */
  reach?: number;
  /** Measure `reach` from this height above the feet (e.g. 1.6 for "can I touch it"). Default 0.5. */
  reachFrom?: number;
  /** Search budget in expanded nodes (default 5000). */
  maxNodes?: number;
  /** Highest drop to walk off (default 3). */
  maxFall?: number;
  /** Body height in blocks (default 2; the golem uses 3). */
  height?: number;
  /** Cells that must not be entered. */
  avoid?: (x: number, y: number, z: number) => boolean;
  /** Return the path to the closest reachable cell when the goal can't be reached. */
  partial?: boolean;
}

/** Anything that can plan a path. Returns feet cells (integers) after the start, or null. */
export interface Navigator {
  path(from: Vec3Like, to: Vec3Like, opts?: NavOptions): Vec3Like[] | null;
}

const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Grid A* navigator over the loaded world. */
export class GridNavigator implements Navigator {
  constructor(private readonly world: WorldStore) {}

  /** True if a body can occupy this cell (air, plants, doors, ladders, water). */
  passable(x: number, y: number, z: number): boolean {
    const id = this.world.getBlock(x, y, z);
    if (id === BLOCK.lava) return false;
    if (!(BLOCK_FLAGS[id] & F_SOLID)) return true;
    return blockById(id).renderType === 'door';
  }

  /** True if a body of `height` can stand with its feet in this cell. */
  standable(x: number, y: number, z: number, height = 2): boolean {
    if (!this.world.isLoaded(x, z)) return false;
    for (let h = 0; h < height; h++) if (!this.passable(x, y + h, z)) return false;
    const below = this.world.getBlock(x, y - 1, z);
    if (below === BLOCK.lava) return false;
    const feet = this.world.getBlock(x, y, z);
    if (BLOCK_FLAGS[feet] & F_CLIMBABLE) return true;
    if (feet === BLOCK.water) return true;
    return (BLOCK_FLAGS[below] & F_SOLID) !== 0 && blockById(below).renderType !== 'door';
  }

  private climbable(x: number, y: number, z: number): boolean {
    return (BLOCK_FLAGS[this.world.getBlock(x, y, z)] & F_CLIMBABLE) !== 0;
  }

  /** Nearest standable cell to a point (searching a small column and ring). */
  snap(p: Vec3Like, height = 2): Vec3Like | null {
    const bx = Math.floor(p.x), by = Math.floor(p.y + 0.01), bz = Math.floor(p.z);
    for (const dy of [0, 1, -1, 2, -2, 3, -3]) if (this.standable(bx, by + dy, bz, height)) return { x: bx, y: by + dy, z: bz };
    for (let r = 1; r <= 2; r++)
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          for (const dy of [0, 1, -1, 2, -2]) if (this.standable(bx + dx, by + dy, bz + dz, height)) return { x: bx + dx, y: by + dy, z: bz + dz };
        }
    return null;
  }

  path(from: Vec3Like, to: Vec3Like, opts: NavOptions = {}): Vec3Like[] | null {
    const height = opts.height ?? 2;
    const reach = opts.reach ?? 1.2;
    const reachFrom = opts.reachFrom ?? 0.5;
    const maxNodes = opts.maxNodes ?? 5000;
    const maxFall = opts.maxFall ?? 3;
    const avoid = opts.avoid;
    const start = this.snap(from, height);
    if (!start) return null;
    const bx = start.x, by = 0, bz = start.z;
    const key = (x: number, y: number, z: number) => (x - bx + 512) + (z - bz + 512) * 1024 + (y - by) * 1048576;
    const tx = to.x, ty = to.y, tz = to.z;
    const goalDist = (x: number, y: number, z: number) => Math.hypot(x + 0.5 - tx, y + reachFrom - ty, z + 0.5 - tz);
    const h = (x: number, y: number, z: number) => {
      const dx = Math.abs(x + 0.5 - tx), dz = Math.abs(z + 0.5 - tz);
      return Math.max(dx, dz) + 0.414 * Math.min(dx, dz) + Math.abs(y - ty) * 0.5;
    };

    const xs: number[] = [], ys: number[] = [], zs: number[] = [], gs: number[] = [], parent: number[] = [];
    const index = new Map<number, number>();
    const closed = new Set<number>();
    const heap = new MinHeap();
    const add = (x: number, y: number, z: number, g: number, p: number): void => {
      const k = key(x, y, z);
      const existing = index.get(k);
      if (existing !== undefined) {
        if (g >= gs[existing] || closed.has(existing)) return;
        gs[existing] = g;
        parent[existing] = p;
        heap.push(existing, g + h(x, y, z));
        return;
      }
      const i = xs.length;
      xs.push(x); ys.push(y); zs.push(z); gs.push(g); parent.push(p);
      index.set(k, i);
      heap.push(i, g + h(x, y, z));
    };
    add(start.x, start.y, start.z, 0, -1);
    let best = 0, bestD = goalDist(start.x, start.y, start.z);
    let found = -1, expanded = 0;
    while (heap.size && expanded < maxNodes) {
      const i = heap.pop();
      if (closed.has(i)) continue;
      closed.add(i);
      expanded++;
      const x = xs[i], y = ys[i], z = zs[i];
      const d = goalDist(x, y, z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
      if (d <= reach) {
        found = i;
        break;
      }
      const g = gs[i];
      const ok = (nx: number, ny: number, nz: number) => !avoid || !avoid(nx, ny, nz);
      // Ladders: straight up / down.
      if (this.climbable(x, y, z) || this.climbable(x, y + 1, z)) {
        if (this.passable(x, y + height, z) && (this.climbable(x, y + 1, z) || this.standable(x, y + 1, z, height)) && ok(x, y + 1, z)) add(x, y + 1, z, g + 1.3, i);
      }
      if (this.climbable(x, y - 1, z) && ok(x, y - 1, z)) add(x, y - 1, z, g + 1.3, i);
      for (const [dx, dz] of DIRS) {
        const nx = x + dx, nz = z + dz;
        const diag = dx !== 0 && dz !== 0;
        if (diag) {
          if (!this.passable(x + dx, y, z) || !this.passable(x + dx, y + 1, z) || !this.passable(x, y, z + dz) || !this.passable(x, y + 1, z + dz)) continue;
        }
        const step = diag ? 1.414 : 1;
        const water = this.world.getBlock(nx, y, nz) === BLOCK.water ? 2 : 0;
        if (this.standable(nx, y, nz, height)) {
          if (ok(nx, y, nz)) add(nx, y, nz, g + step + water, i);
          continue;
        }
        // Step up.
        if (!diag && this.passable(x, y + height, z) && this.standable(nx, y + 1, nz, height)) {
          if (ok(nx, y + 1, nz)) add(nx, y + 1, nz, g + 1.6, i);
          continue;
        }
        // Drop down.
        if (!this.passable(nx, y, nz) || !this.passable(nx, y + 1, nz)) continue;
        for (let k = 1; k <= maxFall; k++) {
          if (!this.passable(nx, y - k + 1, nz)) break;
          if (this.standable(nx, y - k, nz, height)) {
            if (ok(nx, y - k, nz)) add(nx, y - k, nz, g + step + k * 0.6, i);
            break;
          }
        }
      }
    }
    let end = found;
    if (end < 0) {
      if (!opts.partial || best === 0) return found === 0 ? [] : null;
      end = best;
    }
    const out: Vec3Like[] = [];
    for (let i = end; i > 0; i = parent[i]) out.push({ x: xs[i], y: ys[i], z: zs[i] });
    out.reverse();
    return out;
  }
}

/** Binary min-heap of node indices keyed by priority. */
class MinHeap {
  private readonly ids: number[] = [];
  private readonly pr: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, p: number): void {
    const ids = this.ids, pr = this.pr;
    let i = ids.length;
    ids.push(id);
    pr.push(p);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pr[parent] <= p) break;
      ids[i] = ids[parent];
      pr[i] = pr[parent];
      i = parent;
    }
    ids[i] = id;
    pr[i] = p;
  }

  pop(): number {
    const ids = this.ids, pr = this.pr;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastP = pr.pop()!;
    const n = ids.length;
    if (n > 0) {
      let i = 0;
      while (true) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        let mp = lastP;
        if (l < n && pr[l] < mp) {
          m = l;
          mp = pr[l];
        }
        if (r < n && pr[r] < mp) m = r;
        if (m === i) break;
        ids[i] = ids[m];
        pr[i] = pr[m];
        i = m;
      }
      ids[i] = lastId;
      pr[i] = lastP;
    }
    return top;
  }
}

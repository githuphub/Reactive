/**
 * Flow-lite for water and lava. Sources have meta 0; flowing liquid stores its distance from a
 * source (1..7) in the meta. Liquids fall straight down, spread sideways up to a range, and dry
 * up when cut off. Lava meeting water turns into obsidian (source) or cobblestone (flowing).
 */
import { BLOCK, BLOCK_FLAGS, F_REPLACEABLE, F_SOLID, blockById } from '../engine/blocks';
import type { WorldStore } from '../engine/world-store';
import type { BlockChangedEvent, EventBus, GameEvents } from '../game/events';

interface FluidSpec {
  id: number;
  range: number;
  /** Seconds between flow ticks. */
  interval: number;
}

const FLUIDS: FluidSpec[] = [
  { id: BLOCK.water, range: 6, interval: 0.25 },
  { id: BLOCK.lava, range: 3, interval: 1.0 },
];

const MAX_UPDATES_PER_TICK = 400;
const H = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

export class FluidSystem {
  private readonly queues = new Map<number, Set<string>>();
  private readonly timers = new Map<number, number>();
  enabled = true;

  constructor(private readonly world: WorldStore, events: EventBus<GameEvents>) {
    for (const f of FLUIDS) {
      this.queues.set(f.id, new Set());
      this.timers.set(f.id, f.interval);
    }
    events.on('blockChanged', (e) => this.onChanged(e));
  }

  private onChanged(e: BlockChangedEvent): void {
    if (!this.enabled) return;
    this.schedule(e.x, e.y, e.z);
    this.schedule(e.x, e.y + 1, e.z);
    this.schedule(e.x, e.y - 1, e.z);
    for (const [dx, dz] of H) this.schedule(e.x + dx, e.y, e.z + dz);
  }

  /** Queues a cell for the next flow tick if it (or the cell itself) involves a liquid. */
  schedule(x: number, y: number, z: number): void {
    const id = this.world.getBlock(x, y, z);
    for (const f of FLUIDS) {
      if (id === f.id || this.touches(x, y, z, f.id)) this.queues.get(f.id)!.add(`${x},${y},${z}`);
    }
  }

  private touches(x: number, y: number, z: number, id: number): boolean {
    if (this.world.getBlock(x, y + 1, z) === id) return true;
    for (const [dx, dz] of H) if (this.world.getBlock(x + dx, y, z + dz) === id) return true;
    return false;
  }

  update(dt: number): void {
    if (!this.enabled) return;
    for (const f of FLUIDS) {
      let t = this.timers.get(f.id)! - dt;
      if (t <= 0) {
        t = f.interval;
        this.tick(f);
      }
      this.timers.set(f.id, t);
    }
  }

  private tick(f: FluidSpec): void {
    const q = this.queues.get(f.id)!;
    if (q.size === 0) return;
    const cells = [...q].slice(0, MAX_UPDATES_PER_TICK);
    for (const c of cells) q.delete(c);
    for (const c of cells) {
      const [x, y, z] = c.split(',').map(Number);
      this.updateCell(f, x, y, z);
    }
  }

  private updateCell(f: FluidSpec, x: number, y: number, z: number): void {
    const w = this.world;
    if (!w.isLoaded(x, z)) return;
    const id = w.getBlock(x, y, z);
    const other = f.id === BLOCK.water ? BLOCK.lava : BLOCK.water;

    if (id === f.id) {
      const level = w.getMeta(x, y, z);
      // Lava touching water hardens.
      if (f.id === BLOCK.lava && (w.getBlock(x, y + 1, z) === other || H.some(([dx, dz]) => w.getBlock(x + dx, y, z + dz) === other))) {
        w.setBlock(x, y, z, level === 0 ? BLOCK.obsidian : BLOCK.cobblestone, { source: 'fluid' });
        return;
      }
      if (level > 0) {
        // Flowing: check it is still fed.
        const expected = this.expectedLevel(f, x, y, z);
        if (expected < 0) {
          w.setBlock(x, y, z, BLOCK.air, { source: 'fluid' });
          return;
        }
        if (expected !== level) {
          w.setBlock(x, y, z, f.id, { meta: expected, source: 'fluid' });
          return;
        }
      }
      this.spread(f, x, y, z, level);
      return;
    }
    // Empty or replaceable cell next to liquid: maybe fill.
    if (id === BLOCK.air || BLOCK_FLAGS[id] & F_REPLACEABLE) {
      const expected = this.expectedLevel(f, x, y, z);
      if (expected > 0) this.fill(f, x, y, z, expected);
    }
  }

  /** Level this cell should have from its neighbours, or -1 if not fed. */
  private expectedLevel(f: FluidSpec, x: number, y: number, z: number): number {
    const w = this.world;
    if (w.getBlock(x, y + 1, z) === f.id) return 1;
    let best = 99;
    for (const [dx, dz] of H) {
      if (w.getBlock(x + dx, y, z + dz) !== f.id) continue;
      const m = w.getMeta(x + dx, y, z + dz);
      // Flowing liquid only feeds sideways when it rests on something solid (no spreading mid-fall).
      if (m > 0 && !(BLOCK_FLAGS[w.getBlock(x + dx, y - 1, z + dz)] & F_SOLID)) continue;
      best = Math.min(best, m + 1);
    }
    return best <= f.range ? best : -1;
  }

  private spread(f: FluidSpec, x: number, y: number, z: number, level: number): void {
    const w = this.world;
    const below = w.getBlock(x, y - 1, z);
    if (y > 0 && (below === BLOCK.air || (BLOCK_FLAGS[below] & F_REPLACEABLE && below !== f.id && !blockById(below).liquid))) {
      this.fill(f, x, y - 1, z, 1);
      return;
    }
    if (below === f.id) return;
    if (level >= f.range) return;
    for (const [dx, dz] of H) {
      const nid = w.getBlock(x + dx, y, z + dz);
      const other = f.id === BLOCK.water ? BLOCK.lava : BLOCK.water;
      if (nid === BLOCK.air || nid === other || (BLOCK_FLAGS[nid] & F_REPLACEABLE && !blockById(nid).liquid)) this.fill(f, x + dx, y, z + dz, level + 1);
    }
  }

  private fill(f: FluidSpec, x: number, y: number, z: number, level: number): void {
    const cur = this.world.getBlock(x, y, z);
    const other = f.id === BLOCK.water ? BLOCK.lava : BLOCK.water;
    if (cur === other) {
      if (f.id === BLOCK.water) this.world.setBlock(x, y, z, this.world.getMeta(x, y, z) === 0 ? BLOCK.obsidian : BLOCK.cobblestone, { source: 'fluid' });
      return;
    }
    if (cur !== BLOCK.air && !(BLOCK_FLAGS[cur] & F_REPLACEABLE)) return;
    this.world.setBlock(x, y, z, f.id, { meta: Math.min(7, level), source: 'fluid' });
  }
}

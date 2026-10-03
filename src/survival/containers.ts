/**
 * Block containers: chest inventories and furnace state, keyed by block position and saved in
 * the 'containers' save slot. Furnaces keep smelting while their screen is closed.
 * Breaking (or blowing up) a container drops its contents.
 */
import { BLOCK } from '../engine/blocks';
import { findItem, type ItemStack } from '../engine/items';
import type { Game } from '../game/game';
import { dropItems } from './item-drops';
import { getParticles } from './particles';
import { fuelTime, smeltingFor } from './recipes';
import { service } from './service';

export const CHEST_SIZE = 27;

export interface ChestState {
  type: 'chest';
  slots: (ItemStack | null)[];
}

export interface FurnaceState {
  type: 'furnace';
  input: ItemStack | null;
  fuel: ItemStack | null;
  output: ItemStack | null;
  /** Seconds of burn left from the current fuel item. */
  burn: number;
  /** Burn time of the current fuel item (for the flame gauge). */
  burnMax: number;
  /** 0..1 progress of the item being smelted. */
  progress: number;
}

export type ContainerState = ChestState | FurnaceState;

function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

export class Containers {
  private readonly map = new Map<string, ContainerState>();
  private readonly listeners = new Set<() => void>();
  private fxTimer = 0;

  constructor(private readonly game: Game) {
    game.save.register(
      'containers',
      () => Object.fromEntries([...this.map].map(([k, v]) => [k, structuredClone(v)])),
      (d: Record<string, ContainerState>) => {
        for (const [k, v] of Object.entries(d ?? {})) this.map.set(k, sanitize(v));
      },
    );
    game.events.on('blockBroken', (e) => {
      if (e.id !== BLOCK.chest && e.id !== BLOCK.furnace) return;
      const k = key(e.x, e.y, e.z);
      const c = this.map.get(k);
      if (!c) return;
      this.map.delete(k);
      const items = c.type === 'chest' ? c.slots : [c.input, c.fuel, c.output];
      dropItems(game, items, { x: e.x + 0.5, y: e.y + 0.5, z: e.z + 0.5 });
      this.changed();
    });
    game.addSystem({ name: 'furnaces', update: (dt) => this.update(dt) });
  }

  /** Chest state at a position (created empty on first access). */
  chest(x: number, y: number, z: number): ChestState {
    const k = key(x, y, z);
    let c = this.map.get(k);
    if (!c || c.type !== 'chest') {
      c = { type: 'chest', slots: new Array(CHEST_SIZE).fill(null) };
      this.map.set(k, c);
    }
    return c;
  }

  /** Furnace state at a position (created empty on first access). */
  furnace(x: number, y: number, z: number): FurnaceState {
    const k = key(x, y, z);
    let c = this.map.get(k);
    if (!c || c.type !== 'furnace') {
      c = { type: 'furnace', input: null, fuel: null, output: null, burn: 0, burnMax: 0, progress: 0 };
      this.map.set(k, c);
    }
    return c;
  }

  /** Container at a position, if one has been used there. */
  get(x: number, y: number, z: number): ContainerState | undefined {
    return this.map.get(key(x, y, z));
  }

  /** Call after editing a container's contents (saves and refreshes open screens). */
  changed(): void {
    this.game.save.markDirty('containers');
    for (const l of this.listeners) l();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private update(dt: number): void {
    let any = false;
    this.fxTimer -= dt;
    const fx = this.fxTimer <= 0;
    if (fx) this.fxTimer = 0.25;
    for (const [k, c] of this.map) {
      if (c.type !== 'furnace') continue;
      if (c.burn <= 0 && !c.input && c.progress <= 0) continue;
      if (this.tickFurnace(k, c, dt)) any = true;
      if (fx && c.burn > 0) {
        const [x, y, z] = k.split(',').map(Number);
        const p = this.game.player.position;
        if (Math.abs(p.x - x) < 32 && Math.abs(p.z - z) < 32) {
          getParticles(this.game).burst({ x: x + 0.5, y: y + 0.4, z: z + 0.5, count: 1, color: ['#ffb43a', '#ff7a1e'], speed: 0.3, up: 0.6, gravity: -0.6, size: 0.07, life: 0.5, spread: 0.45 });
          getParticles(this.game).burst({ x: x + 0.5, y: y + 1.05, z: z + 0.5, count: 1, color: ['#8a8a8a', '#6a6a6a'], speed: 0.2, up: 0.8, gravity: -0.8, size: 0.1, life: 0.9, spread: 0.2 });
        }
      }
    }
    if (any) this.changed();
  }

  /** Advances one furnace. Returns true when its visible state changed. */
  private tickFurnace(k: string, c: FurnaceState, dt: number): boolean {
    const recipe = smeltingFor(c.input);
    const outDef = recipe ? findItem(recipe.output) : undefined;
    const outCount = recipe?.count ?? 1;
    const canSmelt = !!recipe && !!outDef && (!c.output || (c.output.item === recipe.output && !c.output.data && c.output.count + outCount <= outDef.maxStack));
    let changed = false;
    if (c.burn <= 0 && canSmelt && c.fuel) {
      const t = fuelTime(c.fuel);
      if (t > 0) {
        c.burn = c.burnMax = t;
        c.fuel.count--;
        if (c.fuel.count <= 0) c.fuel = null;
        changed = true;
      }
    }
    const wasBurning = c.burn > 0;
    if (c.burn > 0) c.burn = Math.max(0, c.burn - dt);
    if (wasBurning && canSmelt) {
      c.progress += dt / (recipe!.time ?? 4);
      if (c.progress >= 1) {
        c.progress = 0;
        const input = c.input!;
        input.count--;
        if (input.count <= 0) c.input = null;
        if (c.output) c.output.count += outCount;
        else c.output = { item: recipe!.output, count: outCount };
        const [x, y, z] = k.split(',').map(Number);
        this.game.events.emit('itemSmelted', { input: input.item, item: recipe!.output, count: outCount, x, y, z });
        changed = true;
      }
    } else if (c.progress > 0) c.progress = Math.max(0, c.progress - dt * 0.5);
    return changed || wasBurning;
  }
}

function sanitize(v: ContainerState): ContainerState {
  const ok = (s: ItemStack | null | undefined): ItemStack | null => (s && findItem(s.item) && s.count > 0 ? { ...s } : null);
  if (v.type === 'chest') {
    const slots = new Array(CHEST_SIZE).fill(null);
    for (let i = 0; i < CHEST_SIZE; i++) slots[i] = ok(v.slots?.[i]);
    return { type: 'chest', slots };
  }
  return { type: 'furnace', input: ok(v.input), fuel: ok(v.fuel), output: ok(v.output), burn: v.burn ?? 0, burnMax: v.burnMax ?? 0, progress: v.progress ?? 0 };
}

/** The game's container store (created on first use; the survival plugin creates it at init). */
export const getContainers = service((game) => new Containers(game));

/**
 * Spawning: natural spawn rules plus the SpawnDirector API used by V3 raids.
 *
 * Natural rules:
 * - Hostiles spawn at night or in darkness (light <= 7) on solid ground 24–64 blocks from the
 *   player, on the surface or in caves, in small packs, up to `hostileCap`.
 * - Animals spawn on grass in daylight, up to `animalCap`.
 * - Natural mobs despawn beyond 96 blocks (and randomly beyond 40). Director mobs are persistent.
 *
 * Director:
 * ```ts
 * const director = getSpawnDirector(game);
 * director.spawnMob('zombie', { x, y, z }, { tactic: 'tunnel' });
 * director.spawnWave({ mob: 'spider', count: 4, tactic: 'climb_pillar', spawn: 'north', center: village });
 * director.onNaturalSpawn((ctx) => { if (insideVillage(ctx)) return false; }); // veto / edit spawns
 * ```
 */
import { BLOCK, BLOCK_FLAGS, F_LIQUID, hasTag } from '../engine/blocks';
import type { Entity } from '../engine/entity';
import { bodyCollides } from '../engine/physics';
import type { Game } from '../game/game';
import { service } from '../survival/service';
import { Mob } from './mob';
import { createMob } from './registry';
import type { SpawnMobOptions } from './types';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Where a wave appears around its centre. */
export type SpawnPlacement = 'near' | 'far' | 'ring' | 'random' | 'north' | 'south' | 'east' | 'west' | Vec3Like;

/** A raid wave, shaped like a Reactive `faction.raid_plan` wave. */
export interface WaveSpec {
  mob: string;
  /** Default 1. */
  count?: number;
  tactic?: string | null;
  /** Default 'ring'. Compass directions are relative to `center` (north = -Z). */
  spawn?: SpawnPlacement;
  /** Default: the player's position. */
  center?: Vec3Like;
  /** Distance from the centre. Default: near 8, far 32, otherwise 18. */
  radius?: number;
  /** Default: the player. */
  target?: 'player' | Entity | null;
  /** Extra spawn options for every mob of the wave. */
  options?: SpawnMobOptions;
}

/** Passed to natural-spawn hooks. Set `type` to swap the mob, or return false to cancel. */
export interface NaturalSpawnContext {
  type: string;
  category: 'hostile' | 'animal';
  x: number;
  y: number;
  z: number;
  /** Pack size about to spawn. */
  count: number;
}

export type NaturalSpawnHook = (ctx: NaturalSpawnContext) => boolean | void;

const HOSTILE_WEIGHTS: [string, number][] = [['zombie', 30], ['skeleton', 24], ['creeper', 20], ['spider', 20], ['baby_zombie', 3]];
const PACK: Record<string, [number, number]> = { zombie: [1, 3], skeleton: [1, 2], creeper: [1, 1], spider: [1, 2], baby_zombie: [1, 1], pig: [2, 4], cow: [2, 4] };

export class SpawnDirector {
  /** Natural spawning on/off (raids can turn it off for a clean stage). */
  naturalSpawning = true;
  hostileCap = 22;
  animalCap = 10;
  /** Natural spawn distance band from the player. */
  minDistance = 24;
  maxDistance = 64;
  despawnDistance = 96;
  private readonly hooks = new Set<NaturalSpawnHook>();
  private timer = 0;
  private animalTimer = 2;

  constructor(private readonly game: Game) {
    game.addSystem({ name: 'mob-spawner', update: (dt) => this.update(dt) });
    // A few animals around the spawn so the world feels alive right away.
    game.events.once('ready', () => {
      if (this.naturalSpawning) this.seedAnimals(6);
    });
  }

  /** Tries `attempts` animal packs 12–40 blocks from the player (daylight, grass only). */
  seedAnimals(attempts: number): void {
    const [min, max] = [this.minDistance, this.maxDistance];
    this.minDistance = 12;
    this.maxDistance = 40;
    try {
      for (let i = 0; i < attempts; i++) this.trySpawnAnimals();
    } finally {
      this.minDistance = min;
      this.maxDistance = max;
    }
  }

  // -- API ---------------------------------------------------------------------------------------

  /**
   * Spawns one mob at a position (feet). Returns null if the type is unknown or the spot is
   * blocked. Director mobs are persistent unless `opts.persistent === false`.
   */
  spawnMob(type: string, pos: Vec3Like, opts: SpawnMobOptions = {}): Mob | null {
    let mob: Mob;
    try {
      mob = createMob(type, opts);
    } catch (err) {
      console.warn(`[mobs] ${(err as Error).message}`);
      return null;
    }
    mob.position.set(pos.x, pos.y, pos.z);
    mob.yaw = Math.random() * Math.PI * 2;
    mob.persistent = opts.persistent ?? opts.reason !== 'natural';
    mob.natural = opts.reason === 'natural';
    if (opts.fireproof) mob.fireproof = true;
    if (opts.shield) mob.shield = true;
    if (opts.health) mob.maxHealth = mob.health = opts.health;
    if (opts.speed) mob.speedMul = opts.speed;
    if (opts.followRange) mob.followRange = opts.followRange;
    else if (opts.tactic || opts.target) mob.followRange = Math.max(mob.followRange, 48);
    if (opts.data) Object.assign(mob.data, opts.data);
    if (opts.tactic) mob.setTactic(opts.tactic);
    if (opts.target !== undefined) mob.setTarget(opts.target);
    this.game.entities.add(mob);
    this.game.events.emit('mobSpawned', { mob, type: mob.type, reason: opts.reason ?? 'director', tactic: mob.tactic });
    if (!mob.natural) mob.puff('#cfcfcf');
    return mob;
  }

  /** Spawns a wave around a centre (default: the player). Returns the mobs that fit. */
  spawnWave(wave: WaveSpec): Mob[] {
    const count = Math.max(1, Math.min(40, Math.floor(wave.count ?? 1)));
    const center = wave.center ?? this.game.player.position;
    const placement = wave.spawn ?? 'ring';
    const radius = wave.radius ?? (placement === 'near' ? 8 : placement === 'far' ? 32 : 18);
    const out: Mob[] = [];
    const ringOffset = Math.random() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      let spot: Vec3Like | null = null;
      if (typeof placement === 'object') {
        spot = this.findSpot(placement.x + (Math.random() - 0.5) * 3, placement.z + (Math.random() - 0.5) * 3, placement.y, 1.9, 1);
      } else {
        let a: number;
        if (placement === 'ring') a = ringOffset + (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
        else if (placement in COMPASS) a = COMPASS[placement as keyof typeof COMPASS] + (Math.random() - 0.5) * 0.9;
        else a = Math.random() * Math.PI * 2;
        for (let tries = 0; tries < 6 && !spot; tries++) {
          const r = radius * (0.85 + Math.random() * 0.3) * Math.pow(0.82, tries);
          spot = this.findSpot(center.x + Math.cos(a) * r, center.z + Math.sin(a) * r, undefined, 1.9, 1);
        }
      }
      if (!spot) continue;
      const mob = this.spawnMob(wave.mob, spot, {
        ...wave.options,
        tactic: wave.tactic ?? wave.options?.tactic ?? null,
        target: wave.target === undefined ? 'player' : wave.target,
        reason: wave.options?.reason ?? 'director',
        fireproof: wave.options?.fireproof ?? true,
      });
      if (mob) out.push(mob);
    }
    return out;
  }

  /** Subscribes a natural-spawn hook (veto with `return false`, or edit `ctx.type`). */
  onNaturalSpawn(hook: NaturalSpawnHook): () => void {
    this.hooks.add(hook);
    return () => this.hooks.delete(hook);
  }

  /** All live mobs. */
  mobs(): Mob[] {
    return this.game.entities.all().filter((e): e is Mob => e instanceof Mob && !e.removed);
  }

  /** Live mobs of a type (or all), optionally within a radius of a point. */
  count(type?: string, near?: Vec3Like, radius = Infinity): number {
    return this.mobs().filter((m) => (!type || m.type === type) && (!near || dist(m.position, near) <= radius)).length;
  }

  /** Removes mobs (all, or those matching a filter) without drops. */
  clear(filter?: (m: Mob) => boolean): number {
    let n = 0;
    for (const m of this.mobs()) {
      if (filter && !filter(m)) continue;
      m.remove();
      n++;
    }
    return n;
  }

  /**
   * A valid feet position near (x, z) for a body of the given size, or null. Looks down from
   * `fromY` (default: the column top). The chunk must be loaded.
   */
  findSpot(x: number, z: number, fromY?: number, height = 1.9, width = 0.6): Vec3Like | null {
    const bx = Math.floor(x), bz = Math.floor(z);
    const world = this.game.world;
    if (!world.isLoaded(bx, bz)) return null;
    const y = world.findGround(bx, bz, fromY !== undefined ? Math.floor(fromY) + 2 : undefined);
    if (y === null) return null;
    if (BLOCK_FLAGS[world.getBlock(bx, y - 1, bz)] & F_LIQUID) return null;
    if (bodyCollides(world, bx + 0.5, y, bz + 0.5, width * 0.9, height)) return null;
    return { x: bx + 0.5, y, z: bz + 0.5 };
  }

  // -- natural spawning --------------------------------------------------------------------------

  private update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.5;
    const p = this.game.player.position;
    let hostiles = 0, animals = 0;
    for (const m of this.mobs()) {
      const d = dist(m.position, p);
      if (!m.persistent && m.natural) {
        if (d > this.despawnDistance || (d > 40 && Math.random() < 0.5 / 30)) {
          m.remove();
          continue;
        }
      }
      if (d > 128 || !m.natural) continue;
      if (m.category === 'hostile') hostiles++;
      else animals++;
    }
    if (!this.naturalSpawning || !this.game.ready) return;
    if (hostiles < this.hostileCap) for (let i = 0; i < 3; i++) this.trySpawnHostile();
    this.animalTimer -= 0.5;
    if (this.animalTimer <= 0 && animals < this.animalCap) {
      this.animalTimer = 3;
      this.trySpawnAnimals();
    }
  }

  private randomColumn(): { x: number; z: number } | null {
    const p = this.game.player.position;
    const a = Math.random() * Math.PI * 2;
    const r = this.minDistance + Math.random() * (this.maxDistance - this.minDistance);
    const x = Math.floor(p.x + Math.cos(a) * r), z = Math.floor(p.z + Math.sin(a) * r);
    return this.game.world.isLoaded(x, z) ? { x, z } : null;
  }

  private standable(x: number, y: number, z: number): boolean {
    const w = this.game.world;
    if (y < 1 || y > 125) return false;
    if (!w.isSolid(x, y - 1, z) || w.isSolid(x, y, z) || w.isSolid(x, y + 1, z) || w.isLiquid(x, y, z)) return false;
    const below = w.getBlock(x, y - 1, z);
    return below !== BLOCK.bedrock && below !== BLOCK.glass && !hasTag(below, 'leaves');
  }

  private trySpawnHostile(): void {
    const col = this.randomColumn();
    if (!col) return;
    const w = this.game.world;
    const { x, z } = col;
    let y: number | null = null;
    if (Math.random() < 0.55) {
      y = w.findGround(x, z);
    } else {
      const top = w.heightAt(x, z) - 3;
      if (top > 6) {
        let cy = 4 + Math.floor(Math.random() * (top - 4));
        for (let k = 0; k < 14 && y === null; k++, cy++) if (this.standable(x, cy, z)) y = cy;
      }
    }
    if (y === null || !this.standable(x, y, z)) return;
    const p = this.game.player.position;
    if (dist({ x: x + 0.5, y, z: z + 0.5 }, p) < this.minDistance) return;
    const dl = this.game.time.daylight * (1 - this.game.weather.darkening * 0.4);
    if (w.getLight(x, y, z, dl) > 7) return;
    const type = weighted(HOSTILE_WEIGHTS);
    this.spawnPack(type, 'hostile', x, y, z);
  }

  private trySpawnAnimals(): void {
    if (this.game.time.daylight < 0.5) return;
    const col = this.randomColumn();
    if (!col) return;
    const w = this.game.world;
    const y = w.findGround(col.x, col.z);
    if (y === null || w.getBlock(col.x, y - 1, col.z) !== BLOCK.grass) return;
    if (w.getLight(col.x, y, col.z, 1) < 9) return;
    this.spawnPack(Math.random() < 0.5 ? 'pig' : 'cow', 'animal', col.x, y, col.z);
  }

  private spawnPack(type: string, category: 'hostile' | 'animal', x: number, y: number, z: number): void {
    const [lo, hi] = PACK[type] ?? [1, 1];
    const ctx: NaturalSpawnContext = { type, category, x: x + 0.5, y, z: z + 0.5, count: lo + Math.floor(Math.random() * (hi - lo + 1)) };
    for (const h of this.hooks) {
      try {
        if (h(ctx) === false) return;
      } catch (err) {
        console.error('[mobs] natural spawn hook failed', err);
      }
    }
    for (let i = 0; i < ctx.count; i++) {
      const sx = Math.floor(ctx.x + (i === 0 ? 0 : (Math.random() - 0.5) * 5));
      const sz = Math.floor(ctx.z + (i === 0 ? 0 : (Math.random() - 0.5) * 5));
      const sy = i === 0 ? ctx.y : this.game.world.findGround(sx, sz, ctx.y + 2);
      if (sy === null || !this.standable(sx, sy, sz)) continue;
      if (bodyCollides(this.game.world, sx + 0.5, sy, sz + 0.5, 0.9, 1.9)) continue;
      this.spawnMob(ctx.type, { x: sx + 0.5, y: sy, z: sz + 0.5 }, { reason: 'natural', persistent: false });
    }
  }
}

const COMPASS = { east: 0, south: Math.PI / 2, west: Math.PI, north: -Math.PI / 2 } as const;

function dist(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function weighted(list: [string, number][]): string {
  const total = list.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [name, w] of list) {
    r -= w;
    if (r <= 0) return name;
  }
  return list[0][0];
}

/** The game's spawn director (created on first use; the mobs plugin creates it at init). */
export const getSpawnDirector = service((game) => new SpawnDirector(game));


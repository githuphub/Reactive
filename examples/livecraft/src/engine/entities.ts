/**
 * Entity manager: owns all entities, runs their updates, syncs their models into the scene,
 * and offers spatial queries + raycasts.
 */
import * as THREE from 'three';
import type { DamageSource, Entity } from './entity';
import type { Game } from '../game/game';

export interface EntityRayHit {
  entity: Entity;
  distance: number;
}

export class EntityManager {
  private readonly list: Entity[] = [];
  private readonly byId = new Map<number, Entity>();
  private lightTimer = 0;
  /** Parent of all entity models. */
  readonly group = new THREE.Group();

  constructor(private readonly game: Game) {
    this.group.name = 'entities';
  }

  /** Adds an entity (and its object3d) to the world. Returns it for chaining. */
  add<T extends Entity>(entity: T): T {
    if (this.byId.has(entity.id)) return entity;
    entity.game = this.game;
    this.list.push(entity);
    this.byId.set(entity.id, entity);
    if (entity.object3d) this.group.add(entity.object3d);
    this.syncObject(entity);
    entity.onAdded();
    this.game.events.emit('entityAdded', { entity });
    return entity;
  }

  /** Removes immediately (prefer `entity.remove()` inside updates). */
  remove(entity: Entity): void {
    if (!this.byId.delete(entity.id)) return;
    const i = this.list.indexOf(entity);
    if (i >= 0) this.list.splice(i, 1);
    entity.removed = true;
    if (entity.object3d) this.group.remove(entity.object3d);
    entity.onRemoved();
    this.game.events.emit('entityRemoved', { entity });
  }

  get(id: number): Entity | undefined {
    return this.byId.get(id);
  }

  /** All live entities (do not mutate). */
  all(): readonly Entity[] {
    return this.list;
  }

  get count(): number {
    return this.list.length;
  }

  ofType<T extends Entity = Entity>(type: string): T[] {
    return this.list.filter((e) => e.type === type) as T[];
  }

  /** Entities whose feet are within `radius` of a point, optionally filtered. */
  query(center: { x: number; y: number; z: number }, radius: number, filter?: (e: Entity) => boolean): Entity[] {
    const r2 = radius * radius;
    const out: Entity[] = [];
    for (const e of this.list) {
      if (e.removed) continue;
      const dx = e.position.x - center.x, dy = e.position.y - center.y, dz = e.position.z - center.z;
      if (dx * dx + dy * dy + dz * dz <= r2 && (!filter || filter(e))) out.push(e);
    }
    return out;
  }

  /** Nearest entity to a point within `radius`. */
  nearest(center: { x: number; y: number; z: number }, radius: number, filter?: (e: Entity) => boolean): Entity | null {
    let best: Entity | null = null;
    let bd = radius * radius;
    for (const e of this.list) {
      if (e.removed || (filter && !filter(e))) continue;
      const dx = e.position.x - center.x, dy = e.position.y - center.y, dz = e.position.z - center.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d <= bd) {
        bd = d;
        best = e;
      }
    }
    return best;
  }

  /** First entity hit by a ray (box test), within maxDist. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, ignore?: Entity): EntityRayHit | null {
    let best: EntityRayHit | null = null;
    const d = dir.clone().normalize();
    for (const e of this.list) {
      if (e === ignore || e.removed) continue;
      const hw = e.width / 2 + 0.05;
      const t = rayAabb(origin, d, e.position.x - hw, e.position.y, e.position.z - hw, e.position.x + hw, e.position.y + e.height, e.position.z + hw);
      if (t !== null && t <= maxDist && (!best || t < best.distance)) best = { entity: e, distance: t };
    }
    return best;
  }

  /** Runs updates; called by the game loop. */
  update(dt: number): void {
    const world = this.game.world;
    for (const e of this.list) {
      if (e.removed) continue;
      if (!world.isLoaded(e.position.x, e.position.z)) continue;
      if (e.hurtCooldown > 0) e.hurtCooldown -= dt;
      try {
        e.update(dt);
      } catch (err) {
        console.error(`[entities] ${e.type}#${e.id} update failed`, err);
      }
      if (e.position.y < -32) e.remove();
      this.syncObject(e);
    }
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i].removed) this.remove(this.list[i]);

    this.lightTimer -= dt;
    if (this.lightTimer <= 0) {
      this.lightTimer = 0.2;
      const daylight = this.game.time.daylight;
      for (const e of this.list) {
        const x = Math.floor(e.position.x), y = Math.floor(e.position.y + Math.min(1, e.height * 0.5)), z = Math.floor(e.position.z);
        const sky = world.getSkyLight(x, y, z) / 15;
        const blk = world.getBlockLight(x, y, z) / 15;
        const level = Math.max(sky * (0.25 + 0.75 * daylight), blk * 0.95);
        e.applyBrightness(0.2 + 0.8 * level);
      }
    }
  }

  /** @internal used by Entity.hurt */
  emitHurt(entity: Entity, amount: number, source: DamageSource): void {
    this.game.events.emit('entityHurt', { entity, amount, source });
  }

  /** @internal used by Entity.hurt */
  emitDied(entity: Entity, source: DamageSource): void {
    this.game.events.emit('entityDied', { entity, source });
  }

  private syncObject(e: Entity): void {
    const o = e.object3d;
    if (!o) return;
    o.position.copy(e.position);
    o.rotation.y = e.yaw;
  }

  dispose(): void {
    for (const e of [...this.list]) this.remove(e);
  }
}

/** Ray vs AABB slab test; returns entry distance or null. */
export function rayAabb(
  o: THREE.Vector3, d: THREE.Vector3,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
): number | null {
  let tmin = 0, tmax = Infinity;
  const lo = [x0, y0, z0], hi = [x1, y1, z1], oo = [o.x, o.y, o.z], dd = [d.x, d.y, d.z];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(dd[a]) < 1e-9) {
      if (oo[a] < lo[a] || oo[a] > hi[a]) return null;
      continue;
    }
    let t1 = (lo[a] - oo[a]) / dd[a];
    let t2 = (hi[a] - oo[a]) / dd[a];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}

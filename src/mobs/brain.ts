/**
 * MobBrain: path following and steering for any `Entity` (mobs, V2 villagers and golems, V3 raid
 * captains). It turns "go there" into per-frame `StepInput` for `entity.move(dt, input)`.
 *
 * ```ts
 * class Golem extends Entity {
 *   brain = new MobBrain(this, { speed: 2, path: { doors: true } });
 *   update(dt: number) {
 *     this.brain.moveTo(target.x, target.y, target.z);  // cheap to call every frame
 *     this.move(dt, this.brain.update(dt));
 *   }
 * }
 * ```
 *
 * The brain requests paths from the shared time-sliced {@link Pathfinder}, steers directly while
 * waiting, repaths when the goal moves or a block changes near the path, jumps steps, swims,
 * climbs ladders, detects being stuck, and smoothly turns the entity.
 */
import * as THREE from 'three';
import { BLOCK_FLAGS, F_SOLID, blockById } from '../engine/blocks';
import type { Entity } from '../engine/entity';
import type { StepInput } from '../engine/physics';
import type { WorldStore } from '../engine/world-store';
import { getPathfinder, type Path, type PathNode, type PathOptions, type PathRequest } from './pathfind';

export interface BrainOptions {
  /** Walking speed in blocks/s. Default 2.5. */
  speed?: number;
  /** Options for every path search (height, climb, doors, dig, ...). With `doors: true` the
   *  brain also opens closed doors it walks through. */
  path?: PathOptions;
  /** Min seconds between repaths when the goal keeps moving. Default 0.7. */
  repathInterval?: number;
  /** Distance at which the goal counts as reached. Default 0.6. */
  arriveDistance?: number;
  /** Turn rate in radians/s. Default 10. */
  turnRate?: number;
  /**
   * Called while a path node needs a block dug out (tunnel paths). Return true once the cell is
   * clear. Without a handler, dig nodes are treated as blocked (repath).
   */
  onDig?: (x: number, y: number, z: number, dt: number) => boolean;
}

export type BrainState = 'idle' | 'waiting' | 'moving' | 'arrived' | 'failed';

export class MobBrain {
  /** Walking speed in blocks/s (change any time). */
  speed: number;
  /** Path options used for new searches (change any time; applies on the next repath). */
  pathOptions: PathOptions;
  repathInterval: number;
  arriveDistance: number;
  turnRate: number;
  onDig: BrainOptions['onDig'];
  /** Current goal, or null when idle. */
  readonly goal = new THREE.Vector3();
  hasGoal = false;
  /** Current path (null while waiting or idle). */
  path: Path | null = null;
  /** Index of the node being walked to. */
  index = 0;
  state: BrainState = 'idle';
  /** When set, the entity faces this point instead of its walking direction. */
  lookTarget: THREE.Vector3 | null = null;
  /** True while digging a tunnel cell this frame. */
  digging = false;

  private request: PathRequest | null = null;
  private sinceRequest = 99;
  private needRepath = false;
  private requestedGoal = new THREE.Vector3(NaN, NaN, NaN);
  private stuckTimer = 0;
  private bestDist = Infinity;
  private stuckCount = 0;
  private failures = 0;
  private unsubscribe: (() => void) | null = null;
  private box = { minX: 0, minY: 0, minZ: 0, maxX: -1, maxY: -1, maxZ: -1 };
  private moveSpeed = 0;

  constructor(readonly entity: Entity, opts: BrainOptions = {}) {
    this.speed = opts.speed ?? 2.5;
    this.pathOptions = { height: Math.ceil(entity.height), ...opts.path };
    this.repathInterval = opts.repathInterval ?? 0.7;
    this.arriveDistance = opts.arriveDistance ?? 0.6;
    this.turnRate = opts.turnRate ?? 10;
    this.onDig = opts.onDig;
  }

  /**
   * Sets (or updates) the goal. Cheap to call every frame: it only repaths when the goal moved
   * more than ~1.5 blocks from the last search, the path broke, or the mob got stuck.
   */
  moveTo(x: number, y: number, z: number, opts: { speed?: number } = {}): void {
    this.goal.set(x, y, z);
    this.hasGoal = true;
    this.moveSpeed = opts.speed ?? 0;
    const moved = Number.isNaN(this.requestedGoal.x) || this.requestedGoal.distanceToSquared(this.goal) > 2.25;
    if (moved) this.needRepath = true;
    if (this.state === 'idle' || this.state === 'arrived') this.state = this.path ? 'moving' : 'waiting';
  }

  /** Stops moving and forgets the path. */
  stop(): void {
    this.hasGoal = false;
    this.path = null;
    this.request?.cancel();
    this.request = null;
    this.state = 'idle';
    this.requestedGoal.set(NaN, NaN, NaN);
    this.needRepath = false;
  }

  /** Forces a new path search on the next update. */
  repath(): void {
    this.needRepath = true;
    this.sinceRequest = 99;
  }

  /** True once within `arriveDistance` of the goal. */
  get arrived(): boolean {
    return this.state === 'arrived';
  }

  /** The node currently walked to, if any. */
  get currentNode(): PathNode | null {
    return this.path && this.index < this.path.nodes.length ? this.path.nodes[this.index] : null;
  }

  /** Remaining path nodes (for debug drawing). */
  get remaining(): PathNode[] {
    return this.path ? this.path.nodes.slice(this.index) : [];
  }

  /** Releases listeners (call from the entity's onRemoved). */
  dispose(): void {
    this.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Computes this frame's movement input and turns the entity. */
  update(dt: number): StepInput {
    const e = this.entity;
    this.sinceRequest += dt;
    this.digging = false;
    if (!this.unsubscribe && e.game) {
      this.unsubscribe = getPathfinder(e.game).onChange((x, y, z) => this.onBlockChange(x, y, z));
    }
    const out: StepInput = { moveX: 0, moveZ: 0, jump: e.inWater };
    if (!this.hasGoal) {
      this.face(dt, null);
      return out;
    }
    const speed = this.moveSpeed || this.speed;

    // Path results.
    if (this.request?.done) {
      const p = this.request.result;
      this.request = null;
      if (p && p.nodes.length > 0) {
        this.setPath(p);
        this.failures = 0;
      } else {
        this.path = null;
        this.failures++;
        if (this.failures > 3) this.state = 'failed';
      }
    }
    if (this.needRepath && !this.request && this.sinceRequest >= this.repathInterval && e.game) {
      this.needRepath = false;
      this.sinceRequest = 0;
      this.requestedGoal.copy(this.goal);
      this.request = getPathfinder(e.game).request(e.position, this.goal, this.pathOptions);
      if (!this.path) this.state = 'waiting';
    }

    const gdx = this.goal.x - e.position.x, gdz = this.goal.z - e.position.z;
    const gd = Math.hypot(gdx, gdz);
    if (gd < this.arriveDistance && Math.abs(this.goal.y - e.position.y) < 1.6) {
      this.state = 'arrived';
      this.face(dt, null);
      return out;
    }

    // Follow the path.
    const path = this.path;
    if (path) {
      let node: PathNode | null = null;
      for (let guard = 0; guard < 4 && this.index < path.nodes.length; guard++) {
        node = path.nodes[this.index];
        if (this.reached(node)) {
          this.index++;
          this.bestDist = Infinity;
          this.stuckTimer = 0;
          node = null;
        } else break;
      }
      if (node) {
        this.state = 'moving';
        // Tunnelling: dig the node's cells before walking in.
        if (node.dig?.length && e.game) {
          const world = e.game.world;
          const cell = node.dig.find(([x, y, z]) => BLOCK_FLAGS[world.getBlock(x, y, z)] & F_SOLID);
          if (cell) {
            if (!this.onDig) {
              this.repath();
              return out;
            }
            this.digging = true;
            this.face(dt, new THREE.Vector3(cell[0] + 0.5, cell[1] + 0.5, cell[2] + 0.5));
            this.onDig(cell[0], cell[1], cell[2], dt);
            return out;
          }
        }
        if (this.pathOptions.doors) this.openDoor(node.x, node.y, node.z);
        const tx = node.x + 0.5, tz = node.z + 0.5;
        const dx = tx - e.position.x, dz = tz - e.position.z;
        const hd = Math.hypot(dx, dz);
        const dy = node.y - e.position.y;
        const slow = hd < 0.6 ? Math.max(0.35, hd / 0.6) : 1;
        if (hd > 0.05) {
          out.moveX = (dx / hd) * speed * slow;
          out.moveZ = (dz / hd) * speed * slow;
        }
        const rising = dy > 0.3;
        out.jump =
          (rising && (hd < 1.4 || e.collidedHorizontally) && (node.move === 'jump' || node.move === 'dig' || node.move === 'walk' || e.collidedHorizontally)) ||
          (e.inWater && dy > -0.5) ||
          ((node.move === 'ladder' || node.move === 'climb' || node.move === 'swim') && rising);
        this.trackStuck(dt, hd + Math.abs(dy) * 0.5, out);
        this.face(dt, out);
        return out;
      }
      // Path exhausted.
      if (!path.complete) {
        if (!this.request && this.sinceRequest > 1.5) this.repath();
      }
    }
    // No path (yet) or path done: steer straight at the goal.
    if (gd > 0.05) {
      out.moveX = (gdx / gd) * speed;
      out.moveZ = (gdz / gd) * speed;
      out.jump = e.collidedHorizontally || e.inWater;
    }
    if (!path && !this.request && this.sinceRequest > this.repathInterval * 2) this.repath();
    this.trackStuck(dt, gd, out);
    this.face(dt, out);
    return out;
  }

  /** Opens a closed door in the cell (or the cell above) the entity is about to enter. */
  private openDoor(x: number, y: number, z: number): void {
    const g = this.entity.game;
    if (!g) return;
    for (let dy = 0; dy < 2; dy++) {
      const id = g.world.getBlock(x, y + dy, z);
      if (blockById(id).renderType !== 'door') continue;
      if (!(g.world.getMeta(x, y + dy, z) & 4)) {
        const below = g.world.getMeta(x, y + dy, z) & 8 ? y + dy - 1 : y + dy;
        if (!(g.world.getMeta(x, below, z) & 4)) g.toggleDoor(x, y + dy, z, true);
      }
      return;
    }
  }

  private setPath(p: Path): void {
    this.path = p;
    this.index = p.nodes.length > 1 ? 1 : 0;
    this.bestDist = Infinity;
    this.stuckTimer = 0;
    this.state = 'moving';
    const b = this.box;
    b.minX = b.minY = b.minZ = Infinity;
    b.maxX = b.maxY = b.maxZ = -Infinity;
    for (const n of p.nodes) {
      b.minX = Math.min(b.minX, n.x);
      b.minY = Math.min(b.minY, n.y);
      b.minZ = Math.min(b.minZ, n.z);
      b.maxX = Math.max(b.maxX, n.x);
      b.maxY = Math.max(b.maxY, n.y);
      b.maxZ = Math.max(b.maxZ, n.z);
    }
    // Skip a first node that lies behind us (we already stand past it).
    if (p.nodes.length > 2) {
      const e = this.entity;
      const a = p.nodes[1], c = p.nodes[2];
      const da = Math.hypot(a.x + 0.5 - e.position.x, a.z + 0.5 - e.position.z);
      const dc = Math.hypot(c.x + 0.5 - e.position.x, c.z + 0.5 - e.position.z);
      if (dc < 1.1 && da < 1.1 && a.y === c.y && Math.abs(a.y - e.position.y) < 0.5 && !a.dig) this.index = 2;
    }
  }

  private reached(n: PathNode): boolean {
    const e = this.entity;
    const hd = Math.hypot(n.x + 0.5 - e.position.x, n.z + 0.5 - e.position.z);
    const dy = n.y - e.position.y;
    if (n.move === 'ladder' || n.move === 'climb' || n.move === 'swim') return hd < 0.7 && dy <= 0.15 && dy > -1;
    if (n.move === 'drop') return hd < 0.45 && dy > -0.6 && dy < 0.6;
    return hd < (this.speed > 4 ? 0.5 : 0.38) && dy < 0.6 && dy > -1.1;
  }

  private trackStuck(dt: number, dist: number, out: StepInput): void {
    if (dist < this.bestDist - 0.08) {
      this.bestDist = dist;
      this.stuckTimer = 0;
      return;
    }
    this.stuckTimer += dt;
    if (this.stuckTimer > 0.6 && this.entity.onGround) out.jump = true;
    if (this.stuckTimer > 1.4) {
      this.stuckTimer = 0;
      this.bestDist = Infinity;
      this.stuckCount++;
      this.repath();
      if (this.stuckCount > 6) {
        this.state = 'failed';
        this.stuckCount = 0;
      }
    }
  }

  private onBlockChange(x: number, y: number, z: number): void {
    if (!this.path) return;
    const b = this.box;
    if (x >= b.minX - 1 && x <= b.maxX + 1 && y >= b.minY - 2 && y <= b.maxY + 2 && z >= b.minZ - 1 && z <= b.maxZ + 1) this.repath();
  }

  private face(dt: number, move: StepInput | THREE.Vector3 | null): void {
    const e = this.entity;
    let target: number | null = null;
    const look = move instanceof THREE.Vector3 ? move : this.lookTarget;
    if (look) target = yawTo(e, look.x, look.z);
    else if (move && !(move instanceof THREE.Vector3) && (Math.abs(move.moveX ?? 0) > 0.05 || Math.abs(move.moveZ ?? 0) > 0.05)) {
      target = Math.atan2(-(move.moveX ?? 0), -(move.moveZ ?? 0));
    }
    if (target !== null) turnTowards(e, target, dt, this.turnRate);
  }
}

// -- steering helpers --------------------------------------------------------------------------

/** Yaw (entity convention: 0 faces -Z) from an entity to a point. */
export function yawTo(e: { position: THREE.Vector3 }, x: number, z: number): number {
  return Math.atan2(-(x - e.position.x), -(z - e.position.z));
}

/** Turns `e.yaw` towards `target` by at most `rate * dt`. */
export function turnTowards(e: { yaw: number }, target: number, dt: number, rate = 10): void {
  let d = target - e.yaw;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  const max = rate * dt;
  e.yaw += Math.abs(d) <= max ? d : Math.sign(d) * max;
}

/** Straight-line input towards a point (no pathfinding). */
export function seek(e: Entity, x: number, z: number, speed: number): StepInput {
  const dx = x - e.position.x, dz = z - e.position.z;
  const d = Math.hypot(dx, dz) || 1;
  return { moveX: (dx / d) * speed, moveZ: (dz / d) * speed, jump: e.collidedHorizontally || e.inWater };
}

/** Input running directly away from a point. */
export function flee(e: Entity, fromX: number, fromZ: number, speed: number): StepInput {
  const dx = e.position.x - fromX, dz = e.position.z - fromZ;
  const d = Math.hypot(dx, dz) || 1;
  return { moveX: (dx / d) * speed, moveZ: (dz / d) * speed, jump: e.collidedHorizontally || e.inWater };
}

/**
 * Circles around a point at `radius` (dir +1 counter-clockwise, -1 clockwise), correcting the
 * distance as it goes. Good for skeleton strafing and keep_distance tactics.
 */
export function strafe(e: Entity, cx: number, cz: number, radius: number, dir: number, speed: number): StepInput {
  const dx = e.position.x - cx, dz = e.position.z - cz;
  const d = Math.hypot(dx, dz) || 1;
  const nx = dx / d, nz = dz / d;
  const tx = -nz * dir, tz = nx * dir;
  const radial = Math.max(-1, Math.min(1, (radius - d) * 0.6));
  const mx = tx + nx * radial, mz = tz + nz * radial;
  const l = Math.hypot(mx, mz) || 1;
  return { moveX: (mx / l) * speed, moveZ: (mz / l) * speed, jump: e.collidedHorizontally || e.inWater };
}

/** Adds a small push away from nearby entities so groups don't stack into one spot. */
export function separate(e: Entity, others: readonly Entity[], input: StepInput, strength = 1.2): StepInput {
  let px = 0, pz = 0;
  for (const o of others) {
    if (o === e) continue;
    const dx = e.position.x - o.position.x, dz = e.position.z - o.position.z;
    const d2 = dx * dx + dz * dz;
    const min = (e.width + o.width) * 0.6;
    if (d2 > 0.0001 && d2 < min * min) {
      const d = Math.sqrt(d2);
      px += (dx / d) * (min - d);
      pz += (dz / d) * (min - d);
    }
  }
  input.moveX = (input.moveX ?? 0) + px * strength * 4;
  input.moveZ = (input.moveZ ?? 0) + pz * strength * 4;
  return input;
}

/** True if nothing solid blocks the straight line between two points. */
export function hasLineOfSight(world: WorldStore, from: THREE.Vector3, to: THREE.Vector3): boolean {
  const dir = tmpDir.subVectors(to, from);
  const dist = dir.length();
  if (dist < 0.01) return true;
  const hit = world.raycast(from, dir, dist, { filter: (id) => (BLOCK_FLAGS[id] & F_SOLID) !== 0 });
  return !hit || hit.distance >= dist - 0.05;
}

const tmpDir = new THREE.Vector3();

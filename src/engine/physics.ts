/**
 * AABB-vs-voxel physics shared by the player and all mobs.
 *
 * A body's `position` is the centre of its feet. `moveBody` sweeps the box through the world
 * one axis at a time (Y, X, Z) and clips against block collision boxes. `stepBody` adds gravity,
 * drag, swimming and ladders on top for simple entities.
 */
import type * as THREE from 'three';
import { BLOCK_FLAGS, F_CLIMBABLE, F_LIQUID, F_SOLID, BLOCK } from './blocks';
import { ID_MASK, META_SHIFT } from './constants';
import { collisionBoxes } from './shapes';
import type { WorldStore } from './world-store';

export interface Body {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** Box width (x and z), e.g. 0.6. */
  width: number;
  /** Box height, e.g. 1.8. */
  height: number;
  onGround: boolean;
  /** True when any part of the box overlaps water. */
  inWater: boolean;
  inLava: boolean;
  /** True when the body overlaps a climbable block (ladder). */
  onLadder: boolean;
  /** Blocked horizontally during the last move (use to trigger a jump). */
  collidedHorizontally: boolean;
  /** Blocks fallen since last on ground. */
  fallDistance: number;
}

export interface MoveOptions {
  /** Prevent walking off edges (sneaking). */
  sneakEdge?: boolean;
}

export const GRAVITY = 32;
export const TERMINAL_VELOCITY = 60;

// Reusable box buffer [x0, y0, z0, x1, y1, z1, ...].
let boxes = new Float64Array(6 * 256);
let boxCount = 0;

function gather(world: WorldStore, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
  boxCount = 0;
  const bx0 = Math.floor(x0), by0 = Math.floor(y0) - 1, bz0 = Math.floor(z0);
  const bx1 = Math.floor(x1), by1 = Math.floor(y1), bz1 = Math.floor(z1);
  for (let x = bx0; x <= bx1; x++)
    for (let z = bz0; z <= bz1; z++) {
      const loaded = world.chunkAt(x, z) !== undefined;
      for (let y = by0; y <= by1; y++) {
        if (!loaded) {
          push(x, y, z, 0, 0, 0, 1, 1, 1);
          continue;
        }
        if (y < 0) {
          push(x, y, z, 0, 0, 0, 1, 1, 1);
          continue;
        }
        const raw = world.getRaw(x, y, z);
        const id = raw & ID_MASK;
        if (!(BLOCK_FLAGS[id] & F_SOLID)) continue;
        for (const b of collisionBoxes(id, raw >> META_SHIFT)) push(x, y, z, b[0], b[1], b[2], b[3], b[4], b[5]);
      }
    }
}

function push(x: number, y: number, z: number, a: number, b: number, c: number, d: number, e: number, f: number): void {
  if ((boxCount + 1) * 6 > boxes.length) {
    const n = new Float64Array(boxes.length * 2);
    n.set(boxes);
    boxes = n;
  }
  const i = boxCount++ * 6;
  boxes[i] = x + a;
  boxes[i + 1] = y + b;
  boxes[i + 2] = z + c;
  boxes[i + 3] = x + d;
  boxes[i + 4] = y + e;
  boxes[i + 5] = z + f;
}

const EPS = 1e-7;

/** Moves a body by velocity × dt with collision. Updates onGround / collision flags. */
export function moveBody(world: WorldStore, body: Body, dt: number, opts: MoveOptions = {}): void {
  const hw = body.width / 2;
  const p = body.position;
  let dx = body.velocity.x * dt;
  let dy = body.velocity.y * dt;
  let dz = body.velocity.z * dt;

  let minX = p.x - hw, minY = p.y, minZ = p.z - hw;
  let maxX = p.x + hw, maxY = p.y + body.height, maxZ = p.z + hw;

  if (opts.sneakEdge && body.onGround) {
    const step = 0.05;
    while (dx !== 0 && !hasGround(world, minX + dx, minY, minZ, maxX + dx, maxZ)) dx = Math.abs(dx) < step ? 0 : dx - Math.sign(dx) * step;
    while (dz !== 0 && !hasGround(world, minX, minY, minZ + dz, maxX, maxZ + dz)) dz = Math.abs(dz) < step ? 0 : dz - Math.sign(dz) * step;
    while (dx !== 0 && dz !== 0 && !hasGround(world, minX + dx, minY, minZ + dz, maxX + dx, maxZ + dz)) {
      dx = Math.abs(dx) < step ? 0 : dx - Math.sign(dx) * step;
      dz = Math.abs(dz) < step ? 0 : dz - Math.sign(dz) * step;
    }
  }

  gather(world, Math.min(minX, minX + dx), Math.min(minY, minY + dy), Math.min(minZ, minZ + dz), Math.max(maxX, maxX + dx), Math.max(maxY, maxY + dy), Math.max(maxZ, maxZ + dz));

  const wantDy = dy, wantDx = dx, wantDz = dz;
  // Y
  for (let i = 0; i < boxCount * 6; i += 6) {
    if (boxes[i + 3] <= minX + EPS || boxes[i] >= maxX - EPS || boxes[i + 5] <= minZ + EPS || boxes[i + 2] >= maxZ - EPS) continue;
    if (dy > 0 && boxes[i + 1] >= maxY - EPS) dy = Math.min(dy, boxes[i + 1] - maxY);
    else if (dy < 0 && boxes[i + 4] <= minY + EPS) dy = Math.max(dy, boxes[i + 4] - minY);
  }
  minY += dy;
  maxY += dy;
  // X
  for (let i = 0; i < boxCount * 6; i += 6) {
    if (boxes[i + 4] <= minY + EPS || boxes[i + 1] >= maxY - EPS || boxes[i + 5] <= minZ + EPS || boxes[i + 2] >= maxZ - EPS) continue;
    if (dx > 0 && boxes[i] >= maxX - EPS) dx = Math.min(dx, boxes[i] - maxX);
    else if (dx < 0 && boxes[i + 3] <= minX + EPS) dx = Math.max(dx, boxes[i + 3] - minX);
  }
  minX += dx;
  maxX += dx;
  // Z
  for (let i = 0; i < boxCount * 6; i += 6) {
    if (boxes[i + 4] <= minY + EPS || boxes[i + 1] >= maxY - EPS || boxes[i + 3] <= minX + EPS || boxes[i] >= maxX - EPS) continue;
    if (dz > 0 && boxes[i + 2] >= maxZ - EPS) dz = Math.min(dz, boxes[i + 2] - maxZ);
    else if (dz < 0 && boxes[i + 5] <= minZ + EPS) dz = Math.max(dz, boxes[i + 5] - minZ);
  }
  minZ += dz;

  p.x += dx;
  p.y += dy;
  p.z += dz;
  void maxZ;

  const hitY = Math.abs(dy - wantDy) > EPS;
  body.onGround = hitY && wantDy < 0;
  if (hitY) body.velocity.y = 0;
  const hitX = Math.abs(dx - wantDx) > EPS;
  const hitZ = Math.abs(dz - wantDz) > EPS;
  if (hitX) body.velocity.x = 0;
  if (hitZ) body.velocity.z = 0;
  body.collidedHorizontally = hitX || hitZ;
  updateMedium(world, body);
}

function hasGround(world: WorldStore, x0: number, y0: number, z0: number, x1: number, z1: number): boolean {
  gather(world, x0, y0 - 0.6, z0, x1, y0, z1);
  for (let i = 0; i < boxCount * 6; i += 6) {
    if (boxes[i + 3] <= x0 + EPS || boxes[i] >= x1 - EPS || boxes[i + 5] <= z0 + EPS || boxes[i + 2] >= z1 - EPS) continue;
    if (boxes[i + 4] > y0 - 0.6 && boxes[i + 1] < y0) return true;
  }
  return false;
}

/** Updates inWater / inLava / onLadder from the blocks the body overlaps. */
export function updateMedium(world: WorldStore, body: Body): void {
  const hw = body.width / 2 - 0.001;
  const p = body.position;
  let water = false, lava = false, ladder = false;
  const x0 = Math.floor(p.x - hw), x1 = Math.floor(p.x + hw);
  const z0 = Math.floor(p.z - hw), z1 = Math.floor(p.z + hw);
  const y0 = Math.floor(p.y + 0.01), y1 = Math.floor(p.y + body.height * 0.6);
  for (let x = x0; x <= x1; x++)
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++) {
        const id = world.getBlock(x, y, z);
        const f = BLOCK_FLAGS[id];
        if (f & F_LIQUID) {
          if (id === BLOCK.lava) lava = true;
          else water = true;
        }
        if (f & F_CLIMBABLE) ladder = true;
      }
  body.inWater = water;
  body.inLava = lava;
  body.onLadder = ladder;
}

/** True if the body's box intersects any solid block (e.g. to validate a teleport). */
export function bodyCollides(world: WorldStore, x: number, y: number, z: number, width: number, height: number): boolean {
  const hw = width / 2;
  gather(world, x - hw, y, z - hw, x + hw, y + height, z + hw);
  for (let i = 0; i < boxCount * 6; i += 6) {
    if (boxes[i + 3] > x - hw + EPS && boxes[i] < x + hw - EPS && boxes[i + 4] > y + EPS && boxes[i + 1] < y + height - EPS && boxes[i + 5] > z - hw + EPS && boxes[i + 2] < z + hw - EPS) return true;
  }
  return false;
}

export interface StepInput {
  /** Desired horizontal velocity (blocks/s), already rotated to world space. */
  moveX?: number;
  moveZ?: number;
  /** Jump / swim up / climb up this frame. */
  jump?: boolean;
  /** Ground acceleration factor (higher = snappier). Default 10. */
  accel?: number;
  /** Jump velocity. Default 8.4 (≈1.1 blocks). */
  jumpVelocity?: number;
  sneakEdge?: boolean;
}

/**
 * Generic movement for mobs: gravity, water buoyancy/drag, ladders, jumping and collision.
 * Returns the fall distance when the body landed this step (0 otherwise).
 */
export function stepBody(world: WorldStore, body: Body, dt: number, input: StepInput = {}): number {
  const v = body.velocity;
  const accel = input.accel ?? 10;
  const tx = input.moveX ?? 0, tz = input.moveZ ?? 0;
  const control = body.onGround ? 1 : body.inWater ? 0.6 : 0.25;
  const k = Math.min(1, accel * control * dt);
  v.x += (tx * (body.inWater ? 0.5 : 1) - v.x) * k;
  v.z += (tz * (body.inWater ? 0.5 : 1) - v.z) * k;

  if (body.inWater || body.inLava) {
    v.y -= GRAVITY * 0.12 * dt;
    v.y *= Math.pow(0.2, dt);
    if (input.jump) v.y = Math.min(v.y + 20 * dt, 2.6);
  } else if (body.onLadder) {
    v.y = Math.max(v.y - GRAVITY * dt, -2.2);
    if (input.jump || body.collidedHorizontally) v.y = 2.4;
  } else {
    v.y = Math.max(v.y - GRAVITY * dt, -TERMINAL_VELOCITY);
    if (input.jump && body.onGround) v.y = input.jumpVelocity ?? 8.4;
  }
  const wasGround = body.onGround;
  const y0 = body.position.y;
  moveBody(world, body, dt, { sneakEdge: input.sneakEdge });
  let landed = 0;
  if (!body.onGround && body.position.y < y0 && !body.inWater && !body.onLadder) body.fallDistance += y0 - body.position.y;
  if (body.inWater || body.onLadder) body.fallDistance = 0;
  if (body.onGround && !wasGround) {
    landed = body.fallDistance;
    body.fallDistance = 0;
  } else if (body.onGround) body.fallDistance = 0;
  return landed;
}

/**
 * The local player: first-person controller with walking, sprinting, sneaking (no falling off
 * edges), jumping, swimming, ladders and creative flight, plus camera placement for first and
 * third person views.
 */
import * as THREE from 'three';
import { GRAVITY, TERMINAL_VELOCITY, moveBody, type Body } from '../engine/physics';
import type { Game } from '../game/game';
import type { GameMode } from '../game/events';
import { KEYS, type Input } from './input';

export type ViewMode = 'first' | 'back' | 'front';

const WALK = 4.317;
const SPRINT = 5.612;
const SNEAK = 1.31;
const FLY = 10.9;
const JUMP_V = 8.9;
const EYE = 1.62;
const EYE_SNEAK = 1.32;

export class Player implements Body {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  width = 0.6;
  height = 1.8;
  onGround = false;
  inWater = false;
  inLava = false;
  onLadder = false;
  collidedHorizontally = false;
  fallDistance = 0;
  /** Radians; 0 looks towards -Z. */
  yaw = 0;
  pitch = 0;
  mode: GameMode = 'survival';
  flying = false;
  sprinting = false;
  sneaking = false;
  /** Where the player respawns. */
  readonly spawnPoint = new THREE.Vector3();
  /** Frozen players ignore input and physics (loading, cutscenes). */
  frozen = true;
  viewMode: ViewMode = 'first';
  /** Smoothed eye height (sneak transition). */
  eyeHeight = EYE;
  /** Free-form per-player data for other systems (health, hunger, reputation, ...). */
  readonly data: Record<string, unknown> = {};
  private lastSpace = -1;
  private lastForward = -1;
  private walkDist = 0;
  private bobAmount = 0;
  private fovBoost = 0;
  private lastBlock = { x: NaN, y: NaN, z: NaN, cx: NaN, cz: NaN };

  constructor(private readonly game: Game) {}

  /** Eye position in world space. */
  eye(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  /** Unit look direction. */
  lookDir(out = new THREE.Vector3()): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  /** Horizontal facing 0 N, 1 E, 2 S, 3 W from the yaw. */
  get facing(): 0 | 1 | 2 | 3 {
    const dx = -Math.sin(this.yaw), dz = -Math.cos(this.yaw);
    if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 1 : 3;
    return dz < 0 ? 0 : 2;
  }

  teleport(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.fallDistance = 0;
  }

  setMode(mode: GameMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode !== 'creative') this.flying = false;
    this.game.events.emit('gameModeChanged', { mode });
  }

  update(dt: number, input: Input): void {
    if (this.frozen) return;
    const s = this.game.settings.sensitivity * 0.0022;
    this.yaw -= input.mouseDX * s;
    this.pitch -= input.mouseDY * s;
    this.pitch = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, this.pitch));

    const now = performance.now();
    if (input.wasPressed(KEYS.jump)) {
      if (this.mode === 'creative' && now - this.lastSpace < 300) {
        this.flying = !this.flying;
        this.velocity.y = 0;
        this.lastSpace = -1;
      } else this.lastSpace = now;
    }
    const fwd = input.isDown(KEYS.forward) ? 1 : 0;
    if (input.wasPressed(KEYS.forward)) {
      if (now - this.lastForward < 280) this.sprinting = true;
      this.lastForward = now;
    }
    const mx = (input.isDown(KEYS.right) ? 1 : 0) - (input.isDown(KEYS.left) ? 1 : 0);
    const mz = fwd - (input.isDown(KEYS.back) ? 1 : 0);
    this.sneaking = input.isDown(KEYS.sneak) && !this.flying;
    if (input.isDown(KEYS.sprint) && mz > 0) this.sprinting = true;
    if (mz <= 0 || this.sneaking || this.collidedHorizontally) this.sprinting = false;

    // Wish direction in world space.
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let wx = -sin * mz + cos * mx;
    let wz = -cos * mz - sin * mx;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) {
      wx /= wl;
      wz /= wl;
    }
    const v = this.velocity;
    const jump = input.isDown(KEYS.jump);

    if (this.flying) {
      const speed = FLY * (this.sprinting ? 2 : 1);
      const k = 1 - Math.exp(-10 * dt);
      v.x += (wx * speed - v.x) * k;
      v.z += (wz * speed - v.z) * k;
      const vy = (jump ? 1 : 0) - (input.isDown(KEYS.sneak) ? 1 : 0);
      v.y += (vy * 7.5 - v.y) * k;
    } else {
      const speed = this.sneaking ? SNEAK : this.sprinting ? SPRINT : WALK;
      const swim = this.inWater || this.inLava;
      const control = this.onGround ? 14 : swim ? 6 : 2.2;
      const k = 1 - Math.exp(-control * dt);
      const sm = swim ? 0.55 : 1;
      v.x += (wx * speed * sm - v.x) * k;
      v.z += (wz * speed * sm - v.z) * k;
      if (swim) {
        v.y -= GRAVITY * 0.1 * dt;
        v.y *= Math.pow(0.15, dt);
        if (jump) v.y = Math.min(v.y + 22 * dt, 3.2);
        // Hop out at the shore.
        if (jump && this.collidedHorizontally) v.y = Math.max(v.y, 5.5);
      } else if (this.onLadder) {
        v.y = Math.max(v.y - GRAVITY * dt, -2.4);
        if (this.sneaking) v.y = Math.max(v.y, 0);
        if (jump || (this.collidedHorizontally && mz !== 0)) v.y = 2.6;
      } else {
        v.y = Math.max(v.y - GRAVITY * dt, -TERMINAL_VELOCITY);
        if (jump && this.onGround) v.y = JUMP_V;
      }
    }

    const wasGround = this.onGround;
    const y0 = this.position.y;
    moveBody(this.game.world, this, dt, { sneakEdge: this.sneaking });
    if (this.flying && this.onGround && !jump) this.flying = false;

    // Falling and landing.
    if (this.inWater || this.onLadder || this.flying) this.fallDistance = 0;
    else if (!this.onGround && this.position.y < y0) this.fallDistance += y0 - this.position.y;
    if (this.onGround && !wasGround) {
      if (this.fallDistance > 3 && this.mode === 'survival') {
        const damage = Math.floor(this.fallDistance - 3);
        this.game.events.emit('playerFell', { distance: this.fallDistance, damage });
      }
      this.fallDistance = 0;
    }

    if (this.position.y < -40) this.respawn();

    // Bob + FOV.
    const hs = Math.hypot(v.x, v.z);
    if (this.onGround && !this.flying) this.walkDist += hs * dt;
    this.bobAmount += ((this.onGround && hs > 0.5 && !this.flying ? Math.min(1, hs / WALK) : 0) - this.bobAmount) * Math.min(1, dt * 8);
    this.fovBoost += ((this.sprinting ? 1 : 0) - this.fovBoost) * Math.min(1, dt * 8);
    const eyeTarget = this.sneaking ? EYE_SNEAK : EYE;
    this.eyeHeight += (eyeTarget - this.eyeHeight) * Math.min(1, dt * 14);

    this.emitMoved();
  }

  /** Moves the player to the spawn point (V1 calls this after death). */
  respawn(): void {
    const sp = this.spawnPoint;
    const y = this.game.world.findGround(sp.x, sp.z) ?? sp.y;
    this.teleport(sp.x, y, sp.z);
    this.game.events.emit('playerRespawned', { x: sp.x, y, z: sp.z });
  }

  /** Places the camera for the current view mode. */
  updateCamera(camera: THREE.PerspectiveCamera, baseFov: number): void {
    const eye = this.eye(tmpEye);
    const bob = this.game.settings.viewBob && this.viewMode === 'first' ? this.bobAmount : 0;
    const phase = this.walkDist * 1.9;
    camera.rotation.order = 'YXZ';
    if (this.viewMode === 'first') {
      camera.position.set(eye.x + Math.cos(this.yaw) * Math.sin(phase) * 0.04 * bob, eye.y + Math.abs(Math.cos(phase)) * 0.07 * bob, eye.z - Math.sin(this.yaw) * Math.sin(phase) * 0.04 * bob);
      camera.rotation.set(this.pitch, this.yaw, Math.sin(phase) * 0.006 * bob);
    } else {
      const dir = this.lookDir(tmpDir);
      const sign = this.viewMode === 'back' ? -1 : 1;
      let dist = 4;
      for (let d = 0.3; d <= 4; d += 0.1) {
        const x = eye.x + dir.x * d * sign, y = eye.y + dir.y * d * sign, z = eye.z + dir.z * d * sign;
        if (this.game.world.isOpaque(Math.floor(x), Math.floor(y), Math.floor(z))) {
          dist = Math.max(0.3, d - 0.3);
          break;
        }
      }
      camera.position.set(eye.x + dir.x * dist * sign, eye.y + dir.y * dist * sign, eye.z + dir.z * dist * sign);
      if (this.viewMode === 'back') camera.rotation.set(this.pitch, this.yaw, 0);
      else camera.rotation.set(-this.pitch, this.yaw + Math.PI, 0);
    }
    const fov = baseFov * (1 + this.fovBoost * 0.12) * (this.flying && this.sprinting ? 1.08 : 1);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  /** Walk animation phase (for the third-person model). */
  get walkPhase(): number {
    return this.walkDist * 2.2;
  }

  get walkAmount(): number {
    return this.bobAmount;
  }

  private emitMoved(): void {
    const bx = Math.floor(this.position.x), by = Math.floor(this.position.y), bz = Math.floor(this.position.z);
    const lb = this.lastBlock;
    if (bx === lb.x && by === lb.y && bz === lb.z) return;
    const cx = bx >> 4, cz = bz >> 4;
    if (cx !== lb.cx || cz !== lb.cz) {
      if (!Number.isNaN(lb.cx)) this.game.events.emit('playerChunkChanged', { cx, cz, prevCx: lb.cx, prevCz: lb.cz });
      lb.cx = cx;
      lb.cz = cz;
    }
    lb.x = bx;
    lb.y = by;
    lb.z = bz;
    this.game.events.emit('playerMoved', {
      x: this.position.x, y: this.position.y, z: this.position.z, bx, by, bz, cx, cz, biome: this.game.world.biomeAt(bx, bz),
    });
  }

  serialize(): { pos: [number, number, number]; yaw: number; pitch: number; mode: GameMode; flying: boolean; spawn: [number, number, number] } {
    return {
      pos: [this.position.x, this.position.y, this.position.z],
      yaw: this.yaw,
      pitch: this.pitch,
      mode: this.mode,
      flying: this.flying,
      spawn: [this.spawnPoint.x, this.spawnPoint.y, this.spawnPoint.z],
    };
  }

  deserialize(d: ReturnType<Player['serialize']>): void {
    this.position.set(...d.pos);
    this.yaw = d.yaw ?? 0;
    this.pitch = d.pitch ?? 0;
    this.mode = d.mode ?? 'survival';
    this.flying = !!d.flying && this.mode === 'creative';
    if (d.spawn) this.spawnPoint.set(...d.spawn);
  }
}

const tmpEye = new THREE.Vector3();
const tmpDir = new THREE.Vector3();

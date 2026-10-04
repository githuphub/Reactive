/**
 * Entity base class. Mobs (V1) and villagers / golems (V2) extend it and add themselves with
 * `game.entities.add(new MyMob(...))`. The manager calls `update(dt)` every frame (only while the
 * entity's chunk is loaded), syncs `object3d` to position/yaw and applies block lighting.
 */
import * as THREE from 'three';
import { stepBody, type Body, type StepInput } from './physics';
import type { Game } from '../game/game';
import type { ItemStack } from './items';

let nextEntityId = 1;

/** Where damage came from. */
export interface DamageSource {
  /** e.g. 'melee', 'arrow', 'explosion', 'fall', 'lava', 'drown', 'magic'. */
  kind: string;
  entity?: Entity | null;
  /** True if the player caused it. */
  player?: boolean;
  item?: ItemStack | null;
}

export abstract class Entity implements Body {
  readonly id = nextEntityId++;
  /** Type key, e.g. 'zombie', 'villager'. */
  abstract readonly type: string;
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** Facing in radians; 0 looks towards -Z, positive turns left (three.js convention). */
  yaw = 0;
  pitch = 0;
  width = 0.6;
  height = 1.8;
  /** Eye height above the feet. */
  eyeHeight = 1.62;
  onGround = false;
  inWater = false;
  inLava = false;
  onLadder = false;
  collidedHorizontally = false;
  fallDistance = 0;
  health = 20;
  maxHealth = 20;
  /** Seconds of invulnerability left after a hit. */
  hurtCooldown = 0;
  /** Set by `remove()`; the manager drops the entity at the end of the frame. */
  removed = false;
  /** The model shown in the scene (positioned and rotated by the manager). */
  object3d: THREE.Object3D | null = null;
  /** Free-form data for other systems (owner, home, job, faction, ...). */
  readonly data: Record<string, unknown> = {};
  /** Set when the entity is added to a game. */
  game!: Game;

  /** Called once after being added to the game. */
  onAdded(): void {}

  /** Called once when removed. Dispose GPU resources here (default disposes object3d meshes). */
  onRemoved(): void {
    this.object3d?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
  }

  /** Per-frame logic. Default: simple physics with no input. */
  update(dt: number): void {
    this.move(dt);
  }

  /** Runs physics with optional movement input; returns fall distance if it landed. */
  protected move(dt: number, input?: StepInput): number {
    return stepBody(this.game.world, this, dt, input);
  }

  /**
   * Applies damage. Returns false if ignored (cooldown / already dead). Emits `entityHurt`
   * and, at 0 health, calls `onDeath` and removes the entity.
   */
  hurt(amount: number, source: DamageSource): boolean {
    if (this.removed || this.health <= 0 || this.hurtCooldown > 0) return false;
    this.health = Math.max(0, this.health - amount);
    this.hurtCooldown = 0.5;
    const attacker = source.entity;
    if (attacker) {
      const dx = this.position.x - attacker.position.x;
      const dz = this.position.z - attacker.position.z;
      const d = Math.hypot(dx, dz) || 1;
      this.velocity.x += (dx / d) * 6;
      this.velocity.z += (dz / d) * 6;
      this.velocity.y = Math.max(this.velocity.y, 5);
    }
    this.game?.entities.emitHurt(this, amount, source);
    if (this.health <= 0) {
      this.onDeath(source);
      this.game?.entities.emitDied(this, source);
      this.remove();
    }
    return true;
  }

  /** Override for death effects / drops. */
  onDeath(_source: DamageSource): void {}

  remove(): void {
    this.removed = true;
  }

  /** Forward unit vector on the XZ plane. */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  /** Turns to face a world point (yaw only). */
  lookAt(x: number, z: number): void {
    this.yaw = Math.atan2(-(x - this.position.x), -(z - this.position.z));
  }

  distanceTo(other: { position: THREE.Vector3 } | THREE.Vector3): number {
    const p = other instanceof THREE.Vector3 ? other : other.position;
    return this.position.distanceTo(p);
  }

  /** World-space eye position. */
  eye(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  /** Called by the manager with a 0..1 brightness from local light; default tints BoxModels. */
  applyBrightness(b: number): void {
    const model = this.object3d?.userData.boxModel as { setBrightness(b: number): void } | undefined;
    model?.setBrightness(b);
  }
}

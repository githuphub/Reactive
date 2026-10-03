/**
 * Creeper: sneaks up, then a 1.5 s fuse with a swelling white flash, then explodes (crater of
 * radius ~3 that respects block hardness, damage and knockback). Walks away = fuse cools down.
 */
import * as THREE from 'three';
import type { StepInput } from '../engine/physics';
import { hasLineOfSight } from './brain';
import { explode } from './explosion';
import { animateQuadruped, createCreeperModel } from './models';
import { Mob } from './mob';

export const CREEPER_FUSE = 1.5;

export class Creeper extends Mob {
  readonly type = 'creeper';
  readonly category = 'hostile' as const;
  /** Fuse progress in seconds (0 = calm). */
  fuse = 0;
  /** Explosion radius. */
  radius = 3;
  private light = 1;

  constructor() {
    super(
      createCreeperModel(),
      {
        maxHealth: 20,
        speed: 2.4,
        attackDamage: 0,
        attackCooldown: 1,
        reach: 0,
        followRange: 18,
        hostility: 'hostile',
        burnsInDaylight: false,
        drops: [{ item: 'gunpowder', count: [0, 2] }],
      },
      { width: 0.6, height: 1.7, eyeHeight: 1.45 },
    );
  }

  protected behave(dt: number): StepInput {
    const t = this.target;
    if (!t) {
      this.fuse = Math.max(0, this.fuse - dt);
      return this.wander(dt);
    }
    const input = this.chase(dt, t, false);
    const eye = this.targetEye(t, tmpEye);
    const d = this.eye(tmpSelf).distanceTo(eye);
    const near = d < 3.2 && hasLineOfSight(this.game.world, tmpSelf, eye);
    if (near || (this.fuse > 0 && d < 7)) {
      this.fuse += dt;
      input.moveX = (input.moveX ?? 0) * 0.25;
      input.moveZ = (input.moveZ ?? 0) * 0.25;
      if (this.fuse >= CREEPER_FUSE) this.detonate();
    } else this.fuse = Math.max(0, this.fuse - dt);
    return input;
  }

  /** Explodes now (removes the creeper). */
  detonate(): void {
    if (this.removed) return;
    const p = this.position;
    this.remove();
    explode(this.game, p.x, p.y + 0.8, p.z, { radius: this.radius, byEntity: this });
  }

  applyBrightness(b: number): void {
    this.light = b;
    super.applyBrightness(b);
  }

  protected animate(_dt: number): void {
    animateQuadruped(this.model, this.walkPhase, this.walkAmount);
    const k = Math.min(1, this.fuse / CREEPER_FUSE);
    const wobble = k > 0 ? Math.sin(this.age * 40) * 0.03 * k : 0;
    this.model.root.scale.set(1 + k * 0.28 + wobble, 1 + k * 0.12, 1 + k * 0.28 + wobble);
    if (k > 0) {
      const blink = Math.floor(this.fuse * (6 + k * 10)) % 2 === 0;
      this.model.setBrightness(blink ? 2.6 : this.light);
    }
    if (this.model.parts.head) this.model.parts.head.rotation.x = this.target ? -0.1 : 0;
  }
}

const tmpEye = new THREE.Vector3();
const tmpSelf = new THREE.Vector3();

/**
 * Passive animals: wander and graze, follow a player holding wheat, and panic (flee) when hit.
 * Pigs drop porkchops; cows drop beef and leather (cooked if they died burning).
 */
import * as THREE from 'three';
import type { StepInput } from '../engine/physics';
import type { BoxModel } from '../engine/box-model';
import { flee } from './brain';
import { animateQuadruped, createCowModel, createPigModel } from './models';
import { Mob, type MobStats, type MobTarget } from './mob';

const TEMPT_ITEMS = new Set(['wheat', 'apple']);

export abstract class Animal extends Mob {
  readonly category = 'animal' as const;
  private panic = 0;
  private readonly panicFrom = new THREE.Vector3();
  private grazeTimer = 3 + Math.random() * 6;
  private grazing = 0;
  private temptTimer = 0;
  private tempted = false;

  constructor(model: BoxModel, stats: MobStats, size: { width: number; height: number }) {
    super(model, stats, size);
  }

  protected onAttacked(attacker: MobTarget): void {
    this.panic = 5;
    this.panicFrom.copy(this.targetPosition(attacker));
    this.brain.stop();
  }

  protected behave(dt: number): StepInput {
    if (this.panic > 0) {
      this.panic -= dt;
      const input = flee(this, this.panicFrom.x, this.panicFrom.z, this.stats.speed * 1.7);
      // Zig-zag a little.
      const wob = Math.sin(this.age * 3 + this.id) * 0.35;
      const mx = input.moveX ?? 0, mz = input.moveZ ?? 0;
      input.moveX = mx + mz * wob;
      input.moveZ = mz - mx * wob;
      return input;
    }
    // Follow a player holding food.
    this.temptTimer -= dt;
    if (this.temptTimer <= 0) {
      this.temptTimer = 0.5;
      const held = this.game.inventory.selectedStack?.item;
      this.tempted = !!held && TEMPT_ITEMS.has(held) && this.position.distanceTo(this.game.player.position) < 9 && !this.game.player.frozen;
    }
    if (this.tempted) {
      const p = this.game.player.position;
      this.brain.speed = this.stats.speed * 0.8;
      if (this.position.distanceTo(p) > 2.2) this.brain.moveTo(p.x, p.y, p.z);
      else this.brain.stop();
      this.brain.lookTarget = tmpLook.set(p.x, p.y, p.z);
      return this.brain.update(dt);
    }
    this.brain.lookTarget = null;
    // Graze now and then.
    this.grazeTimer -= dt;
    if (this.grazeTimer <= 0 && this.brain.state !== 'moving') {
      this.grazeTimer = 6 + Math.random() * 10;
      this.grazing = 2 + Math.random() * 2;
    }
    if (this.grazing > 0) {
      this.grazing -= dt;
      return { moveX: 0, moveZ: 0, jump: this.inWater };
    }
    return this.wander(dt);
  }

  protected animate(_dt: number): void {
    animateQuadruped(this.model, this.walkPhase, this.walkAmount);
    const head = this.model.parts.head;
    if (head) head.rotation.x += ((this.grazing > 0 ? -0.9 : 0) - head.rotation.x) * 0.15;
  }
}

const tmpLook = new THREE.Vector3();

export class Pig extends Animal {
  readonly type = 'pig';
  constructor() {
    super(
      createPigModel(),
      {
        maxHealth: 10, speed: 2.4, wanderSpeed: 1.2, attackDamage: 0, attackCooldown: 1, reach: 0, followRange: 0,
        hostility: 'passive', burnsInDaylight: false, drops: [{ item: 'raw_porkchop', count: [1, 3] }], path: { height: 1 },
      },
      { width: 0.9, height: 0.9 },
    );
  }
}

export class Cow extends Animal {
  readonly type = 'cow';
  constructor() {
    super(
      createCowModel(),
      {
        maxHealth: 10, speed: 2.2, wanderSpeed: 1.1, attackDamage: 0, attackCooldown: 1, reach: 0, followRange: 0,
        hostility: 'passive', burnsInDaylight: false,
        drops: [{ item: 'raw_beef', count: [1, 3] }, { item: 'leather', count: [0, 2] }],
      },
      { width: 0.9, height: 1.4 },
    );
  }
}

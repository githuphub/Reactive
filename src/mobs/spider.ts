/**
 * Spider: fast, climbs any wall it walks into, leaps at its target. Neutral in daylight (only
 * attacks in the dark or when provoked). Fits through 1-block-high gaps.
 */
import type { StepInput } from '../engine/physics';
import { animateSpider, createSpiderModel } from './models';
import { Mob } from './mob';

export class Spider extends Mob {
  readonly type = 'spider';
  readonly category = 'hostile' as const;
  private leapCooldown = 1;

  constructor() {
    super(
      createSpiderModel(),
      {
        maxHealth: 16,
        speed: 3.3,
        attackDamage: 2,
        attackCooldown: 0.9,
        reach: 0.5,
        followRange: 16,
        hostility: 'neutral',
        burnsInDaylight: false,
        drops: [{ item: 'string', count: [0, 2] }],
        path: { height: 1, climb: true, maxDrop: 5 },
        climbsWalls: true,
      },
      { width: 0.95, height: 0.85, eyeHeight: 0.6 },
    );
  }

  protected isAggressive(): boolean {
    if (this.forcedTarget || this.tactic) return true;
    const g = this.game;
    if (g.time.daylight < 0.45) return true;
    const x = Math.floor(this.position.x), y = Math.floor(this.position.y + 0.5), z = Math.floor(this.position.z);
    return g.world.getLight(x, y, z, g.time.daylight) <= 7;
  }

  protected behave(dt: number): StepInput {
    this.leapCooldown -= dt;
    const t = this.target;
    if (!t) return this.wander(dt);
    const input = this.chase(dt, t, true);
    const tp = this.targetPosition(t);
    const dx = tp.x - this.position.x, dz = tp.z - this.position.z;
    const d = Math.hypot(dx, dz);
    if (this.onGround && this.leapCooldown <= 0 && d > 1.8 && d < 4.5 && Math.abs(tp.y - this.position.y) < 1.5) {
      this.leapCooldown = 2 + Math.random() * 1.5;
      this.velocity.x = (dx / d) * 7.5;
      this.velocity.z = (dz / d) * 7.5;
      this.velocity.y = 5.8;
    }
    return input;
  }

  protected animate(_dt: number): void {
    const climbing = this.collidedHorizontally && this.velocity.y > 0.5;
    animateSpider(this.model, this.walkPhase * 1.7 + (climbing ? this.age * 14 : 0), Math.max(this.walkAmount, climbing ? 1 : 0));
    const body = this.model.parts.abdomen;
    if (body) body.rotation.x = Math.sin(this.age * 3) * 0.04;
  }
}

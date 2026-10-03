/**
 * Zombie: slow melee hunter that burns in daylight unless shaded. `baby_zombie` is small and
 * fast. Raid zombies may carry a shield (blocks most frontal damage and all frontal arrows).
 */
import { createZombieModel } from './models';
import { Mob } from './mob';

export interface ZombieOptions {
  baby?: boolean;
  shield?: boolean;
}

export class Zombie extends Mob {
  readonly type: string;
  readonly category = 'hostile' as const;
  readonly baby: boolean;

  constructor(opts: ZombieOptions = {}) {
    const baby = !!opts.baby;
    super(
      createZombieModel({ baby, shield: opts.shield }),
      {
        maxHealth: 20,
        speed: baby ? 4.1 : 2.6,
        attackDamage: baby ? 2 : 3,
        attackCooldown: 1,
        reach: 0.85,
        followRange: 24,
        hostility: 'hostile',
        burnsInDaylight: true,
        drops: [{ item: 'rotten_flesh', count: [0, 2] }],
        path: { height: baby ? 1 : 2 },
      },
      { width: baby ? 0.4 : 0.6, height: baby ? 0.95 : 1.9, eyeHeight: baby ? 0.8 : 1.65 },
    );
    this.type = baby ? 'baby_zombie' : 'zombie';
    this.baby = baby;
    this.shield = !!opts.shield;
  }

  protected animate(dt: number): void {
    super.animate(dt);
    const p = this.model.parts;
    // Arms held out in front, swaying; dropping a little on each hit.
    const sway = Math.sin(this.age * 2.2) * 0.06;
    const hit = this.swingTimer > 0 ? Math.sin((1 - this.swingTimer / 0.35) * Math.PI) * 0.6 : 0;
    const raised = this.target ? 1.45 : 1.25;
    if (p.rightArm) p.rightArm.rotation.x = raised + sway - hit;
    if (p.leftArm) p.leftArm.rotation.x = (this.shield ? 1.35 : raised) - sway - (this.shield ? 0 : hit);
    if (p.head) p.head.rotation.x = this.target ? -0.1 : 0.15;
  }
}

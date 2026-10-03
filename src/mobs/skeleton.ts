/**
 * Skeleton archer: keeps its distance, strafes around the target and shoots arcing arrows
 * (physical projectiles) when it has line of sight. Burns in daylight.
 */
import * as THREE from 'three';
import type { StepInput } from '../engine/physics';
import { flee, hasLineOfSight, strafe, turnTowards, yawTo } from './brain';
import { createSkeletonModel } from './models';
import { Mob } from './mob';
import { aimArrow, shootArrow } from './projectile';
import { getTacticBehavior } from './tactics';

const ARROW_SPEED = 26;
const DRAW_TIME = 0.9;

export class Skeleton extends Mob {
  readonly type = 'skeleton';
  readonly category = 'hostile' as const;
  private strafeDir = Math.random() < 0.5 ? 1 : -1;
  private strafeTimer = 2;
  private draw = 0;
  private cooldown = 1;
  private los = false;
  private losTimer = 0;

  constructor() {
    super(
      createSkeletonModel(),
      {
        maxHealth: 20,
        speed: 2.6,
        attackDamage: 0,
        attackCooldown: 1,
        reach: 0.8,
        followRange: 22,
        hostility: 'hostile',
        burnsInDaylight: true,
        drops: [{ item: 'bone', count: [0, 2] }, { item: 'arrow', count: [0, 2] }],
      },
      { width: 0.6, height: 1.9, eyeHeight: 1.65 },
    );
  }

  protected behave(dt: number): StepInput {
    const t = this.target;
    if (!t) {
      this.draw = Math.max(0, this.draw - dt);
      return this.wander(dt);
    }
    const tp = this.targetPosition(t, tmpT);
    const aim = this.targetEye(t, tmpAim);
    const dist = Math.hypot(tp.x - this.position.x, tp.z - this.position.z);
    this.losTimer -= dt;
    if (this.losTimer <= 0) {
      this.losTimer = 0.3;
      this.los = hasLineOfSight(this.game.world, this.eye(tmpEye), aim);
    }
    const behavior = this.tactic ? getTacticBehavior(this.tactic) : null;
    const [minR, maxR] = behavior?.range ?? [6, 13];
    const speed = this.stats.speed * this.speedMul * (behavior?.speed ?? 1);
    let input: StepInput;
    const onHighGround = this.tactic === 'rooftops' && this.position.y - tp.y > 1.5;
    if (onHighGround && this.los) {
      this.brain.stop();
      input = { moveX: 0, moveZ: 0, jump: false };
    } else if (dist > maxR || !this.los || this.tactic === 'rooftops') {
      input = this.chase(dt, t, false);
    } else if (dist < minR) {
      this.brain.stop();
      input = flee(this, tp.x, tp.z, speed);
    } else {
      this.brain.stop();
      this.strafeTimer -= dt;
      if (this.strafeTimer <= 0 || this.collidedHorizontally) {
        this.strafeTimer = 1.5 + Math.random() * 2.5;
        this.strafeDir = -this.strafeDir;
      }
      input = strafe(this, tp.x, tp.z, (minR + maxR) / 2, this.strafeDir, speed * 0.55);
    }
    if (this.los && dist < maxR + 8) {
      turnTowards(this, yawTo(this, tp.x, tp.z), dt, 12);
      this.cooldown -= dt;
      if (this.cooldown <= 0) {
        this.draw += dt;
        if (this.draw >= DRAW_TIME) {
          this.shoot(aim, t.kind === 'player' ? this.game.player.velocity : t.entity.velocity);
          this.draw = 0;
          this.cooldown = 0.8 + Math.random() * 1.2;
        }
      }
    } else this.draw = Math.max(0, this.draw - dt * 2);
    return input;
  }

  private shoot(aim: THREE.Vector3, targetVel: THREE.Vector3): void {
    const from = this.eye(tmpEye);
    const f = this.forward(tmpF);
    from.addScaledVector(f, 0.4);
    const flight = from.distanceTo(aim) / ARROW_SPEED;
    const lead = tmpLead.copy(aim).addScaledVector(targetVel, flight * 0.8);
    lead.y = aim.y;
    const v = aimArrow(from, lead, ARROW_SPEED) ?? lead.clone().sub(from).normalize().multiplyScalar(ARROW_SPEED);
    const spread = 0.9;
    v.x += (Math.random() - 0.5) * spread;
    v.y += (Math.random() - 0.5) * spread;
    v.z += (Math.random() - 0.5) * spread;
    shootArrow(this.game, { from, velocity: v, damage: 4, shooter: this });
    this.swingTimer = 0.2;
  }

  protected animate(dt: number): void {
    super.animate(dt);
    const p = this.model.parts;
    if (this.target) {
      const pull = Math.min(1, this.draw / DRAW_TIME);
      if (p.leftArm) {
        p.leftArm.rotation.x = Math.PI / 2;
        p.leftArm.rotation.y = 0.15;
      }
      if (p.rightArm) {
        p.rightArm.rotation.x = Math.PI / 2 - pull * 0.15;
        p.rightArm.rotation.y = -0.5 - pull * 0.35;
      }
    } else {
      if (p.leftArm) p.leftArm.rotation.y = 0;
      if (p.rightArm) p.rightArm.rotation.y = 0;
    }
  }
}

const tmpT = new THREE.Vector3();
const tmpAim = new THREE.Vector3();
const tmpEye = new THREE.Vector3();
const tmpF = new THREE.Vector3();
const tmpLead = new THREE.Vector3();

/**
 * The villager / golem entity: physics, path following, door opening, idle and work animation,
 * emotes, sleeping, and posture faces. Behaviour lives in {@link VillagerController} (actions)
 * and the schedule brain; this class only moves and animates the body.
 */
import * as THREE from 'three';
import { Entity, type DamageSource } from '../../engine/entity';
import { animateHumanoid } from '../../engine/box-model';
import type { Game } from '../../game/game';
import type { Vec3Like, GridNavigator } from '../nav';
import type { Bubble } from '../ui/bubbles';
import type { CastMember } from './cast';
import type { Particles } from './effects';
import { createGolemModel, createVillagerModel, type Expression, type NpcModel } from './model';
import type { VillagerController } from './controller';

/** What an NPC needs from the village. */
export interface NpcHost {
  readonly game: Game;
  readonly nav: GridNavigator;
  readonly particles: Particles;
  /** Opens a door for a passing NPC (it closes again behind them). */
  openDoor(x: number, y: number, z: number, by: Npc): void;
  onNpcHurt(npc: Npc, amount: number, source: DamageSource): void;
  /** Current village posture (drives idle faces). */
  readonly posture: Posture;
}

export type Posture = 'calm' | 'wary' | 'hostile' | 'festive';

/** A target that may move (player, entity) or a fixed point. */
export type Lookable = Vec3Like | { position: Vec3Like };

interface EmoteState {
  kind: string;
  t: number;
  dur: number;
}

const WALK = 2.4;
const RUN = 4.4;

export class Npc extends Entity {
  readonly type: string;
  readonly def: CastMember;
  readonly look: NpcModel;
  /** Set by the village right after construction. */
  controller!: VillagerController;
  bubble: Bubble | null = null;
  /** Items the NPC carries (gathered, fetched, taken). */
  readonly bag = new Map<string, number>();
  /** True while lying in bed. */
  sleeping = false;
  /** Physics off; the controller moves `position` directly (scaffold climbing). */
  kinematic = false;
  injured = false;
  /** Guard: sword out. */
  swordDrawn = false;
  /** Temporary expression override (glare, cheer) until `exprUntil`. */
  private exprOverride: Expression | null = null;
  private exprUntil = 0;
  private path: Vec3Like[] | null = null;
  private pathIndex = 0;
  private speed = WALK;
  /** Seconds without progress while following a path. */
  stuckTime = 0;
  private progressRef = new THREE.Vector3();
  private progressTimer = 0;
  private lookTarget: Lookable | null = null;
  private lookUntil = 0;
  private swingT = 0;
  private workUntil = 0;
  private emoteState: EmoteState | null = null;
  private walkPhase = 0;
  private walkAmount = 0;
  private headYaw = 0;
  private headPitch = 0;
  private healTimer = 0;
  private clock = 0;
  private idleGlance = 0;

  constructor(readonly host: NpcHost, def: CastMember) {
    super();
    this.def = def;
    const golem = def.profession === 'golem';
    this.type = golem ? 'iron_golem' : 'villager';
    this.look = golem ? createGolemModel() : createVillagerModel(def.id, def.profession, def.look);
    this.object3d = this.look.wrapper;
    this.width = golem ? 1.3 : 0.6;
    this.height = golem ? 2.75 : 1.9;
    this.eyeHeight = golem ? 2.35 : 1.55;
    this.maxHealth = this.health = golem ? 100 : 20;
    this.data.npcId = def.id;
    this.data.villager = true;
    this.data.faction = 'oakhollow';
    if (def.guard && !golem) this.swordDrawn = false;
  }

  /** True for the iron golem. */
  get isGolem(): boolean {
    return this.look.isGolem;
  }

  // -- movement ------------------------------------------------------------------------------

  /** Starts following a path of feet cells. */
  followPath(path: Vec3Like[], run = false): void {
    this.sleeping = false;
    this.path = path;
    this.pathIndex = 0;
    this.speed = (run ? RUN : WALK) * (this.isGolem ? 0.85 : 1);
    this.stuckTime = 0;
    this.progressTimer = 0;
    this.progressRef.copy(this.position);
  }

  stopMoving(): void {
    this.path = null;
  }

  /** True while a path is being followed. */
  get moving(): boolean {
    return this.path !== null && this.pathIndex < this.path.length;
  }

  /** Remaining waypoints. */
  get remainingPath(): number {
    return this.path ? this.path.length - this.pathIndex : 0;
  }

  /** Puts the NPC at a feet position immediately. */
  teleport(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.fallDistance = 0;
    this.path = null;
  }

  // -- looks and animation hooks ---------------------------------------------------------------

  /** Looks at a point or entity for `seconds` (Infinity until cleared). */
  lookAtTarget(t: Lookable | null, seconds = 2.5): void {
    this.lookTarget = t;
    this.lookUntil = this.clock + seconds;
  }

  /** Turns the body towards a point now. */
  face(x: number, z: number): void {
    this.lookAt(x, z);
  }

  /** One arm swing (placing, mining, hammering). */
  swing(): void {
    this.swingT = 1;
    this.workUntil = this.clock + 0.6;
  }

  /** Keeps the arms free (unfolded) for a while, e.g. while carrying. */
  busyArms(seconds: number): void {
    this.workUntil = Math.max(this.workUntil, this.clock + seconds);
  }

  /** Plays an emote animation for `seconds`. */
  playEmote(kind: string, seconds = 1.6): void {
    this.emoteState = { kind, t: 0, dur: seconds };
    if (kind === 'glare' || kind === 'stare' || kind === 'stamp') this.setExpressionFor('hostile', seconds + 0.5);
    else if (kind === 'cheer' || kind === 'laugh' || kind === 'wave') this.setExpressionFor('festive', seconds);
    else if (kind === 'cry' || kind === 'sad') this.setExpressionFor('sad', seconds);
    if (kind === 'offer_flower') this.look.setFlower(true);
  }

  get emoting(): boolean {
    return this.emoteState !== null;
  }

  setExpressionFor(e: Expression, seconds: number): void {
    this.exprOverride = e;
    this.exprUntil = this.clock + seconds;
  }

  /** Shows a carried block of this colour (null hides it). */
  carry(color: number | null): void {
    this.look.setHeld(color);
    if (color !== null) this.busyArms(1.5);
  }

  /** Lies down on a bed (feet block → head block). */
  lieDown(foot: Vec3Like, head: Vec3Like): void {
    this.path = null;
    this.sleeping = true;
    const dx = head.x - foot.x, dz = head.z - foot.z;
    this.yaw = Math.atan2(dx, dz);
    this.position.set(foot.x + 0.5 - dx * 0.4, foot.y + 1.02, foot.z + 0.5 - dz * 0.4);
    this.velocity.set(0, 0, 0);
    this.look.model.root.rotation.x = Math.PI / 2;
    this.look.model.root.position.y = 0.2;
  }

  /** Gets up from bed. */
  wake(): void {
    if (!this.sleeping) return;
    this.sleeping = false;
    this.look.model.root.rotation.x = 0;
    this.look.model.root.position.y = 0;
    this.position.y += 0.1;
  }

  // -- damage ----------------------------------------------------------------------------------

  hurt(amount: number, source: DamageSource): boolean {
    if (this.def.immortal) amount = Math.min(amount, this.health - 1);
    if (amount <= 0) {
      if (this.hurtCooldown > 0) return false;
      this.hurtCooldown = 0.5;
      this.look.model.flash(0.25);
      this.host.onNpcHurt(this, 0, source);
      return false;
    }
    if (this.sleeping) this.wake();
    const ok = super.hurt(amount, source);
    if (ok) {
      this.look.model.flash(0.3);
      this.injured = this.health < this.maxHealth * 0.5;
      this.host.onNpcHurt(this, amount, source);
    }
    return ok;
  }

  onRemoved(): void {
    this.bubble?.remove();
    this.look.dispose();
  }

  // -- frame -----------------------------------------------------------------------------------

  update(dt: number): void {
    this.clock += dt;
    // Slow healing.
    if (this.health < this.maxHealth) {
      this.healTimer += dt;
      if (this.healTimer > 4) {
        this.healTimer = 0;
        this.health = Math.min(this.maxHealth, this.health + 1);
        this.injured = this.health < this.maxHealth * 0.5;
      }
    }
    if (this.sleeping) {
      this.velocity.set(0, 0, 0);
      this.animate(dt, 0);
      return;
    }
    let moveX = 0, moveZ = 0, jump = false;
    if (!this.kinematic && this.path && this.pathIndex < this.path.length) {
      const p = this.position;
      // Skip waypoints we are already at.
      let wp = this.path[this.pathIndex];
      let dx = wp.x + 0.5 - p.x, dz = wp.z + 0.5 - p.z;
      let dist = Math.hypot(dx, dz);
      const dy = wp.y - p.y;
      const reached = dist < (this.pathIndex === this.path.length - 1 ? 0.25 : 0.38) && (Math.abs(dy) < 0.6 || (dy < 0 && this.onGround));
      if (reached) {
        this.pathIndex++;
        if (this.pathIndex < this.path.length) {
          wp = this.path[this.pathIndex];
          dx = wp.x + 0.5 - p.x;
          dz = wp.z + 0.5 - p.z;
          dist = Math.hypot(dx, dz);
        }
      }
      if (this.pathIndex < this.path.length) {
        const last = this.pathIndex === this.path.length - 1;
        const sp = last ? Math.min(this.speed, 0.6 + dist * 3) : this.speed;
        if (dist > 0.05) {
          moveX = (dx / dist) * sp;
          moveZ = (dz / dist) * sp;
        }
        const up = wp.y > p.y + 0.4;
        jump = (up && (this.onGround || this.onLadder || this.inWater)) || (this.collidedHorizontally && this.onGround) || (this.inWater && wp.y >= p.y);
        if (this.onLadder && up && dist < 0.7) {
          moveX *= 0.3;
          moveZ *= 0.3;
          jump = true;
        }
        // Doors on the next two cells.
        for (let j = this.pathIndex; j < Math.min(this.path.length, this.pathIndex + 2); j++) {
          const c = this.path[j];
          this.host.openDoor(c.x, c.y, c.z, this);
          this.host.openDoor(c.x, c.y + 1, c.z, this);
        }
        // Progress tracking for stuck detection.
        this.progressTimer += dt;
        if (this.progressTimer >= 1) {
          if (this.position.distanceTo(this.progressRef) < 0.25) this.stuckTime += this.progressTimer;
          else this.stuckTime = 0;
          this.progressTimer = 0;
          this.progressRef.copy(this.position);
        }
        // Face the way we walk.
        if (dist > 0.1) this.turnTowards(Math.atan2(-dx, -dz), dt, 10);
      }
    }
    if (!this.kinematic) this.move(dt, { moveX, moveZ, jump, accel: 12, jumpVelocity: 8.6 });
    else this.velocity.set(0, 0, 0);
    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    this.animate(dt, hs);
  }

  private turnTowards(target: number, dt: number, rate: number): void {
    let d = target - this.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.yaw += d * Math.min(1, rate * dt);
  }

  private currentExpression(): Expression {
    if (this.exprOverride && this.clock < this.exprUntil) return this.exprOverride;
    this.exprOverride = null;
    if (this.injured) return 'sad';
    const p = this.host.posture;
    return p === 'calm' ? 'calm' : p;
  }

  private animate(dt: number, speed: number): void {
    const m = this.look.model;
    const parts = m.parts;
    this.walkPhase += speed * dt * 2.8;
    this.walkAmount += ((speed > 0.2 ? Math.min(1, speed / 2.2) : 0) - this.walkAmount) * Math.min(1, dt * 8);
    animateHumanoid(m, this.walkPhase, this.walkAmount, 0);
    if (parts.body) parts.body.rotation.x = 0;

    // Head look.
    let wantYaw = 0, wantPitch = 0;
    const game = this.host.game;
    let target: Lookable | null = this.lookTarget && this.clock < this.lookUntil ? this.lookTarget : null;
    if (!target && !this.moving && !this.sleeping) {
      // Idle: glance at the player when close (more when wary/hostile).
      const pl = game.player.position;
      const d = pl.distanceTo(this.position);
      const posture = this.host.posture;
      const range = posture === 'hostile' ? 14 : posture === 'wary' ? 10 : 6;
      this.idleGlance -= dt;
      if (d < range && (posture !== 'calm' || this.idleGlance > -4)) target = game.player;
      if (this.idleGlance < -9) this.idleGlance = 3;
    }
    if (target) {
      const tp = 'position' in target ? target.position : target;
      const ty = 'position' in target ? (target as { position: Vec3Like }).position.y + 1.5 : tp.y;
      const dx = tp.x - this.position.x, dz = tp.z - this.position.z;
      const abs = Math.atan2(-dx, -dz);
      let rel = abs - this.yaw;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      if (Math.abs(rel) > 1.1 && !this.moving && !this.sleeping) this.turnTowards(abs, dt, 4);
      wantYaw = Math.max(-1.0, Math.min(1.0, rel));
      const horiz = Math.hypot(dx, dz) || 1;
      wantPitch = Math.max(-0.6, Math.min(0.6, -Math.atan2(ty - (this.position.y + this.eyeHeight), horiz)));
    }
    this.headYaw += (wantYaw - this.headYaw) * Math.min(1, dt * 8);
    this.headPitch += (wantPitch - this.headPitch) * Math.min(1, dt * 8);
    if (parts.head) {
      parts.head.rotation.y = this.headYaw;
      parts.head.rotation.x = this.headPitch;
      parts.head.rotation.z = 0;
    }

    // Arms: free while working, carrying or emoting.
    const working = this.clock < this.workUntil || this.swingT > 0 || this.emoteState !== null || this.swordDrawn || this.isGolem;
    this.look.setArmsFree(working);
    if (parts.rightArm) parts.rightArm.rotation.z = 0;
    if (parts.leftArm) parts.leftArm.rotation.z = 0;
    if (this.swordDrawn && parts.rightArm) parts.rightArm.rotation.x = -0.5;
    this.look.setSword(this.swordDrawn);
    if (this.clock < this.workUntil && parts.rightArm && parts.leftArm && this.walkAmount < 0.3) {
      parts.rightArm.rotation.x = -0.6;
      parts.leftArm.rotation.x = -0.6;
    }
    if (this.swingT > 0 && parts.rightArm) {
      this.swingT = Math.max(0, this.swingT - dt * 3.5);
      parts.rightArm.rotation.x = -0.5 - Math.sin(this.swingT * Math.PI) * 1.5;
    }
    if (this.emoteState) this.animateEmote(dt);

    this.look.setExpression(this.currentExpression());
    this.look.setPartyHat(this.host.posture === 'festive' && !this.isGolem);
    m.tick(dt);
  }

  private animateEmote(dt: number): void {
    const e = this.emoteState!;
    e.t += dt;
    const p = this.look.model.parts;
    const t = e.t;
    const s = Math.sin(t * 10);
    switch (e.kind) {
      case 'wave':
        if (p.rightArm) { p.rightArm.rotation.x = -2.8; p.rightArm.rotation.z = s * 0.35; }
        break;
      case 'cheer':
        if (p.rightArm) p.rightArm.rotation.x = -2.9;
        if (p.leftArm) p.leftArm.rotation.x = -2.9;
        this.look.model.root.position.y = Math.abs(Math.sin(t * 7)) * 0.15;
        break;
      case 'nod':
      case 'yes':
        if (p.head) p.head.rotation.x = Math.max(0, Math.sin(t * 9)) * 0.45;
        break;
      case 'shake':
      case 'no':
        if (p.head) p.head.rotation.y = Math.sin(t * 11) * 0.5;
        break;
      case 'think':
        if (p.rightArm) { p.rightArm.rotation.x = -2.0; p.rightArm.rotation.z = 0.5; }
        if (p.head) { p.head.rotation.z = 0.2; p.head.rotation.x = -0.2; }
        break;
      case 'hammer':
        if (p.rightArm) p.rightArm.rotation.x = -0.6 - Math.max(0, Math.sin(t * 9)) * 1.6;
        break;
      case 'glare':
      case 'stare':
        if (p.head) p.head.rotation.x = 0.15;
        break;
      case 'laugh':
        if (p.head) p.head.rotation.x = -0.25 + Math.abs(s) * 0.15;
        if (p.body) p.body.rotation.x = Math.abs(s) * 0.08;
        break;
      case 'shrug':
        if (p.rightArm) { p.rightArm.rotation.x = -0.4; p.rightArm.rotation.z = 0.6; }
        if (p.leftArm) { p.leftArm.rotation.x = -0.4; p.leftArm.rotation.z = -0.6; }
        break;
      case 'bow':
        if (p.body) p.body.rotation.x = Math.sin(Math.min(1, t / e.dur) * Math.PI) * 0.5;
        if (p.head) p.head.rotation.x = Math.sin(Math.min(1, t / e.dur) * Math.PI) * 0.5;
        break;
      case 'cry':
      case 'sad':
        if (p.head) p.head.rotation.x = 0.5;
        break;
      case 'offer_flower':
        if (p.rightArm) p.rightArm.rotation.x = -1.3;
        break;
      case 'stamp':
        this.look.model.root.position.y = Math.max(0, Math.sin(t * 8)) * 0.12;
        if (Math.sin(t * 8) < -0.95 && this.onGround) this.host.particles.burst(this.position.x, this.position.y + 0.1, this.position.z, 0x8a7a66, 2, 1.5);
        break;
      case 'creak':
        if (p.head) { p.head.rotation.z = Math.sin(t * 2) * 0.25; p.head.rotation.x = 0.1; }
        break;
      default:
        if (p.head) p.head.rotation.x = Math.max(0, Math.sin(t * 8)) * 0.3;
    }
    if (e.t >= e.dur) {
      this.emoteState = null;
      this.look.model.root.position.y = this.sleeping ? 0.2 : 0;
      this.look.setFlower(false);
    }
  }
}

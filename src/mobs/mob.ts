/**
 * Mob base class: box model, MobBrain pathing, targeting (player, prey entities, attackers),
 * melee, wandering, daylight burning, lava/fire, fall damage, shield blocking, hurt flash,
 * knockback, drops, a death tip-over animation and raid tactics.
 *
 * Subclasses (zombie, skeleton, creeper, spider, pig, cow) override `behave` and `animate`.
 */
import * as THREE from 'three';
import type { DropSpec } from '../engine/blocks';
import { animateHumanoid, type BoxModel } from '../engine/box-model';
import { Entity, type DamageSource } from '../engine/entity';
import type { StepInput } from '../engine/physics';
import type { Game } from '../game/game';
import { getHealth, hurtPlayer } from '../survival/health';
import { dropItem } from '../survival/item-drops';
import { getParticles } from '../survival/particles';
import { service } from '../survival/service';
import { MobBrain, hasLineOfSight, separate, turnTowards, yawTo } from './brain';
import type { PathOptions } from './pathfind';
import { getTacticBehavior, tacticNames, type TacticContext } from './tactics';

/** What a mob is after: the player or another entity. */
export type MobTarget = { kind: 'player' } | { kind: 'entity'; entity: Entity };

export type Hostility = 'hostile' | 'neutral' | 'passive';

export interface MobStats {
  maxHealth: number;
  /** Chase speed (blocks/s). */
  speed: number;
  /** Idle wander speed. Default speed × 0.45. */
  wanderSpeed?: number;
  /** Melee damage in half-hearts (0 = no melee). */
  attackDamage: number;
  /** Seconds between melee hits. */
  attackCooldown: number;
  /** Melee reach beyond the body edge (blocks). */
  reach: number;
  /** Target detection range (blocks). */
  followRange: number;
  hostility: Hostility;
  burnsInDaylight: boolean;
  /** Death drops. */
  drops: DropSpec[];
  /** Path options (height, climb, ...). */
  path?: PathOptions;
  /** Physically climbs walls it walks into (spiders). */
  climbsWalls?: boolean;
}

/** Entity types zombies and other hostiles also hunt (V2 villagers). Add more as needed. */
export const PREY_TYPES = new Set<string>(['villager']);

export abstract class Mob extends Entity {
  abstract readonly type: string;
  readonly model: BoxModel;
  readonly brain: MobBrain;
  readonly stats: MobStats;
  /** 'hostile' or 'animal' (spawn caps). */
  abstract readonly category: 'hostile' | 'animal';
  /** Active raid tactic, if any (see tactics.ts). */
  tactic: string | null = null;
  /** Scratch state for the tactic behaviour. */
  readonly tacticState: Record<string, unknown> = {};
  /** Never despawns. */
  persistent = false;
  /** Spawned by natural spawn rules (counts towards caps, may despawn). */
  natural = false;
  fireproof = false;
  shield = false;
  speedMul = 1;
  followRange: number;
  /** Current target (updated a few times per second). */
  target: MobTarget | null = null;
  /** A fixed target set by spawn options or the director. */
  forcedTarget: MobTarget | null = null;
  /** Seconds left on fire. */
  burning = 0;
  /** Seconds since spawn. */
  age = 0;
  protected walkPhase = 0;
  protected walkAmount = 0;
  protected attackTimer = 0;
  /** Seconds left of the arm-swing animation. */
  protected swingTimer = 0;
  protected neighbours: Entity[] = [];
  private provoked: { target: MobTarget; until: number } | null = null;
  private thinkTimer = Math.random() * 0.3;
  private wanderTimer = 1 + Math.random() * 4;
  private fireTimer = 0;
  private baseBrightness = 1;
  private lastLos = true;

  constructor(model: BoxModel, stats: MobStats, size: { width: number; height: number; eyeHeight?: number }) {
    super();
    this.model = model;
    this.stats = stats;
    this.width = size.width;
    this.height = size.height;
    this.eyeHeight = size.eyeHeight ?? size.height * 0.85;
    this.maxHealth = this.health = stats.maxHealth;
    this.followRange = stats.followRange;
    this.object3d = model.root;
    this.brain = new MobBrain(this, { speed: stats.speed, path: { ...stats.path }, onDig: (x, y, z, dt) => this.dig(x, y, z, dt) });
  }

  // -- targets -----------------------------------------------------------------------------------

  /** True if the player can currently be targeted (survival, alive). */
  playerTargetable(): boolean {
    const g = this.game;
    return g.player.mode === 'survival' && !g.player.frozen && !getHealth(g).dead;
  }

  /** Feet position of a target. */
  targetPosition(t: MobTarget, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(t.kind === 'player' ? this.game.player.position : t.entity.position);
  }

  /** Eye-ish point of a target (for aiming and line of sight). */
  targetEye(t: MobTarget, out = new THREE.Vector3()): THREE.Vector3 {
    if (t.kind === 'player') return this.game.player.eye(out).setY(this.game.player.position.y + 1.3);
    return out.set(t.entity.position.x, t.entity.position.y + t.entity.height * 0.7, t.entity.position.z);
  }

  targetValid(t: MobTarget | null): boolean {
    if (!t) return false;
    if (t.kind === 'player') return this.playerTargetable();
    return !t.entity.removed && t.entity.health > 0;
  }

  /** Damages a target as this mob. */
  hitTarget(t: MobTarget, amount: number, kind = 'melee'): boolean {
    if (t.kind === 'player') return hurtPlayer(this.game, amount, { kind, entity: this });
    return t.entity.hurt(amount, { kind, entity: this });
  }

  /** Sets a fixed target ('player', an entity, or null to let the mob choose). */
  setTarget(t: 'player' | Entity | null): void {
    this.forcedTarget = t === null ? null : t === 'player' ? { kind: 'player' } : { kind: 'entity', entity: t };
  }

  /** Sets (or clears) the raid tactic and applies its path options. */
  setTactic(name: string | null): void {
    this.tactic = name;
    for (const k of Object.keys(this.tacticState)) delete this.tacticState[k];
    const b = name ? getTacticBehavior(name) : null;
    if (name && !b) console.warn(`[mobs] unknown tactic "${name}" (known: ${tacticNames().join(', ')})`);
    this.brain.pathOptions = { height: Math.ceil(this.height), ...this.stats.path, ...b?.path };
    this.brain.repath();
  }

  /** Whether a neutral mob is currently aggressive (spiders: at night or in the dark). */
  protected isAggressive(): boolean {
    return this.stats.hostility === 'hostile';
  }

  private updateTarget(): void {
    if (this.forcedTarget) {
      if (this.targetValid(this.forcedTarget)) {
        this.target = this.forcedTarget;
        return;
      }
      if (this.forcedTarget.kind === 'entity') this.forcedTarget = null;
    }
    if (this.provoked && this.age < this.provoked.until && this.targetValid(this.provoked.target)) {
      this.target = this.provoked.target;
      return;
    }
    this.provoked = null;
    if (this.stats.hostility === 'passive' || !this.isAggressive()) {
      this.target = null;
      return;
    }
    const range = this.followRange;
    const p = this.game.player.position;
    const pd = this.position.distanceTo(p);
    const keeping = this.target?.kind === 'player';
    let best: MobTarget | null = null;
    let bestD = Infinity;
    if (this.playerTargetable() && pd < (keeping ? range * 1.3 : range)) {
      const eye = this.eye(tmpA);
      const los = keeping || pd < 8 || hasLineOfSight(this.game.world, eye, this.game.player.eye(tmpB));
      if (los || this.tactic) {
        best = { kind: 'player' };
        bestD = pd;
      }
    }
    if (PREY_TYPES.size) {
      const prey = this.game.entities.nearest(this.position, Math.min(bestD, range * 0.75), (e) => PREY_TYPES.has(e.type) && e.health > 0 && !e.removed);
      if (prey) best = { kind: 'entity', entity: prey };
    }
    this.target = best;
  }

  // -- update ------------------------------------------------------------------------------------

  update(dt: number): void {
    this.age += dt;
    this.attackTimer -= dt;
    this.swingTimer = Math.max(0, this.swingTimer - dt);
    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer = 0.25 + Math.random() * 0.1;
      this.updateTarget();
      this.checkSunlight();
      this.neighbours = this.game.entities.query(this.position, 1.6, (e) => e !== this && !e.removed);
    }
    this.environment(dt);
    if (this.removed || this.health <= 0) return;

    const input = this.behave(dt);
    if (this.neighbours.length) separate(this, this.neighbours, input);
    const pushing = Math.abs(input.moveX ?? 0) + Math.abs(input.moveZ ?? 0) > 0.1;
    const landed = this.move(dt, input);
    if ((this.stats.climbsWalls || this.tactic === 'climb_pillar') && this.collidedHorizontally && pushing && !this.inWater) {
      this.velocity.y = Math.max(this.velocity.y, this.stats.climbsWalls ? 3.2 : 2.6);
      this.fallDistance = 0;
    }
    if (landed > 3.5 && !this.stats.climbsWalls) this.hurt(Math.floor(landed - 3), { kind: 'fall' });

    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    this.walkPhase += hs * dt * 3.4;
    this.walkAmount += (Math.min(1, hs / Math.max(1, this.stats.speed * 0.8)) - this.walkAmount) * Math.min(1, dt * 8);
    this.animate(dt);
    this.model.tick(dt);
  }

  /**
   * AI for this frame: returns movement input. Default: hostile melee chase (with tactics), or
   * wandering when there is no target.
   */
  protected behave(dt: number): StepInput {
    const t = this.target;
    if (!t) return this.wander(dt);
    return this.chase(dt, t, true);
  }

  /** Walks towards a target (applying the tactic) and melees it when in reach. */
  protected chase(dt: number, t: MobTarget, melee: boolean): StepInput {
    const tp = this.targetPosition(t, tmpTarget);
    const behavior = this.tactic ? getTacticBehavior(this.tactic) : null;
    this.brain.speed = this.stats.speed * this.speedMul * (behavior?.speed ?? 1);
    const dist = Math.hypot(tp.x - this.position.x, tp.z - this.position.z);
    const ctx: TacticContext = { mob: this, game: this.game, target: tp, distance: dist, dt };
    const goal = behavior?.goal?.(ctx) ?? tp;
    this.brain.moveTo(goal.x, goal.y, goal.z);
    const input = this.brain.update(dt);
    behavior?.act?.(ctx, input);
    if (melee && this.stats.attackDamage > 0) {
      const dy = tp.y - this.position.y;
      const tw = t.kind === 'player' ? this.game.player.width : t.entity.width;
      if (dist <= this.stats.reach + (this.width + tw) / 2 && dy > -1.5 && dy < 2) {
        turnTowards(this, yawTo(this, tp.x, tp.z), dt, 14);
        if (this.attackTimer <= 0 && this.attackAllowed(t)) {
          this.attackTimer = this.stats.attackCooldown;
          this.swingTimer = 0.35;
          this.meleeAttack(t);
        }
      }
    }
    return input;
  }

  /** Can this mob attack the target right now (line of sight, not through walls)? */
  protected attackAllowed(t: MobTarget): boolean {
    return hasLineOfSight(this.game.world, this.eye(tmpA), this.targetEye(t, tmpB));
  }

  /** Performs a melee hit. */
  protected meleeAttack(t: MobTarget): void {
    this.hitTarget(t, this.stats.attackDamage, 'melee');
  }

  /** Idle wandering (random nearby walkable spots). */
  protected wander(dt: number): StepInput {
    this.wanderTimer -= dt;
    if (this.wanderTimer <= 0) {
      this.wanderTimer = 5 + Math.random() * 8;
      if (Math.random() < 0.75) {
        const a = Math.random() * Math.PI * 2;
        const r = 3 + Math.random() * 7;
        const x = this.position.x + Math.cos(a) * r, z = this.position.z + Math.sin(a) * r;
        const y = this.game.world.findGround(x, z, Math.floor(this.position.y) + 4);
        if (y !== null && Math.abs(y - this.position.y) < 5) {
          this.brain.speed = (this.stats.wanderSpeed ?? this.stats.speed * 0.45) * this.speedMul;
          this.brain.moveTo(Math.floor(x) + 0.5, y, Math.floor(z) + 0.5);
        }
      }
    }
    if (this.brain.arrived || this.brain.state === 'failed') this.brain.stop();
    return this.brain.update(dt);
  }

  // -- environment -------------------------------------------------------------------------------

  private checkSunlight(): void {
    if (!this.stats.burnsInDaylight || this.fireproof || this.inWater) return;
    const g = this.game;
    if (g.time.daylight < 0.55 || g.weather.intensity > 0.5) return;
    const x = Math.floor(this.position.x), y = Math.floor(this.position.y + this.height - 0.1), z = Math.floor(this.position.z);
    if (g.world.getSkyLight(x, y, z) >= 15) this.burning = Math.max(this.burning, 3);
  }

  private environment(dt: number): void {
    if (this.inLava) {
      this.burning = 8;
      this.hurt(4, { kind: 'lava' });
    }
    if (this.inWater) this.burning = 0;
    if (this.burning > 0) {
      this.burning -= dt;
      this.fireTimer += dt;
      if (this.fireTimer >= 1) {
        this.fireTimer = 0;
        this.hurt(1, { kind: 'fire' });
      }
      if (Math.random() < dt * 14) {
        getParticles(this.game).burst({
          x: this.position.x, y: this.position.y + Math.random() * this.height, z: this.position.z,
          count: 1, color: ['#ffd23a', '#ff8a1e', '#ff5a14'], speed: 0.4, up: 1.2, gravity: -1, size: 0.12, life: 0.5, spread: this.width / 2,
        });
      }
    }
  }

  // -- damage ------------------------------------------------------------------------------------

  hurt(amount: number, source: DamageSource): boolean {
    if (this.removed || this.health <= 0) return false;
    const attackerPos = source.entity ? source.entity.position : source.player ? this.game?.player.position : null;
    if (this.shield && attackerPos && source.kind !== 'fire' && source.kind !== 'lava' && source.kind !== 'fall') {
      const f = this.forward(tmpA);
      const dx = attackerPos.x - this.position.x, dz = attackerPos.z - this.position.z;
      const d = Math.hypot(dx, dz) || 1;
      if ((f.x * dx + f.z * dz) / d > 0.35) {
        getParticles(this.game).burst({ x: this.position.x + f.x * 0.5, y: this.position.y + 1.2, z: this.position.z + f.z * 0.5, count: 5, color: ['#ffffff', '#c8c8d0'], speed: 2, size: 0.05, life: 0.25 });
        if (source.kind === 'arrow' || amount <= 2) return false;
        amount = Math.max(1, Math.round(amount * 0.25));
      }
    }
    const ok = super.hurt(amount, source);
    if (!ok) return false;
    this.model.flash(0.35);
    if (source.player && !source.entity && this.game) {
      const p = this.game.player.position;
      const dx = this.position.x - p.x, dz = this.position.z - p.z;
      const d = Math.hypot(dx, dz) || 1;
      this.velocity.x += (dx / d) * 6;
      this.velocity.z += (dz / d) * 6;
      this.velocity.y = Math.max(this.velocity.y, 5);
    }
    const attacker: MobTarget | null = source.entity && source.entity !== this ? { kind: 'entity', entity: source.entity } : source.player ? { kind: 'player' } : null;
    if (attacker) this.onAttacked(attacker);
    return true;
  }

  /** Called after taking damage from an attacker. Default: retaliate for 15 s. */
  protected onAttacked(attacker: MobTarget): void {
    if (this.stats.hostility === 'passive') return;
    if (attacker.kind === 'entity' && attacker.entity instanceof Mob && attacker.entity.category === 'hostile' && this.category === 'hostile') return;
    this.provoked = { target: attacker, until: this.age + 15 };
    this.target = attacker;
  }

  onDeath(source: DamageSource): void {
    const g = this.game;
    const byPlayer = !!source.player;
    g.events.emit('mobKilled', { mob: this, type: this.type, byPlayer, source, tactic: this.tactic });
    const pos = { x: this.position.x, y: this.position.y + 0.4, z: this.position.z };
    for (const d of this.stats.drops) {
      if (d.chance !== undefined && Math.random() >= d.chance) continue;
      const n = typeof d.count === 'number' ? d.count : d.count ? d.count[0] + Math.floor(Math.random() * (d.count[1] - d.count[0] + 1)) : 1;
      let item = d.item;
      if (this.burning > 0 && item === 'raw_porkchop') item = 'cooked_porkchop';
      if (this.burning > 0 && item === 'raw_beef') item = 'cooked_beef';
      if (n > 0) dropItem(g, { item, count: n }, pos);
    }
    getCorpses(g).add(this.model, this.position, this.yaw, this.width, this.height);
    this.object3d = null;
    this.brain.dispose();
  }

  onRemoved(): void {
    this.brain.dispose();
    if (this.object3d) this.model.dispose();
  }

  applyBrightness(b: number): void {
    this.baseBrightness = b;
    this.model.setBrightness(this.burning > 0 ? Math.min(1.6, b + 0.5) : b);
  }

  // -- animation ---------------------------------------------------------------------------------

  /** Default humanoid walk + arm swing; override for other bodies. */
  protected animate(_dt: number): void {
    animateHumanoid(this.model, this.walkPhase, this.walkAmount);
    if (this.swingTimer > 0) {
      const s = Math.sin((1 - this.swingTimer / 0.35) * Math.PI);
      const arm = this.model.parts.rightArm;
      if (arm) arm.rotation.x = -s * 1.4;
    }
  }

  // -- tunnelling --------------------------------------------------------------------------------

  private digKey = '';
  private digTime = 0;

  /** Digs one block (tunnel paths). Returns true once it is gone. */
  protected dig(x: number, y: number, z: number, dt: number): boolean {
    const g = this.game;
    const key = `${x},${y},${z}`;
    if (key !== this.digKey) {
      this.digKey = key;
      this.digTime = 0;
    }
    this.digTime += dt;
    this.swingTimer = 0.35;
    const id = g.world.getBlock(x, y, z);
    const hardness = Math.max(0.2, g.blocks.byId(id).hardness);
    if (Math.random() < dt * 6) getParticles(g).burst({ x: x + 0.5, y: y + 0.5, z: z + 0.5, count: 2, color: ['#7a6a5a', '#5a4a3a', '#8a8a8a'], speed: 1.5, size: 0.06, life: 0.35 });
    if (this.digTime < 0.35 + hardness * 0.55) return false;
    this.digKey = '';
    g.breakBlock(x, y, z, { source: 'entity', entity: this, drop: false });
    return true;
  }

  /** Spawns a short puff (spawn/teleport feedback). */
  puff(color = '#ffffff'): void {
    getParticles(this.game).burst({ x: this.position.x, y: this.position.y + this.height / 2, z: this.position.z, count: 14, color: [color, '#d8d8d8'], speed: 1.6, up: 0.6, gravity: -0.5, size: 0.14, life: 0.6, spread: this.width / 2 });
  }
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpTarget = new THREE.Vector3();

// -- corpses -------------------------------------------------------------------------------------

/** Plays the death animation (tip over, red, then a puff) on models of dead mobs. */
class Corpses {
  private readonly list: { model: BoxModel; t: number; w: number; h: number }[] = [];
  constructor(private readonly game: Game) {
    game.addSystem({ name: 'mob-corpses', update: (dt) => this.update(dt) });
  }

  add(model: BoxModel, pos: THREE.Vector3, yaw: number, w: number, h: number): void {
    const root = model.root;
    this.game.scene.add(root);
    root.position.copy(pos);
    root.rotation.order = 'YXZ';
    root.rotation.set(0, yaw, 0);
    model.flash(2);
    this.list.push({ model, t: 0, w, h });
  }

  private update(dt: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const c = this.list[i];
      c.t += dt;
      const k = Math.min(1, c.t / 0.45);
      c.model.root.rotation.z = k * k * (Math.PI / 2);
      c.model.tick(dt);
      if (c.t > 1.1) {
        const p = c.model.root.position;
        getParticles(this.game).burst({ x: p.x, y: p.y + 0.3, z: p.z, count: 16, color: ['#ffffff', '#e6e6e6', '#cfcfcf'], speed: 1.4, up: 0.8, gravity: -0.6, size: 0.16, life: 0.7, spread: Math.max(c.w, c.h) / 2 });
        this.game.scene.remove(c.model.root);
        c.model.dispose();
        this.list.splice(i, 1);
      }
    }
  }
}

const getCorpses = service((game) => new Corpses(game));

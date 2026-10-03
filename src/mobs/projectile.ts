/**
 * Arrows: physical projectiles with gravity and drag that hit blocks (and stick), entities and
 * the player. Used by skeletons and the player's bow.
 *
 * ```ts
 * shootArrow(game, { from: eye, velocity: dir.multiplyScalar(40), damage: 6, shooter: 'player' });
 * const v = aimArrow(from, targetPoint, 24); // ballistic launch velocity, or null if out of range
 * ```
 */
import * as THREE from 'three';
import { BLOCK_FLAGS, F_SOLID } from '../engine/blocks';
import { rayAabb } from '../engine/entities';
import type { Entity } from '../engine/entity';
import type { ItemStack } from '../engine/items';
import type { Game } from '../game/game';
import { hurtPlayer } from '../survival/health';
import { getParticles } from '../survival/particles';
import { service } from '../survival/service';

export const ARROW_GRAVITY = 20;
const STUCK_LIFE = 30;
const FLY_LIFE = 8;

export interface ArrowOptions {
  /** Launch point. */
  from: { x: number; y: number; z: number };
  /** Launch velocity in blocks/s. */
  velocity: { x: number; y: number; z: number };
  /** Damage at the launch speed (scaled by impact speed). */
  damage: number;
  /** Who shot it: an entity, 'player', or null. */
  shooter: Entity | 'player' | null;
  /** Critical (full-charge) shot: trail particles and +50% damage. */
  crit?: boolean;
  /** The player can pick it up again after it lands. Default: true for player arrows. */
  pickup?: boolean;
  /** The bow used (for damage sources). */
  item?: ItemStack | null;
}

export class Arrow {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  readonly object3d: THREE.Group;
  stuck = false;
  age = 0;
  removed = false;
  readonly launchSpeed: number;

  constructor(readonly opts: ArrowOptions, model: THREE.Group) {
    this.position.set(opts.from.x, opts.from.y, opts.from.z);
    this.velocity.set(opts.velocity.x, opts.velocity.y, opts.velocity.z);
    this.launchSpeed = Math.max(1, this.velocity.length());
    this.object3d = model;
  }
}

export class Projectiles {
  private readonly arrows: Arrow[] = [];
  private readonly group = new THREE.Group();
  private readonly shaftMat = new THREE.MeshLambertMaterial({ color: 0x8a6438 });
  private readonly tipMat = new THREE.MeshLambertMaterial({ color: 0xa8a8b4 });
  private readonly fletchMat = new THREE.MeshLambertMaterial({ color: 0xf0f0f0, side: THREE.DoubleSide });
  private readonly shaftGeo = new THREE.BoxGeometry(0.035, 0.035, 0.6);
  private readonly tipGeo = new THREE.BoxGeometry(0.07, 0.07, 0.08);
  private readonly fletchGeo = new THREE.PlaneGeometry(0.12, 0.14);

  constructor(private readonly game: Game) {
    this.group.name = 'projectiles';
    game.scene.add(this.group);
    game.addSystem({ name: 'projectiles', update: (dt) => this.update(dt) });
  }

  /** Live arrows (read-only). */
  all(): readonly Arrow[] {
    return this.arrows;
  }

  /** Launches an arrow. */
  shoot(opts: ArrowOptions): Arrow {
    const a = new Arrow({ pickup: opts.shooter === 'player', ...opts }, this.buildModel());
    this.group.add(a.object3d);
    this.arrows.push(a);
    this.orient(a);
    if (this.arrows.length > 120) this.remove(this.arrows[0]);
    return a;
  }

  remove(a: Arrow): void {
    if (a.removed) return;
    a.removed = true;
    const i = this.arrows.indexOf(a);
    if (i >= 0) this.arrows.splice(i, 1);
    this.group.remove(a.object3d);
  }

  private buildModel(): THREE.Group {
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(this.shaftGeo, this.shaftMat);
    const tip = new THREE.Mesh(this.tipGeo, this.tipMat);
    tip.position.z = -0.32;
    const f1 = new THREE.Mesh(this.fletchGeo, this.fletchMat);
    f1.rotation.y = Math.PI / 2;
    f1.position.z = 0.24;
    const f2 = f1.clone();
    f2.rotation.set(0, Math.PI / 2, Math.PI / 2);
    g.add(shaft, tip, f1, f2);
    return g;
  }

  private orient(a: Arrow): void {
    a.object3d.position.copy(a.position);
    const v = a.velocity;
    if (v.lengthSq() > 0.01) {
      a.object3d.rotation.order = 'YXZ';
      a.object3d.rotation.y = Math.atan2(-v.x, -v.z);
      a.object3d.rotation.x = Math.atan2(v.y, Math.hypot(v.x, v.z));
    }
  }

  private update(dt: number): void {
    const game = this.game;
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];
      a.age += dt;
      if (a.stuck) {
        if (a.age > STUCK_LIFE) this.remove(a);
        else this.tryPickup(a);
        continue;
      }
      if (a.age > FLY_LIFE || a.position.y < -10) {
        this.remove(a);
        continue;
      }
      a.velocity.y -= ARROW_GRAVITY * dt;
      a.velocity.multiplyScalar(Math.pow(0.85, dt));
      const step = tmpStep.copy(a.velocity).multiplyScalar(dt);
      const len = step.length();
      if (len < 1e-5) continue;
      const dir = tmpDir.copy(step).divideScalar(len);
      // Block hit.
      const hit = game.world.raycast(a.position, dir, len, { filter: (id) => (BLOCK_FLAGS[id] & F_SOLID) !== 0 });
      let maxT = hit ? hit.distance : len;
      // Entity hit.
      const shooterEntity = a.opts.shooter && a.opts.shooter !== 'player' ? a.opts.shooter : undefined;
      const ent = game.entities.raycast(a.position, dir, maxT, shooterEntity);
      // Player hit.
      let playerT: number | null = null;
      if (a.opts.shooter !== 'player' && !game.player.frozen) {
        const p = game.player.position, hw = game.player.width / 2;
        playerT = rayAabb(a.position, dir, p.x - hw, p.y, p.z - hw, p.x + hw, p.y + game.player.height, p.z + hw);
        if (playerT !== null && playerT > maxT) playerT = null;
      }
      const speed = a.velocity.length();
      const dmg = Math.max(1, Math.round(a.opts.damage * Math.min(1.3, speed / a.launchSpeed + 0.15) * (a.opts.crit ? 1.5 : 1)));
      if (playerT !== null && (!ent || playerT <= ent.distance)) {
        const kb = tmpKb.copy(dir).setY(0).normalize().multiplyScalar(4);
        hurtPlayer(game, dmg, { kind: 'arrow', entity: shooterEntity ?? null, knockback: { x: kb.x, y: 3, z: kb.z } });
        this.remove(a);
        continue;
      }
      if (ent) {
        const e = ent.entity;
        const ok = e.hurt(dmg, { kind: 'arrow', entity: shooterEntity ?? null, player: a.opts.shooter === 'player', item: a.opts.item ?? null });
        if (ok && a.opts.shooter === 'player') {
          e.velocity.x += dir.x * 4;
          e.velocity.z += dir.z * 4;
          e.velocity.y = Math.max(e.velocity.y, 3.5);
        }
        if (ok || e.health <= 0) {
          this.remove(a);
          continue;
        }
        // Deflected (shield / cooldown): drop it.
        a.velocity.multiplyScalar(-0.2);
        continue;
      }
      if (hit) {
        a.position.addScaledVector(dir, Math.max(0, hit.distance - 0.15));
        a.stuck = true;
        a.age = 0;
        a.object3d.position.copy(a.position);
        getParticles(game).burst({ x: a.position.x, y: a.position.y, z: a.position.z, count: 3, color: '#8a6438', speed: 1, size: 0.04, life: 0.3 });
        continue;
      }
      a.position.add(step);
      this.orient(a);
      if (a.opts.crit && Math.random() < 0.6) getParticles(game).burst({ x: a.position.x, y: a.position.y, z: a.position.z, count: 1, color: ['#ffffff', '#fff2a8'], speed: 0.3, up: 0, gravity: 0, size: 0.05, life: 0.35, spread: 0.05 });
    }
  }

  private tryPickup(a: Arrow): void {
    if (!a.opts.pickup) return;
    const p = this.game.player;
    if (p.frozen) return;
    const dx = p.position.x - a.position.x, dy = p.position.y + 0.9 - a.position.y, dz = p.position.z - a.position.z;
    if (dx * dx + dy * dy + dz * dz > 1.8) return;
    if (this.game.inventory.add({ item: 'arrow', count: 1 }) === 0) {
      this.game.events.emit('itemPickedUp', { item: 'arrow', count: 1 });
      this.remove(a);
    }
  }
}

const tmpStep = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpKb = new THREE.Vector3();

/** The game's projectile system (created on first use). */
export const getProjectiles = service((game) => new Projectiles(game));

/** Shoots an arrow. */
export function shootArrow(game: Game, opts: ArrowOptions): Arrow {
  return getProjectiles(game).shoot(opts);
}

/**
 * Launch velocity that lands an arrow fired at `speed` on `to` (low arc), compensating for
 * gravity. Returns null when the target is out of range at that speed.
 */
export function aimArrow(from: THREE.Vector3, to: THREE.Vector3, speed: number, gravity = ARROW_GRAVITY): THREE.Vector3 | null {
  const dx = to.x - from.x, dz = to.z - from.z;
  const d = Math.hypot(dx, dz);
  const h = to.y - from.y;
  if (d < 0.01) return new THREE.Vector3(0, Math.sign(h) * speed, 0);
  const v2 = speed * speed;
  const disc = v2 * v2 - gravity * (gravity * d * d + 2 * h * v2);
  if (disc < 0) return null;
  const angle = Math.atan((v2 - Math.sqrt(disc)) / (gravity * d));
  const c = Math.cos(angle);
  // Small extra lift for drag.
  const lift = 1 + d * 0.004;
  return new THREE.Vector3((dx / d) * speed * c, speed * Math.sin(angle) * lift, (dz / d) * speed * c);
}

/**
 * Player health (20 = 10 hearts), hunger (20), saturation, exhaustion, air, burning and death.
 *
 * Damage sources handled here: fall (`playerFell`), drowning, lava, fire (burning), cactus,
 * starvation. Mobs and explosions call {@link hurtPlayer}. Creative mode takes no damage.
 *
 * ```ts
 * hurtPlayer(game, 3, { kind: 'melee', entity: zombie });
 * getHealth(game).feed(5, 6);
 * ```
 */
import * as THREE from 'three';
import { BLOCK } from '../engine/blocks';
import type { DamageSource } from '../engine/entity';
import type { Game } from '../game/game';
import { dropItem } from './item-drops';
import { service } from './service';

/** Damage plus an optional explicit knockback vector (blocks/s). */
export interface PlayerDamageSource extends DamageSource {
  knockback?: { x: number; y: number; z: number };
}

export interface HealthData {
  health: number;
  hunger: number;
  saturation: number;
  exhaustion: number;
  air: number;
}

export const MAX_HEALTH = 20;
export const MAX_HUNGER = 20;
export const MAX_AIR = 15;

export class PlayerHealth {
  health = MAX_HEALTH;
  hunger = MAX_HUNGER;
  saturation = 5;
  exhaustion = 0;
  /** Seconds of air left underwater. */
  air = MAX_AIR;
  /** Seconds left on fire. */
  burning = 0;
  dead = false;
  /** Seconds of invulnerability after a hit. */
  hurtCooldown = 0;
  /** Seconds since the last hit (for the HUD flash). */
  sinceHurt = 99;
  /** If true, the inventory is kept on death. Default false. */
  keepInventory = false;
  lastSource: DamageSource | null = null;
  private lastAmount = 0;
  private regenTimer = 0;
  private starveTimer = 0;
  private drownTimer = 0;
  private fireTimer = 0;
  private cactusTimer = 0;
  private lastPos = new THREE.Vector3(NaN, 0, 0);
  private wasOnGround = true;
  private lastStats = '';

  constructor(private readonly game: Game) {
    game.events.on('playerFell', (e) => {
      if (e.damage > 0) this.hurt(e.damage, { kind: 'fall' });
    });
    game.addSystem({ name: 'player-health', update: (dt) => this.update(dt) });
    game.save.register('survival', () => this.serialize(), (d: HealthData) => this.deserialize(d));
  }

  /** True when damage applies (survival mode, alive). */
  get vulnerable(): boolean {
    return this.game.player.mode === 'survival' && !this.dead;
  }

  /**
   * Damages the player. Returns true if any damage was applied. Respects the hurt cooldown:
   * a stronger hit during the cooldown applies only the difference.
   */
  hurt(amount: number, source: PlayerDamageSource): boolean {
    if (!this.vulnerable || amount <= 0) return false;
    let dmg = amount;
    if (this.hurtCooldown > 0) {
      if (amount <= this.lastAmount) return false;
      dmg = amount - this.lastAmount;
    } else this.hurtCooldown = 0.5;
    this.lastAmount = amount;
    this.health = Math.max(0, this.health - dmg);
    this.sinceHurt = 0;
    this.lastSource = source;
    this.exhaust(0.1);
    const p = this.game.player;
    if (source.knockback) {
      p.velocity.x += source.knockback.x;
      p.velocity.y = Math.max(p.velocity.y, source.knockback.y);
      p.velocity.z += source.knockback.z;
    } else if (source.entity) {
      const dx = p.position.x - source.entity.position.x, dz = p.position.z - source.entity.position.z;
      const d = Math.hypot(dx, dz) || 1;
      p.velocity.x += (dx / d) * 6;
      p.velocity.z += (dz / d) * 6;
      p.velocity.y = Math.max(p.velocity.y, 5.5);
    }
    this.game.events.emit('playerHurt', { amount: dmg, health: this.health, source });
    this.emitStats();
    if (this.health <= 0) this.die(source);
    return true;
  }

  /** Restores health (clamped to 20). */
  heal(amount: number): void {
    if (this.dead) return;
    this.health = Math.min(MAX_HEALTH, this.health + amount);
    this.emitStats();
  }

  /** Adds hunger points and saturation (saturation is capped by hunger, like the original). */
  feed(hunger: number, saturation: number): void {
    this.hunger = Math.min(MAX_HUNGER, this.hunger + hunger);
    this.saturation = Math.min(this.hunger, this.saturation + saturation);
    this.emitStats();
  }

  /** Adds exhaustion; every 4 points costs 1 saturation, then 1 hunger. */
  exhaust(amount: number): void {
    if (this.game.player.mode !== 'survival') return;
    this.exhaustion += amount;
    while (this.exhaustion >= 4) {
      this.exhaustion -= 4;
      if (this.saturation > 0) this.saturation = Math.max(0, this.saturation - 1);
      else this.hunger = Math.max(0, this.hunger - 1);
    }
  }

  /** Kills the player immediately (creative players too). */
  kill(cause = 'magic'): void {
    if (this.dead) return;
    this.health = 0;
    this.die({ kind: cause });
  }

  /** Respawns at the spawn point with full stats. */
  respawn(): void {
    this.dead = false;
    this.health = MAX_HEALTH;
    this.hunger = MAX_HUNGER;
    this.saturation = 5;
    this.exhaustion = 0;
    this.air = MAX_AIR;
    this.burning = 0;
    this.hurtCooldown = 0;
    const p = this.game.player;
    p.frozen = false;
    p.respawn();
    this.emitStats();
    this.game.save.markDirty('survival');
  }

  serialize(): HealthData {
    return { health: this.health, hunger: this.hunger, saturation: this.saturation, exhaustion: this.exhaustion, air: this.air };
  }

  deserialize(d: HealthData): void {
    this.health = clamp(d.health ?? MAX_HEALTH, 1, MAX_HEALTH);
    this.hunger = clamp(d.hunger ?? MAX_HUNGER, 0, MAX_HUNGER);
    this.saturation = clamp(d.saturation ?? 5, 0, MAX_HUNGER);
    this.exhaustion = d.exhaustion ?? 0;
    this.air = clamp(d.air ?? MAX_AIR, 0, MAX_AIR);
  }

  private die(source: DamageSource): void {
    if (this.dead) return;
    this.dead = true;
    const game = this.game;
    const p = game.player;
    p.frozen = true;
    p.velocity.set(0, 0, 0);
    const pos = { x: p.position.x, y: p.position.y + 0.6, z: p.position.z };
    if (!this.keepInventory && !game.inventory.infinite) {
      const inv = game.inventory;
      for (let i = 0; i < inv.slots.length; i++) {
        const s = inv.slots[i];
        if (!s) continue;
        dropItem(game, s, pos, { velocity: { x: (Math.random() - 0.5) * 6, y: 3 + Math.random() * 3, z: (Math.random() - 0.5) * 6 }, pickupDelay: 1.5 });
        inv.set(i, null);
      }
    }
    game.events.emit('playerDied', { cause: deathMessage(source), source, x: pos.x, y: p.position.y, z: pos.z });
    this.emitStats();
    game.save.markDirty('survival');
  }

  private update(dt: number): void {
    const game = this.game;
    const p = game.player;
    this.sinceHurt += dt;
    if (this.hurtCooldown > 0) this.hurtCooldown -= dt;
    if (this.dead || p.frozen) {
      this.lastPos.set(NaN, 0, 0);
      return;
    }
    const survival = p.mode === 'survival';
    if (!survival) {
      if (this.health < MAX_HEALTH || this.hunger < MAX_HUNGER || this.air < MAX_AIR) {
        this.health = MAX_HEALTH;
        this.hunger = MAX_HUNGER;
        this.air = MAX_AIR;
        this.emitStats();
      }
      this.burning = 0;
      p.canSprint = true;
      return;
    }

    // Exhaustion from movement and jumping.
    if (!Number.isNaN(this.lastPos.x)) {
      const moved = Math.hypot(p.position.x - this.lastPos.x, p.position.z - this.lastPos.z);
      if (moved < 3) {
        if (p.inWater) this.exhaust(moved * 0.015);
        else if (p.sprinting) this.exhaust(moved * 0.1);
        else this.exhaust(moved * 0.005);
      }
    }
    this.lastPos.copy(p.position);
    if (this.wasOnGround && !p.onGround && p.velocity.y > 5 && !p.inWater) this.exhaust(p.sprinting ? 0.2 : 0.05);
    this.wasOnGround = p.onGround;
    p.canSprint = this.hunger > 6;

    // Natural regeneration and starvation.
    if (this.hunger >= 18 && this.health < MAX_HEALTH) {
      this.regenTimer += dt;
      const interval = this.hunger >= 20 && this.saturation > 0 ? 0.5 : 4;
      if (this.regenTimer >= interval) {
        this.regenTimer = 0;
        this.heal(1);
        this.exhaust(interval < 1 ? 1.5 : 6);
      }
    } else this.regenTimer = 0;
    if (this.hunger <= 0) {
      this.starveTimer += dt;
      if (this.starveTimer >= 4) {
        this.starveTimer = 0;
        if (this.health > 1) this.hurt(1, { kind: 'starve' });
      }
    } else this.starveTimer = 0;

    // Drowning.
    const eye = p.eye(tmpEye);
    const headBlock = game.world.getBlock(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z));
    if (headBlock === BLOCK.water) {
      this.air = Math.max(0, this.air - dt);
      if (this.air <= 0) {
        this.drownTimer += dt;
        if (this.drownTimer >= 1) {
          this.drownTimer = 0;
          this.hurtCooldown = 0;
          this.hurt(2, { kind: 'drown' });
        }
      }
    } else {
      this.air = Math.min(MAX_AIR, this.air + dt * 6);
      this.drownTimer = 0;
    }

    // Lava and fire.
    if (p.inLava) {
      this.burning = 8;
      this.hurt(4, { kind: 'lava' });
    }
    if (p.inWater || game.weather.intensity > 0.6) this.burning = Math.min(this.burning, p.inWater ? 0 : this.burning - dt * 2);
    if (this.burning > 0) {
      this.burning -= dt;
      this.fireTimer += dt;
      if (this.fireTimer >= 1) {
        this.fireTimer = 0;
        if (!p.inLava) this.hurt(1, { kind: 'fire' });
      }
    } else this.fireTimer = 0;

    // Cactus contact.
    this.cactusTimer -= dt;
    if (this.cactusTimer <= 0 && this.touching(BLOCK.cactus)) {
      this.cactusTimer = 0.5;
      this.hurtCooldown = 0;
      this.hurt(1, { kind: 'cactus' });
    }

    this.emitStats();
  }

  private touching(id: number): boolean {
    const p = this.game.player;
    const hw = p.width / 2 + 0.06;
    const x0 = Math.floor(p.position.x - hw), x1 = Math.floor(p.position.x + hw);
    const z0 = Math.floor(p.position.z - hw), z1 = Math.floor(p.position.z + hw);
    const y0 = Math.floor(p.position.y - 0.05), y1 = Math.floor(p.position.y + p.height - 0.1);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) if (this.game.world.getBlock(x, y, z) === id) return true;
    return false;
  }

  private emitStats(): void {
    const key = `${this.health}|${this.hunger}|${Math.ceil(this.air)}|${Math.round(this.saturation)}`;
    if (key === this.lastStats) return;
    this.lastStats = key;
    this.game.events.emit('playerStatsChanged', { health: this.health, hunger: this.hunger, saturation: this.saturation, air: this.air });
    this.game.save.markDirty('survival');
  }
}

/** A short, human-readable cause of death. */
export function deathMessage(s: DamageSource): string {
  const who = s.entity ? (s.entity.type.replace(/_/g, ' ')) : '';
  switch (s.kind) {
    case 'melee':
      return who ? `Slain by a ${who}` : 'Slain';
    case 'arrow':
      return who ? `Shot by a ${who}` : 'Shot by an arrow';
    case 'explosion':
      return who ? `Blown up by a ${who}` : 'Blew up';
    case 'fall':
      return 'Hit the ground too hard';
    case 'lava':
      return 'Tried to swim in lava';
    case 'fire':
      return 'Burned to death';
    case 'drown':
      return 'Drowned';
    case 'starve':
      return 'Starved to death';
    case 'cactus':
      return 'Was pricked to death';
    case 'void':
      return 'Fell out of the world';
    default:
      return 'Died';
  }
}

function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

const tmpEye = new THREE.Vector3();

/** The player's health service (created on first use). */
export const getHealth = service((game) => new PlayerHealth(game));

/** Damages the player (survival only). Returns true if damage was applied. */
export function hurtPlayer(game: Game, amount: number, source: PlayerDamageSource): boolean {
  return getHealth(game).hurt(amount, source);
}

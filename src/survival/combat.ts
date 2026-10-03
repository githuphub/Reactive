/**
 * Player combat and item use: melee (damage by item, attack-strength cooldown, falling crits,
 * sprint knockback), bow (hold RMB to draw, release to shoot a physical arrow), eating (hold
 * RMB with food) and dropping items (Q, Ctrl+Q for the whole stack).
 */
import * as THREE from 'three';
import { findItem } from '../engine/items';
import type { Game } from '../game/game';
import type { PlayerAttackEvent } from '../game/events';
import { KEYS } from '../player/input';
import { Mob } from '../mobs/mob';
import { shootArrow } from '../mobs/projectile';
import { getHealth } from './health';
import { throwFromPlayer } from './inventory-api';
import { getParticles } from './particles';
import { service } from './service';

const EAT_TIME = 1.6;
const BOW_FULL = 1.0;

export class Combat {
  /** 0..1 attack strength (recharges after each swing). */
  attackStrength = 1;
  /** 0..1 bow draw while RMB is held with a bow. */
  bowCharge = 0;
  /** 0..1 eating progress. */
  eatProgress = 0;
  private time = 0;
  private lastAttack = -10;
  private cooldown = 0.5;
  private drawing = 0;
  private eating = 0;
  private chewTimer = 0;

  constructor(private readonly game: Game) {
    game.events.on('playerAttack', (e) => this.melee(e));
    game.addSystem({ name: 'player-combat', update: (dt) => this.update(dt) });
  }

  private melee(e: PlayerAttackEvent): void {
    if (e.handled) return;
    e.handled = true;
    const game = this.game;
    const p = game.player;
    const tool = e.item ? findItem(e.item.item)?.tool ?? null : null;
    const cooldown = tool?.kind === 'sword' ? 0.625 : tool?.kind === 'axe' ? 1 : tool && tool.kind !== 'none' ? 0.8 : 0.4;
    const strength = Math.max(0.2, Math.min(1, (this.time - this.lastAttack) / this.cooldown));
    this.lastAttack = this.time;
    this.cooldown = cooldown;
    const base = tool && tool.kind !== 'none' ? tool.damage : 1;
    const crit = strength > 0.9 && !p.onGround && p.velocity.y < 0 && !p.inWater && !p.onLadder && !p.flying;
    let dmg = base * (0.2 + 0.8 * strength * strength);
    if (crit) dmg *= 1.5;
    const amount = Math.max(1, Math.round(dmg));
    const ent = e.entity;
    const ok = ent.hurt(amount, { kind: 'melee', player: true, item: e.item });
    if (!ok) return;
    const dx = ent.position.x - p.position.x, dz = ent.position.z - p.position.z;
    const d = Math.hypot(dx, dz) || 1;
    if (!(ent instanceof Mob)) {
      ent.velocity.x += (dx / d) * 5;
      ent.velocity.z += (dz / d) * 5;
      ent.velocity.y = Math.max(ent.velocity.y, 4);
    }
    if (p.sprinting && strength > 0.9) {
      ent.velocity.x += (dx / d) * 4;
      ent.velocity.z += (dz / d) * 4;
      p.sprinting = false;
    }
    if (crit) {
      getParticles(game).burst({ x: ent.position.x, y: ent.position.y + ent.height * 0.7, z: ent.position.z, count: 12, color: ['#ffffff', '#fff2a8', '#ffd84a'], speed: 3, up: 1, gravity: 4, size: 0.07, life: 0.45, spread: ent.width / 2 });
    }
    getHealth(game).exhaust(0.1);
    if (tool && tool.kind !== 'none') game.inventory.damageSelected(tool.kind === 'sword' ? 1 : 2);
  }

  private update(dt: number): void {
    this.time += dt;
    this.attackStrength = Math.min(1, (this.time - this.lastAttack) / this.cooldown);
    const game = this.game;
    const p = game.player;
    const input = game.input;
    const blocked = p.frozen || game.ui.screens.isOpen || getHealth(game).dead;
    const stack = game.inventory.selectedStack;
    const def = stack ? findItem(stack.item) : undefined;
    const rmb = !blocked && input.isButtonDown(2);

    // Bow.
    if (stack?.item === 'bow' && !blocked) {
      const hasArrow = game.inventory.infinite || p.mode === 'creative' || game.inventory.count('arrow') > 0;
      if (rmb && hasArrow) this.drawing += dt;
      else if (this.drawing > 0) {
        if (this.drawing >= 0.15 && hasArrow) this.shoot(this.drawing);
        this.drawing = 0;
      }
    } else this.drawing = 0;
    this.bowCharge = Math.min(1, this.drawing / BOW_FULL);

    // Eating.
    const food = def?.food;
    if (food && rmb && (getHealth(game).hunger < 20 || p.mode === 'creative')) {
      this.eating += dt;
      this.chewTimer -= dt;
      if (this.chewTimer <= 0) {
        this.chewTimer = 0.22;
        game.interaction.onSwing?.();
        const eye = p.eye(tmpEye);
        const dir = p.lookDir(tmpDir);
        getParticles(game).burst({ x: eye.x + dir.x * 0.5, y: eye.y - 0.25, z: eye.z + dir.z * 0.5, count: 3, color: foodColors(stack!.item), speed: 1.2, up: 0.5, gravity: 10, size: 0.05, life: 0.4, spread: 0.08 });
      }
      if (this.eating >= EAT_TIME) {
        this.eating = 0;
        getHealth(game).feed(food.hunger, food.saturation);
        game.inventory.consumeSelected(1);
        game.events.emit('playerAte', { item: stack!.item, hunger: food.hunger, saturation: food.saturation });
      }
    } else this.eating = 0;
    this.eatProgress = Math.min(1, this.eating / EAT_TIME);

    // Drop (Q).
    if (!blocked && input.wasPressed(KEYS.drop) && stack) {
      const all = input.isDown('ControlLeft') || input.isDown('ControlRight');
      const n = all ? stack.count : 1;
      throwFromPlayer(game, { ...stack, count: n });
      game.inventory.consumeSelected(n);
      game.interaction.onSwing?.();
    }
  }

  private shoot(drawn: number): void {
    const game = this.game;
    const p = game.player;
    const c = Math.min(1, drawn / BOW_FULL);
    const f = (c * c + 2 * c) / 3;
    const speed = 54 * f;
    const damage = Math.max(1, Math.round(6 * f));
    const eye = p.eye(tmpEye);
    const dir = p.lookDir(tmpDir);
    const from = { x: eye.x + dir.x * 0.3, y: eye.y - 0.1 + dir.y * 0.3, z: eye.z + dir.z * 0.3 };
    const bow = game.inventory.selectedStack;
    shootArrow(game, {
      from,
      velocity: { x: dir.x * speed + p.velocity.x * 0.5, y: dir.y * speed, z: dir.z * speed + p.velocity.z * 0.5 },
      damage,
      shooter: 'player',
      crit: c >= 1,
      pickup: !game.inventory.infinite,
      item: bow,
    });
    if (!game.inventory.infinite) game.inventory.remove('arrow', 1);
    game.inventory.damageSelected(1);
    game.interaction.onSwing?.();
    game.events.emit('playerShotBow', { charge: c, damage, target: game.interaction.targetEntity });
  }
}

function foodColors(item: string): string[] {
  if (item.includes('beef') || item.includes('porkchop') || item === 'rotten_flesh') return item.startsWith('cooked') ? ['#8a5a2a', '#c48850'] : ['#c83a32', '#e88a8a'];
  if (item === 'apple') return ['#d82a22', '#ff7a6a'];
  return ['#c98a3a', '#e8b86a'];
}

const tmpEye = new THREE.Vector3();
const tmpDir = new THREE.Vector3();

/** The player's combat/use controller (created on first use). */
export const getCombat = service((game) => new Combat(game));

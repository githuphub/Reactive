/**
 * Player buffs from forged things: passive effects of the held item, worn wearables and armour-set bonuses, plus
 * timed effects from food. Also the damage filter (armour points reduce damage, fire resistance ignores fire).
 *
 * - speed: +40 % ground speed (an extra collision-checked move each frame);
 * - jump: higher jumps;
 * - glow: a warm light around the player (lights entity models) and sparkles;
 * - night_vision: the sky-lit world stays bright at night;
 * - fire_resist: no fire / lava damage, flames go out;
 * - heal_aura (timed or worn): +1 health every 2 s.
 */
import * as THREE from 'three';
import type { ThingEffect } from '@liveforge/sdk';
import type { Game } from '../../game/game';
import { moveBody, type Body } from '../../engine/physics';
import { getHealth, getParticles } from '../../survival';
import type { PlayerDamageSource } from '../../survival/health';
import { thingEffect } from './things';

export type BuffEffect = ThingEffect | 'fire_resist';

const PASSIVE = new Set<BuffEffect>(['speed', 'jump', 'glow', 'night_vision', 'fire_resist', 'heal_aura']);

export class Buffs {
  /** Extra sources of active effects (wearables, set bonuses). */
  private readonly providers: (() => Iterable<BuffEffect>)[] = [];
  /** Armour points from worn things. */
  armor: () => number = () => 0;
  private readonly timed = new Map<BuffEffect, number>();
  private active = new Set<BuffEffect>();
  private readonly light = new THREE.PointLight(0xffd890, 0, 9, 1.4);
  private wasGround = false;
  private healAcc = 0;
  private sparkle = 0;
  private time = 0;
  private readonly proxy: Body;
  private readonly vel = new THREE.Vector3();

  constructor(private readonly game: Game) {
    const p = game.player;
    this.proxy = { position: p.position, velocity: this.vel, width: p.width, height: p.height, onGround: false, inWater: false, inLava: false, onLadder: false, collidedHorizontally: false, fallDistance: 0 };
    this.light.visible = false;
    game.scene.add(this.light);
    game.addSystem({ name: 'forge-buffs', update: (dt) => this.update(dt) });
    // night vision: lift the daylight uniform right before rendering (after the game set it for the frame)
    const prev = game.scene.onBeforeRender;
    game.scene.onBeforeRender = (...args) => {
      prev.apply(game.scene, args);
      if (this.active.has('night_vision')) {
        const u = game.materials.uniforms.uDaylight;
        u.value = Math.max(u.value, 0.85);
      }
    };
    // armour and fire resistance: filter damage before it lands
    const health = getHealth(game);
    const hurt = health.hurt.bind(health);
    health.hurt = (amount: number, source: PlayerDamageSource) => {
      if (this.has('fire_resist') && (source.kind === 'fire' || source.kind === 'lava')) {
        health.burning = 0;
        return false;
      }
      const armor = this.armor();
      const reduce = Math.min(0.8, armor * 0.04);
      const skip = source.kind === 'starve' || source.kind === 'drown' || source.kind === 'void';
      return hurt(skip || reduce <= 0 ? amount : Math.max(0.5, amount * (1 - reduce)), source);
    };
  }

  /** Adds a source of passive effects (called every frame). */
  addProvider(fn: () => Iterable<BuffEffect>): void {
    this.providers.push(fn);
  }

  /** Grants an effect for `seconds` (food, potions). Instant effects (heal) are applied right away. */
  grant(effect: BuffEffect, seconds = 30): void {
    if (effect === 'none') return;
    if (effect === 'heal_aura') {
      getHealth(this.game).heal(6);
      const p = this.game.player.position;
      getParticles(this.game).burst({ x: p.x, y: p.y + 1, z: p.z, count: 14, color: ['#7dff8a', '#c8ffd0', '#ff6a8a'], speed: 1, up: 1.4 });
      return;
    }
    if (!PASSIVE.has(effect)) return;
    this.timed.set(effect, this.time + seconds);
  }

  /** True while an effect is active. */
  has(effect: BuffEffect): boolean {
    return this.active.has(effect);
  }

  /** Active effects (for HUDs). */
  list(): BuffEffect[] {
    return [...this.active];
  }

  private update(dt: number): void {
    this.time += dt;
    const game = this.game;
    const next = new Set<BuffEffect>();
    const held = thingEffect(game.inventory.selectedStack?.item);
    if (held && PASSIVE.has(held.effect) && held.effect !== 'heal_aura') next.add(held.effect);
    for (const fn of this.providers) for (const e of fn()) if (PASSIVE.has(e)) next.add(e);
    for (const [e, until] of this.timed) {
      if (until > this.time) next.add(e);
      else this.timed.delete(e);
    }
    this.active = next;
    const p = game.player;
    if (p.frozen) return;

    if (next.has('speed') && !p.flying) {
      // an extra collision-checked step along the current ground velocity
      this.vel.set(p.velocity.x * 0.4, 0, p.velocity.z * 0.4);
      if (this.vel.lengthSq() > 0.01) moveBody(game.world, this.proxy, dt);
    }
    if (next.has('jump') && this.wasGround && !p.onGround && p.velocity.y > 7) p.velocity.y *= 1.32;
    this.wasGround = p.onGround;

    const glow = next.has('glow');
    this.light.visible = glow;
    if (glow) {
      this.light.intensity = 2.2;
      this.light.position.set(p.position.x, p.position.y + 1.4, p.position.z);
      this.sparkle -= dt;
      if (this.sparkle <= 0) {
        this.sparkle = 0.25;
        getParticles(game).burst({ x: p.position.x, y: p.position.y + 1, z: p.position.z, count: 2, color: ['#fff2a8', '#ffd84a'], speed: 0.4, up: 0.6, gravity: -0.5, size: 0.05, life: 0.8, spread: 0.6 });
      }
    }
    if (next.has('fire_resist')) getHealth(game).burning = 0;
    if (next.has('heal_aura')) {
      this.healAcc += dt;
      if (this.healAcc > 2) {
        this.healAcc = 0;
        getHealth(game).heal(1);
      }
    }
  }
}

let buffs: Buffs | null = null;

/** The buffs service (created by the forge at init). */
export function getBuffs(game: Game): Buffs {
  return (buffs ??= new Buffs(game));
}

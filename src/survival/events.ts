/**
 * Survival + mob events, merged into the core `GameEvents` map with TypeScript declaration
 * merging, so `game.events.on('mobKilled', …)` is fully typed without editing game/events.ts.
 *
 * V3 forwards these to Liveforge as signals (combat, items, play style).
 */
import type { DamageSource, Entity } from '../engine/entity';
import type { ItemStack } from '../engine/items';

/** Why the player took damage (`source.kind`): melee, arrow, explosion, fall, lava, fire, drown, starve, cactus, void, magic. */
export interface PlayerHurtEvent {
  amount: number;
  /** Health after the hit (0..20). */
  health: number;
  source: DamageSource;
}

export interface MobKilledEvent {
  /** The mob entity (a `Mob`, see mobs/mob.ts). */
  mob: Entity;
  /** Mob type, e.g. 'zombie', 'baby_zombie'. */
  type: string;
  /** True when the player dealt the killing blow (melee or own arrow). */
  byPlayer: boolean;
  source: DamageSource;
  /** Raid tactic the mob was using, if any. */
  tactic: string | null;
}

export interface MobSpawnedEvent {
  mob: Entity;
  type: string;
  /** 'natural' (spawn rules), 'director' (waves / spawnMob), or a custom tag. */
  reason: string;
  tactic: string | null;
}

declare module '../game/events' {
  interface GameEvents {
    /** The player lost health (survival only). */
    playerHurt: PlayerHurtEvent;
    /** Health or hunger changed (for HUDs). */
    playerStatsChanged: { health: number; hunger: number; saturation: number; air: number };
    /** Health reached 0. Items are dropped where the player died. */
    playerDied: { cause: string; source: DamageSource; x: number; y: number; z: number };
    /** The player finished eating. */
    playerAte: { item: string; hunger: number; saturation: number };
    /** The player released a drawn bow. `charge` is 0..1; `target` is the entity under the crosshair, if any. */
    playerShotBow: { charge: number; damage: number; target: Entity | null };
    /** A crafting output was taken. `station` is 'inventory' (2×2) or 'crafting_table' (3×3). */
    itemCrafted: { item: string; count: number; recipe: string; station: 'inventory' | 'crafting_table' };
    /** A furnace finished one item. */
    itemSmelted: { input: string; item: string; count: number; x: number; y: number; z: number };
    /** The player picked up an item entity. */
    itemPickedUp: { item: string; count: number };
    /** A mob died. */
    mobKilled: MobKilledEvent;
    /** A mob was spawned (naturally or by the director / spawnMob). */
    mobSpawned: MobSpawnedEvent;
    /** Something exploded (creeper, TNT, liveforge effect). */
    explosion: { x: number; y: number; z: number; radius: number; source: string; blocks: number };
    /** Play-style detector: the player stands on a 1×1 column they built, at least 4 high. */
    pillared: { height: number; x: number; y: number; z: number };
    /** Play-style detector: the player is enclosed underground at night. */
    hid: { depth: number; x: number; y: number; z: number };
  }
}

/** A stack plus where it lies (for drop helpers). */
export interface DroppedStack {
  stack: ItemStack;
  x: number;
  y: number;
  z: number;
}

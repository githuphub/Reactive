/**
 * Typed game events. Every system (V1 survival, V2 villages, V3 Reactive) subscribes through
 * `game.events.on(name, handler)` instead of patching the core.
 */
import type { ItemStack } from '../engine/items';
import type { BiomeName } from '../world/biomes';
import type { DamageSource, Entity } from '../engine/entity';

/** Who/what changed a block. Free-form strings are allowed for new systems. */
export type BlockSource =
  | 'player' | 'entity' | 'explosion' | 'fluid' | 'support' | 'gen' | 'village' | 'liveforge' | 'system' | (string & {});

export type DayPhase = 'dawn' | 'day' | 'dusk' | 'night';
export type Weather = 'clear' | 'rain' | 'storm' | 'snow';
export type GameMode = 'survival' | 'creative';

/** Fired for every block change made after generation (including fluids and support breaks). */
export interface BlockChangedEvent {
  x: number; y: number; z: number;
  id: number; meta: number;
  prevId: number; prevMeta: number;
  source: BlockSource;
}

/**
 * Fired when a non-air block becomes air (or a liquid). `drops` were rolled already; a system that
 * spawns item entities should set `dropsHandled = true`, otherwise the player's inventory receives
 * them (when the player broke it in survival).
 */
export interface BlockBrokenEvent {
  x: number; y: number; z: number;
  id: number; meta: number;
  source: BlockSource;
  /** Tool used (player or entity), if any. */
  tool: ItemStack | null;
  drops: ItemStack[];
  dropsHandled: boolean;
  /** The entity responsible when source is 'entity'. */
  entity?: Entity;
}

export interface BlockPlacedEvent {
  x: number; y: number; z: number;
  id: number; meta: number;
  prevId: number;
  source: BlockSource;
  entity?: Entity;
}

/** Right-click on a block. Set `handled = true` to stop the default (placing / door toggling). */
export interface BlockInteractEvent {
  x: number; y: number; z: number;
  id: number; meta: number;
  item: ItemStack | null;
  sneaking: boolean;
  handled: boolean;
}

export interface PlayerMovedEvent {
  /** Feet position. */
  x: number; y: number; z: number;
  /** Block coordinates. */
  bx: number; by: number; bz: number;
  cx: number; cz: number;
  biome: BiomeName;
}

export interface TimeChangedEvent {
  /** 0..1 where 0 = sunrise, 0.25 = noon, 0.5 = sunset, 0.75 = midnight. */
  time: number;
  /** Day counter starting at 0. */
  day: number;
  phase: DayPhase;
  /** 0..1 sky brightness. */
  daylight: number;
}

export interface PlayerAttackEvent {
  entity: Entity;
  item: ItemStack | null;
  handled: boolean;
}

export interface EntityInteractEvent {
  entity: Entity;
  item: ItemStack | null;
  sneaking: boolean;
  handled: boolean;
}

export interface GameEvents {
  blockChanged: BlockChangedEvent;
  blockBroken: BlockBrokenEvent;
  blockPlaced: BlockPlacedEvent;
  blockInteract: BlockInteractEvent;
  /** Throttled: fires when the player's block position changes. */
  playerMoved: PlayerMovedEvent;
  playerChunkChanged: { cx: number; cz: number; prevCx: number; prevCz: number };
  /** Landing after a fall; V1 applies damage (`damage` = distance - 3, already floored at 0). */
  playerFell: { distance: number; damage: number };
  playerRespawned: { x: number; y: number; z: number };
  /** Fires about once per real second and on every phase change. */
  timeChanged: TimeChangedEvent;
  phaseChanged: { phase: DayPhase; prev: DayPhase; day: number };
  weatherChanged: { weather: Weather; prev: Weather };
  gameModeChanged: { mode: GameMode };
  chunkLoaded: { cx: number; cz: number };
  chunkUnloaded: { cx: number; cz: number };
  hotbarChanged: { slot: number; stack: ItemStack | null };
  inventoryChanged: Record<string, never>;
  /** Left click on an entity (melee). */
  playerAttack: PlayerAttackEvent;
  /** Right click on an entity (trade, talk, ...). */
  entityInteract: EntityInteractEvent;
  entityAdded: { entity: Entity };
  entityRemoved: { entity: Entity };
  /** An entity took damage (see Entity.hurt). */
  entityHurt: { entity: Entity; amount: number; source: DamageSource };
  entityDied: { entity: Entity; source: DamageSource };
  /** Every simulated frame (not while paused). */
  tick: { dt: number; elapsed: number };
  /** Spawn area meshed and the player can play. */
  ready: Record<string, never>;
  paused: Record<string, never>;
  resumed: Record<string, never>;
  settingsChanged: { key: string };
}

type Handler<T> = (ev: T) => void;

/** Small typed event emitter. Handlers run synchronously in subscription order. */
export class EventBus<E extends object> {
  private readonly map = new Map<keyof E, Set<Handler<never>>>();

  /** Subscribes; returns an unsubscribe function. */
  on<K extends keyof E>(type: K, handler: Handler<E[K]>): () => void {
    let set = this.map.get(type);
    if (!set) {
      set = new Set();
      this.map.set(type, set);
    }
    set.add(handler as Handler<never>);
    return () => this.off(type, handler);
  }

  once<K extends keyof E>(type: K, handler: Handler<E[K]>): () => void {
    const off = this.on(type, (ev) => {
      off();
      handler(ev);
    });
    return off;
  }

  off<K extends keyof E>(type: K, handler: Handler<E[K]>): void {
    this.map.get(type)?.delete(handler as Handler<never>);
  }

  emit<K extends keyof E>(type: K, ev: E[K]): void {
    const set = this.map.get(type);
    if (!set) return;
    for (const h of [...set]) {
      try {
        (h as Handler<E[K]>)(ev);
      } catch (err) {
        console.error(`[events] handler for "${String(type)}" threw`, err);
      }
    }
  }

  /** True if anyone listens (lets hot paths skip building payloads). */
  has<K extends keyof E>(type: K): boolean {
    return (this.map.get(type)?.size ?? 0) > 0;
  }
}

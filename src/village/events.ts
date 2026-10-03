/**
 * Village events, added to the core `GameEvents` map by module augmentation, so
 * `game.events.on('traded', ...)` is fully typed without touching V0's events.ts.
 */
import type { Posture } from './npc/npc';

export interface TradedEvent {
  /** Villager id. */
  npc: string;
  item: string;
  count: number;
  /** Coins paid (kind 'buy': the player bought) or received (kind 'sell': the player sold). */
  price: number;
  kind: 'buy' | 'sell';
  /** Price multiplier in force. */
  multiplier: number;
}

export interface HaggledEvent {
  npc: string;
  accepted: boolean;
  /** Multiplier after the haggle. */
  multiplier: number;
  line?: string;
}

export interface VillagerActionEvent {
  npc: string;
  action: string;
  ok: boolean;
  detail: string;
}

declare module '../game/events' {
  interface GameEvents {
    /** A trade went through in the trade screen. */
    traded: TradedEvent;
    /** The haggle button was used. */
    haggled: HaggledEvent;
    /** An agent-priority controller action finished (for logs / Brain View). */
    villagerAction: VillagerActionEvent;
    /** `village.setPosture` changed the posture. */
    villagePosture: { posture: Posture; prev: Posture };
    /** The player chose Talk in a villager's menu. */
    villagerTalk: { npc: string };
    /** The golem started or stopped confronting the player. */
    golemConfront: { active: boolean; reason: string };
    /** The player damaged a village building (block broken inside an owned region). */
    villageDamaged: { buildingId: string; owner: string; x: number; y: number; z: number; block: string };
  }
}

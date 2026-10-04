/**
 * Lane WB game events, merged into the core `GameEvents` map by declaration merging (like survival/events.ts).
 *
 * - `npcReplied` is emitted by liveforge/talk.ts after a villager answers (journal memories).
 * - The rest are emitted by this lane so other code (journal, achievements) can react.
 */
import type { Achievement } from '@liveforge/sdk';

/** A rumour hop: `from` told `to`, possibly in new words. */
export interface RumourSpreadEvent {
  rumourId: string;
  from: string | null;
  to: string;
  content: string;
  /** The wording before this hop, when it changed. */
  previous: string | null;
  /** True when this hop changed the wording. */
  mutated: boolean;
  source: 'server' | 'local';
}

declare module '../../game/events' {
  interface GameEvents {
    /** A villager answered the player in chat (manifest npc id). */
    npcReplied: { npc: string; said: string; text: string; mood: number | null };
    /** A rumour reached a new villager. */
    rumourSpread: RumourSpreadEvent;
    /** A new rumour formed. */
    rumourCreated: { rumourId: string; content: string; origin: string | null; source: 'server' | 'local' };
    /** An achievement was unlocked (server or local list). */
    achievementUnlocked: { achievement: Achievement; source: 'server' | 'local' };
    /** A villager got a makeover (forge.npc_look or the local looks table). */
    npcMakeover: { npc: string; reason: string; summary: string };
    /** A quest chain moved on (step = the quest now offered, 1-based). */
    questChainAdvanced: { chain: string; giver: string; step: number; of: number; title: string };
  }
}

export {};

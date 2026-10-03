/**
 * Shared state of the Liveforge integration (set up once by the plugin): the game, the service, the habit tally,
 * the player's nickname and the UI hooks other modules call (captions, Brain View, chat log).
 */
import type { Game } from '../game/game';
import type { LiveforgeService } from './service';
import type { HabitTally } from './signals';

export interface LfHub {
  game: Game;
  lf: LiveforgeService;
  habits: HabitTally;
  /** Nickname the village coined (deed_nicknames), else null. */
  nickname: string | null;
  /** Shows a one-line caption (Demo captions); no-op until the demo UI mounts. */
  caption(text: string, seconds?: number): void;
  /** Appends a line to the open chat log (npc lines from directives). */
  chatLine(npc: string, text: string): void;
}

let hub: LfHub | null = null;

/** @internal */
export function setHub(h: LfHub): void {
  hub = h;
}

/** The integration state (throws before the plugin ran). */
export function getHub(): LfHub {
  if (!hub) throw new Error('Liveforge hub not ready');
  return hub;
}

/** The player's name for prompts and statues: the village nickname if any, else the configured name. */
export function playerTitle(): string {
  return hub?.nickname ?? hub?.lf.settings.playerName ?? 'Traveller';
}

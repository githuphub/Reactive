/**
 * Map reset: wipes this seed's save (blocks, player, inventory, forged things, placed stuff), starts a fresh
 * Liveforge world so villagers forget too, then reloads. `newSeed` also rolls a random seed.
 */
import type { Game } from './game';

export interface ResetOptions {
  /** Roll a new random seed (a different map) instead of regenerating the same one. */
  newSeed?: boolean;
}

export async function resetMap(game: Game, opts: ResetOptions = {}): Promise<void> {
  game.ui.toast(opts.newSeed ? 'Creating a new world…' : 'Resetting the map…', { seconds: 5 });
  await game.save.wipe();
  const url = new URL(location.href);
  url.searchParams.delete('fresh');
  url.searchParams.delete('lfworld');
  let seed = game.seedText;
  if (opts.newSeed) {
    seed = Math.random().toString(36).slice(2, 10);
    url.searchParams.set('seed', seed);
  }
  try {
    // a fresh Liveforge world id, so memories, rumours and quests start over with the map
    const base = `lc-${seed.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'world'}`;
    localStorage.setItem(`lc.lf.world.${seed}`, `${base}-r${Date.now().toString(36).slice(-5)}`);
  } catch {
    /* no storage: the server world id stays the same */
  }
  location.replace(url.toString());
}

/** Asks first, then resets. */
export function confirmResetMap(game: Game, opts: ResetOptions = {}): void {
  const what = opts.newSeed ? 'Start a NEW random world?' : 'Reset this map?';
  if (window.confirm(`${what}\n\nAll your building, inventory, forged items and village memories in this world will be erased.`)) void resetMap(game, opts);
}

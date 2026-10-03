/**
 * Per-game singletons created on first use. Lets modules expose `getX(game)` accessors without a
 * global, and without depending on plugin init order.
 */
import type { Game } from '../game/game';

/** Wraps a factory so each game gets exactly one instance, created lazily. */
export function service<T>(create: (game: Game) => T): (game: Game) => T {
  const map = new WeakMap<Game, T>();
  return (game) => {
    let v = map.get(game);
    if (v === undefined) {
      v = create(game);
      map.set(game, v);
    }
    return v;
  };
}

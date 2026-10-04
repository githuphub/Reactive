/**
 * Plugin discovery. Any `src/<folder>/plugin.ts` whose default export is a {@link GamePlugin}
 * is loaded automatically (V1: `mobs/plugin.ts`, V2: `village/plugin.ts`, V3:
 * `liveforge/plugin.ts`) — no shared file needs editing.
 */
import type { Game } from './game';

export interface GamePlugin {
  /** Unique name for logs. */
  name: string;
  /** Lower runs first. Default 100. */
  order?: number;
  /**
   * Called once after the game is constructed and the save is loaded, before chunks stream in.
   * Register blocks/items, subscribe to events, add systems, mount UI and save slots here.
   */
  init(game: Game): void | Promise<void>;
}

const modules = import.meta.glob<{ default?: GamePlugin }>('../*/plugin.ts', { eager: true });

/** All discovered plugins, sorted by order. */
export function discoverPlugins(): GamePlugin[] {
  return Object.entries(modules)
    .map(([path, m]) => {
      if (!m.default || typeof m.default.init !== 'function') {
        console.warn(`[plugins] ${path} has no default GamePlugin export; skipped`);
        return null;
      }
      return m.default;
    })
    .filter((p): p is GamePlugin => p !== null)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/** Runs every plugin's init; a failing plugin is logged and skipped. */
export async function initPlugins(game: Game): Promise<void> {
  for (const p of discoverPlugins()) {
    try {
      await p.init(game);
      console.info(`[plugins] ${p.name} ready`);
    } catch (err) {
      console.error(`[plugins] ${p.name} failed to init`, err);
    }
  }
}

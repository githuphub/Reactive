/**
 * Mobs plugin: pathfinder, spawn director (natural spawning), projectiles, TNT ignition and the
 * F7 path debug view. URL `?peaceful` turns natural spawning off.
 */
import { BLOCK } from '../engine/blocks';
import type { GamePlugin } from '../game/plugins';
import { PathDebug } from './debug';
import { primeTnt } from './explosion';
import { bindMobsGame } from './index';
import * as mobs from './index';
import { getPathfinder } from './pathfind';
import { getProjectiles } from './projectile';
import { getSpawnDirector } from './spawner';

const plugin: GamePlugin = {
  name: 'mobs',
  order: 20,
  init(game) {
    bindMobsGame(game);
    getPathfinder(game);
    getProjectiles(game);
    const director = getSpawnDirector(game);
    if (new URLSearchParams(location.search).has('peaceful')) director.naturalSpawning = false;

    // Light TNT with flint or a torch.
    game.events.on('blockInteract', (e) => {
      if (e.id !== BLOCK.tnt || !e.item) return;
      if (e.item.item !== 'flint' && e.item.item !== 'torch') return;
      primeTnt(game, e.x, e.y, e.z, 3);
      e.handled = true;
    });

    const debug = new PathDebug(game);
    game.input.onKey((e) => {
      if (e.code !== 'F7' || game.ui.screens.isOpen || !game.ready) return false;
      debug.toggle();
      return true;
    });

    // Console access for demos: `mobs.spawnMob('zombie', game.player.position, { tactic: 'rush' })`.
    (window as unknown as { mobs: typeof mobs }).mobs = mobs;
  },
};

export default plugin;

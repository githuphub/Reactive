/**
 * Survival plugin: items + recipes, health/hunger HUD, item drops for broken blocks, inventory
 * (E), crafting table / furnace / chest screens, combat and item use, creative toggle (G),
 * death + respawn, and the play-style detectors.
 */
import './ui/styles.css';
import './events';
import './items';
import { BLOCK } from '../engine/blocks';
import type { Game } from '../game/game';
import type { GamePlugin } from '../game/plugins';
import { KEYS } from '../player/input';
import { getCombat } from './combat';
import { getContainers } from './containers';
import { PlayStyleDetectors } from './detectors';
import { getHealth } from './health';
import { SurvivalHud, createDeathScreen } from './hud';
import * as api from './index';
import { dropItem, getItemDrops } from './item-drops';
import { getParticles } from './particles';
import { registerBuiltinRecipes } from './recipe-book';
import { ChestScreen, CraftingTableScreen, FurnaceScreen, InventoryScreen } from './ui/screens';

const DROP_SOURCES = new Set(['player', 'support', 'explosion']);

function setupInventoryMode(game: Game): void {
  const inv = game.inventory;
  const survival = game.player.mode === 'survival';
  if (survival && !game.save.has('inventory')) {
    // New survival world: start with empty pockets.
    for (let i = 0; i < inv.slots.length; i++) inv.slots[i] = null;
  }
  inv.infinite = !survival;
  game.events.emit('inventoryChanged', {});
  game.events.emit('hotbarChanged', { slot: inv.selected, stack: inv.selectedStack });
  game.events.on('gameModeChanged', ({ mode }) => {
    inv.infinite = mode === 'creative';
    game.events.emit('inventoryChanged', {});
    game.save.markDirty('inventory');
  });
}

const plugin: GamePlugin = {
  name: 'survival',
  order: 10,
  init(game) {
    registerBuiltinRecipes();
    setupInventoryMode(game);

    // Services (created now so their save slots restore and systems start).
    getParticles(game);
    getItemDrops(game);
    const health = getHealth(game);
    getContainers(game);
    getCombat(game);
    new PlayStyleDetectors(game);

    // HUD.
    const hud = new SurvivalHud(game);
    game.ui.mount('bottom-center', hud.el, { order: 90 });
    const death = createDeathScreen(game);
    game.events.on('playerDied', (e) => {
      death.setCause(e.cause);
      game.ui.screens.closeAll();
      game.ui.screens.open(death);
    });

    // Broken blocks drop item entities.
    game.events.on('blockBroken', (e) => {
      if (e.dropsHandled || !e.drops.length || !DROP_SOURCES.has(e.source)) return;
      if (e.source === 'player' && game.player.mode !== 'survival') return;
      e.dropsHandled = true;
      for (const d of e.drops) {
        dropItem(game, d, { x: e.x + 0.5, y: e.y + 0.25, z: e.z + 0.5 }, {
          velocity: { x: (Math.random() - 0.5) * 2, y: 2.5 + Math.random() * 1.5, z: (Math.random() - 0.5) * 2 },
          pickupDelay: 0.3,
        });
      }
    });

    // Screens.
    const inventory = new InventoryScreen(game);
    const table = new CraftingTableScreen(game);
    const furnace = new FurnaceScreen(game);
    const chest = new ChestScreen(game);
    game.events.on('blockInteract', (e) => {
      if (e.handled || health.dead) return;
      if (e.id === BLOCK.crafting_table) game.ui.screens.open(table);
      else if (e.id === BLOCK.furnace) game.ui.screens.open(furnace.bind(e.x, e.y, e.z));
      else if (e.id === BLOCK.chest) game.ui.screens.open(chest.bind(e.x, e.y, e.z));
      else return;
      e.handled = true;
    });

    game.input.onKey((e) => {
      if (game.ui.screens.isOpen || !game.ready || health.dead) return false;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return false;
      if (e.code === KEYS.inventory && !e.repeat) {
        game.ui.screens.open(inventory);
        return true;
      }
      if (e.code === 'KeyG' && !e.repeat) {
        const next = game.player.mode === 'creative' ? 'survival' : 'creative';
        game.setGameMode(next);
        game.ui.toast(next === 'creative' ? 'Creative mode: fly, instant break, no damage' : 'Survival mode', { kind: 'info' });
        return true;
      }
      return false;
    });

    // Console access for demos and other lanes.
    (window as unknown as { survival: typeof api }).survival = api;
  },
};

export default plugin;

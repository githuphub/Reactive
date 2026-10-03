/**
 * Village plugin (lane V2): registers the coins item, attaches the village to the game, spawns
 * the cast once the world is ready, wires the interaction menu (look at a villager + E, or right
 * click), N to toggle name tags, ownership reactions and the `village` save slot.
 */
import type { GamePlugin } from '../game/plugins';
import { COINS, registerVillageItems } from './items';
import { Npc } from './npc/npc';
import { village, type SavedVillage } from './village';

const plugin: GamePlugin = {
  name: 'village',
  order: 40,
  init(game) {
    registerVillageItems();
    village.attach(game);
    game.addSystem({ name: 'village', update: (dt) => village.update(dt) });
    const loop = () => {
      village.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    let saved: SavedVillage | undefined;
    game.save.register('village', () => village.serialize(), (d: SavedVillage) => {
      saved = d;
      village.restore(d);
    });
    game.save.register('village_coins', () => true, () => {});
    const firstVisit = !game.save.has('village_coins');

    game.events.once('ready', () => {
      village.spawnCast(saved);
      if (firstVisit) {
        game.inventory.add({ item: COINS, count: 12 });
        game.save.markDirty('village_coins');
      }
    });

    game.events.on('blockBroken', (e) => village.handleBlockBroken(e.x, e.y, e.z, e.id, e.source));

    game.events.on('entityInteract', (e) => {
      if (e.handled || !(e.entity instanceof Npc)) return;
      e.handled = true;
      village.openMenu(e.entity);
    });

    game.input.onKey((e) => {
      if (!game.ready || game.ui.screens.isOpen) return false;
      if (e.code === 'KeyE') {
        const t = game.interaction.targetEntity;
        if (t instanceof Npc && !t.removed) {
          village.openMenu(t);
          return true;
        }
      }
      if (e.code === 'KeyN' && !e.repeat) {
        village.setNameTags(!village.bubbles.tagsVisible);
        game.ui.toast(`Name tags ${village.bubbles.tagsVisible ? 'on' : 'off'}`);
        return true;
      }
      return false;
    });

    (window as unknown as { village: typeof village }).village = village;
  },
};

export default plugin;

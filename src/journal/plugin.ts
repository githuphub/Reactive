/**
 * Lane WB plugin (order 60, after the liveforge plugin): the Journal (J) and the living-world systems in
 * src/liveforge/world (rumours + gossip + rumour board, achievements, quest chains, villager makeovers, Hyper3D).
 *
 * Console: `wb` → `{ world, journal, memories }`, e.g. `wb.world.rumours.startDemoRumour()`,
 * `wb.world.makeovers.trigger('mara', 'festive')`, `wb.journal.open('rumours')`.
 */
import type { GamePlugin } from '../game/plugins';
import { maybeLiveforge } from '../liveforge/service';
import { initWorld, type World } from '../liveforge/world';
import { Journal } from './journal';
import { Memories } from './memories';

const plugin: GamePlugin = {
  name: 'journal',
  order: 60,
  init(game) {
    const lf = maybeLiveforge();
    if (!lf) {
      console.warn('[journal] the liveforge plugin did not start; the journal is off');
      return;
    }
    let journal: Journal | null = null;
    const openJournal = (tab?: string) => journal?.open(tab);
    const world: World = initWorld(game, lf, (tab) => openJournal(tab));
    world.openJournal = openJournal;
    const memories = new Memories(game, lf, world.rumours, (npc) => world.makeovers.trigger(npc, 'friend'));
    journal = new Journal(game, lf, world, memories);
    (window as unknown as { wb: unknown }).wb = { world, journal, memories };
  },
};

export default plugin;

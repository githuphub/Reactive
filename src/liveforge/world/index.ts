/**
 * Lane WB "living world" features, set up once by the journal plugin (src/journal/plugin.ts):
 *
 * - `stats`: what the player did (Game events), for offline traits, local achievements and rumours;
 * - `rumours`: rumour book + server sync + local engine + gossip scenes + the rumour board;
 * - `achievements`: local list + batched `achievement.check`, rarity toasts;
 * - `chains` / `objectives`: chained quests (`quest.offer` with the previous quest as context) and dynamic objectives;
 * - `makeovers`: `forge.npc_look` villager looks with blueprint accessories;
 * - `mesh`: Hyper3D GLBs when mesh jobs complete.
 *
 * ```ts
 * import { getWorld } from '../liveforge/world';
 * getWorld().rumours.startDemoRumour();
 * getWorld().makeovers.trigger('mara', 'festive');
 * ```
 */
import type { Game } from '../../game/game';
import { getQuests } from '../quests';
import type { LiveforgeService } from '../service';
import { Achievements } from './achievements/achievements';
import { QuestChains } from './achievements/chains';
import { ObjectiveTracker } from './achievements/objectives';
import { Makeovers } from './makeovers/makeovers';
import { MeshJobs } from './mesh/mesh';
import { Rumours } from './rumours';
import { initStats, type PlayerStats } from './stats';
import './events';

export interface World {
  stats: PlayerStats;
  rumours: Rumours;
  achievements: Achievements;
  chains: QuestChains;
  objectives: ObjectiveTracker;
  makeovers: Makeovers;
  mesh: MeshJobs;
  /** Opens the journal on a tab ('who' | 'they' | 'rumours' | 'achievements' | 'quests'); set by the journal plugin. */
  openJournal: (tab?: string) => void;
}

let world: World | null = null;

/**
 * Creates the WB world systems (after the liveforge plugin). `openJournal(tab)` opens the journal on a tab
 * (right-clicking the rumour board).
 */
export function initWorld(game: Game, lf: LiveforgeService, openJournal: (tab: string) => void): World {
  const stats = initStats(game);
  const rumours = new Rumours(game, lf, openJournal);
  const achievements = new Achievements(game, lf, stats, rumours.book);
  const quests = getQuests();
  const objectives = new ObjectiveTracker(game, quests, stats);
  const makeovers = new Makeovers(game, lf);
  const chains = new QuestChains(game, lf, quests, stats, () => {
    achievements.chainsDone++;
    game.save.markDirty('wb_achievements');
  }, (giver, title) => {
    rumours.engine.helped(giver, title);
    makeovers.trigger(giver, 'helped');
  });
  const mesh = new MeshJobs(game, lf);
  // forged things (Feathered Friend, Storm Chaser): the forge writes a ⚒ Brain entry per item
  lf.client.brain.subscribe((e) => {
    const spec = (e.data as { spec?: { name?: string } } | undefined)?.spec;
    if (spec?.name && /^Forged /.test(e.text)) stats.noteForged(spec.name);
  }, { source: 'forge' });
  world = { stats, rumours, achievements, chains, objectives, makeovers, mesh, openJournal: (tab) => openJournal(tab ?? 'who') };
  return world;
}

/** The WB world systems, or null before the journal plugin ran. */
export function maybeWorld(): World | null {
  return world;
}

/** The WB world systems (throws before init). */
export function getWorld(): World {
  if (!world) throw new Error('WB world not initialised (journal/plugin.ts)');
  return world;
}

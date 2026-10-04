/**
 * Quest chains (lane WB): when a villager's quest completes, the story continues. The game asks
 * `quest.offer {giver, context: {previousQuest, outcome, chain}}` for the follow-up; the server's instant (rules)
 * answer is replaced by its AI upgrade when that lands within a few seconds, and offline (or when the server has
 * nothing) a local template continues the chain. The tracker shows "Mara's Trust 2/3 · <quest>".
 *
 * Chains are 3 quests long and saved in the slot `wb_chains`.
 */
import type { Quest } from '@liveforge/sdk';
import type { Game } from '../../../game/game';
import { getHub } from '../../hub';
import { lfNpcId } from '../../ids';
import type { Quests } from '../../quests';
import type { LiveforgeService } from '../../service';
import { npcLabel, type PlayerStats } from '../stats';
import '../events';

/** One villager's chain. */
export interface QuestChain {
  id: string;
  giver: string;
  title: string;
  /** Quests in order (1-based step = index + 1). */
  quests: { id: string; title: string; status: 'offered' | 'active' | 'done' }[];
  of: number;
  done: boolean;
}

type Draft = Omit<Quest, 'id' | 'giver'>;

const LENGTH = 3;

const TITLES: Record<string, string> = {
  mara: "Mara's Trust", bram: "Bram's Apprentice", hilde: "Hilde's Forge-Friend", pip: "Pip's Secrets", captain_rowan: "Rowan's Watch",
};

const coins = (n: number) => [{ type: 'gold', amount: n, description: `${n} coins` }];

/** Local chain steps per giver (offline, or when the server has nothing to offer). */
const STEPS: Record<string, Draft[]> = {
  mara: [
    { title: 'Bread and Butter', summary: 'Mara needs wheat for the bakery.', objectives: [{ id: 'o1', type: 'gather', target: 'wheat', count: 5, description: 'Gather 5 wheat' }, { id: 'o2', type: 'deliver', target: 'wheat@mara', count: 5, description: 'Bring the wheat to Mara' }], rewards: coins(4), dialogue: { offer: "The wheat won't harvest itself, love. Five sheaves?", accept: 'Bless you.', complete: "Lovely! There's hope for you yet." } },
    { title: 'Mind the Garden', summary: 'Mara wants a little fence round the farm, so nobody tramples it again.', objectives: [{ id: 'o1', type: 'place', target: 'farm', count: 12, description: 'Place 12 blocks around the farm' }, { id: 'o2', type: 'talk', target: 'mara', description: "Tell Mara it's done" }], rewards: coins(6), dialogue: { offer: 'Could you put up a bit of a fence by the fields? Twelve blocks should do.', accept: "Mind the pumpkins.", complete: 'Now THAT is a fence. I could hug you.' } },
    { title: 'A Night by the Fields', summary: 'Something keeps trampling the crops at night. Keep watch.', objectives: [{ id: 'o1', type: 'kill', target: 'zombie', count: 3, description: 'Chase off 3 zombies' }, { id: 'o2', type: 'survive', target: 'night', count: 1, description: 'Keep watch until dawn' }], rewards: [{ type: 'item', id: 'bread', amount: 6, description: '6 bread' }, ...coins(8)], dialogue: { offer: "Will you watch the fields tonight? I'd sleep better.", accept: "I'll leave a lamp on for you.", complete: "You stayed all night? Oakhollow's lucky to have you." } },
  ],
  bram: [
    { title: 'Lay a Foundation', summary: 'Bram wants to see if you can build.', objectives: [{ id: 'o1', type: 'place', target: 'bram_plot', count: 15, description: "Place 15 blocks on Bram's plot" }], rewards: coins(4), dialogue: { offer: 'Show me your hands are good for more than breaking things. Fifteen blocks on my plot.', accept: 'Straight lines, mind.', complete: 'Not bad. Not bad at all.' } },
    { title: 'Timber!', summary: 'The yard is short of logs.', objectives: [{ id: 'o1', type: 'gather', target: 'oak_log', count: 8, description: 'Chop 8 oak logs' }, { id: 'o2', type: 'deliver', target: 'oak_log@bram', count: 8, description: 'Bring them to Bram' }], rewards: coins(6), dialogue: { offer: "I'm out of oak. Eight logs and I'll teach you a trick or two.", accept: 'The forest is east. Mostly.', complete: 'Good timber. Here, take this.' } },
    { title: 'Raise the Roof', summary: 'Build something real on the plot, with or without Bram.', objectives: [{ id: 'o1', type: 'build', target: 'bram_plot', count: 30, description: "Build 30 blocks on Bram's plot (ask Bram to help!)" }], rewards: [{ type: 'item', id: 'glass', amount: 8, description: '8 glass' }, ...coins(10)], dialogue: { offer: "Right, apprentice. Let's build something proper. Thirty blocks. I'll help if you ask.", accept: 'To the plot!', complete: "That's a building. You're a builder now. Don't let it go to your head." } },
  ],
  hilde: [
    { title: 'Coal for the Forge', summary: 'The forge is hungry.', objectives: [{ id: 'o1', type: 'deliver', target: 'coal@hilde', count: 4, description: 'Bring Hilde 4 coal' }], rewards: coins(5), dialogue: { offer: 'Forge is cold. Four coal. Go.', accept: 'Hmph.', complete: 'Hm. Good coal.' } },
    { title: 'Proving Steel', summary: 'Hilde wants to know her blades are used well.', objectives: [{ id: 'o1', type: 'kill', target: 'skeleton', count: 3, description: 'Defeat 3 skeletons' }], rewards: coins(7), dialogue: { offer: 'A blade is only as good as the arm. Three skeletons.', accept: "Don't die. Bad for business.", complete: 'You can swing. Mostly.' } },
    { title: 'Your Own Mark', summary: 'Forge something of your own at the forge.', objectives: [{ id: 'o1', type: 'forge', target: 'any', count: 1, description: 'Forge an item (F)' }], rewards: [{ type: 'item', id: 'iron_ingot', amount: 4, description: '4 iron ingots' }, ...coins(8)], dialogue: { offer: 'Time you made something. Use the forge.', accept: 'Make it ugly, at least make it yours.', complete: "...That's actually good. Don't tell anyone I said so." } },
  ],
  pip: [
    { title: 'Gather the Whispers', summary: 'Pip wants the latest news from Mara and the Captain.', objectives: [{ id: 'o1', type: 'talk', target: 'mara', description: 'Chat with Mara' }, { id: 'o2', type: 'talk', target: 'captain_rowan', description: 'Chat with Captain Rowan' }], rewards: coins(3), dialogue: { offer: "I need NEWS. Talk to Mara and the Captain and tell me everything. In confidence.", accept: 'Ooh!', complete: 'Fascinating. Simply fascinating.' } },
    { title: 'The Quiet Shelves', summary: 'Visit the library at night and see if the rumours are true.', objectives: [{ id: 'o1', type: 'explore', target: 'library', description: 'Visit the library' }, { id: 'o2', type: 'survive', target: 'night', count: 1, description: 'See the night through' }], rewards: coins(5), dialogue: { offer: 'They say the library whispers at night. Will you check? For science.', accept: 'Bring a torch!', complete: "So it IS the wind. Pity. Don't tell anyone." } },
    { title: 'Write It Down', summary: 'Pip wants your story for the village chronicle.', objectives: [{ id: 'o1', type: 'talk', target: 'pip', description: 'Tell Pip your story' }], rewards: [{ type: 'item', id: 'bookshelf', amount: 1, description: 'a bookshelf' }, ...coins(6)], dialogue: { offer: 'Every hero needs a chronicle. Come tell me your story.', accept: 'I have ink!', complete: 'Chapter one: The Stranger. I love it.' } },
  ],
  captain_rowan: [
    { title: 'Clear the Road', summary: 'Hostiles keep lurking by the east road.', objectives: [{ id: 'o1', type: 'kill', target: 'zombie', count: 4, description: 'Defeat 4 zombies' }], rewards: coins(5), dialogue: { offer: 'The road east is crawling. Four zombies, soldier.', accept: 'Move out.', complete: 'Road is clear. Good work.' } },
    { title: 'Shore Up the Gate', summary: 'The gate needs fortifying.', objectives: [{ id: 'o1', type: 'place', target: 'gate', count: 10, description: 'Place 10 blocks by the gate' }], rewards: coins(6), dialogue: { offer: 'The gate is weak. Ten blocks of wall, by the gate.', accept: 'Solid stone, if you have it.', complete: "That'll hold. For now." } },
    { title: 'Hold the Line', summary: 'Stand watch with the Captain through a night.', objectives: [{ id: 'o1', type: 'survive', target: 'night', count: 1, description: 'Hold the line until dawn' }], rewards: [{ type: 'item', id: 'iron_sword', amount: 1, description: 'an iron sword' }, ...coins(8)], dialogue: { offer: 'Tonight we hold the line. You and me.', accept: 'Eyes open.', complete: "You held. You're one of us now." } },
  ],
};

export class QuestChains {
  private readonly chains = new Map<string, QuestChain>();

  constructor(private readonly game: Game, private readonly lf: LiveforgeService, private readonly quests: Quests, private readonly stats: PlayerStats, private readonly onChainDone: (c: QuestChain) => void, private readonly onHelped: (giver: string, title: string) => void) {
    game.save.register('wb_chains', () => ({ chains: [...this.chains.values()] }), (d: { chains?: QuestChain[] }) => {
      for (const c of d.chains ?? []) if (c?.id) this.chains.set(c.id, c);
      quests.refresh();
    });
    quests.titleOf = (q) => {
      const c = this.chainOf(q.id);
      if (!c) return null;
      return `${c.title} ${c.quests.findIndex((x) => x.id === q.id) + 1}/${c.of} · ${q.title}`;
    };
    quests.onAccept((q) => {
      const c = this.chainOf(q.id);
      const e = c?.quests.find((x) => x.id === q.id);
      if (e) {
        e.status = 'active';
        game.save.markDirty('wb_chains');
      }
    });
    quests.onComplete((q) => this.completed(q));
  }

  /** All chains (journal), active first. */
  list(): QuestChain[] {
    return [...this.chains.values()].sort((a, b) => Number(a.done) - Number(b.done));
  }

  /** The chain a quest belongs to. */
  chainOf(questId: string): QuestChain | undefined {
    for (const c of this.chains.values()) if (c.quests.some((q) => q.id === questId)) return c;
    return undefined;
  }

  /** Demo / journal: start (or continue) a giver's chain now. */
  start(giver = 'mara'): void {
    const g = lfNpcId(giver);
    const c = this.chainFor(g);
    if (c.done) return void this.game.ui.toast(`${c.title} is already complete`);
    const pending = c.quests.find((q) => q.status !== 'done');
    if (pending && (this.quests.isActive(pending.id))) return void this.game.ui.toast(`${c.title}: finish “${pending.title}” first`);
    if (pending) c.quests.splice(c.quests.indexOf(pending), 1);
    void this.offerNext(c, null);
  }

  private chainFor(giver: string): QuestChain {
    const id = `chain_${giver}`;
    let c = this.chains.get(id);
    if (!c) {
      c = { id, giver, title: TITLES[giver] ?? `${npcLabel(giver)}'s Story`, quests: [], of: LENGTH, done: false };
      this.chains.set(id, c);
    }
    return c;
  }

  private completed(q: Quest): void {
    const giver = lfNpcId(q.giver ?? this.chainOf(q.id)?.giver ?? '');
    this.stats.note('quests', `quest.completed ${q.id}`, `Completed “${q.title}”`);
    if (!TITLES[giver]) return;
    this.onHelped(giver, q.title);
    const c = this.chainOf(q.id) ?? this.chainFor(giver);
    if (c.done) return;
    let e = c.quests.find((x) => x.id === q.id);
    if (!e) {
      // a quest from elsewhere (the repair quest, a server offer) becomes this chain's next step
      c.quests = c.quests.filter((x) => x.status === 'done');
      e = { id: q.id, title: q.title, status: 'done' };
      c.quests.push(e);
    }
    e.status = 'done';
    this.game.save.markDirty('wb_chains');
    const step = c.quests.length;
    if (step >= c.of) {
      c.done = true;
      this.game.ui.toast(`📚 ${c.title} complete!`, { kind: 'good', seconds: 5 });
      getHub().caption(`📚 ${c.title}: the story is complete`, 6);
      this.onChainDone(c);
      return;
    }
    setTimeout(() => void this.offerNext(c, q), 3500);
  }

  /** Asks for the next quest of a chain (AI follow-up when online, local template otherwise). */
  private async offerNext(c: QuestChain, prev: Quest | null): Promise<void> {
    const step = c.quests.filter((x) => x.status === 'done').length + 1;
    const local = this.localStep(c.giver, step);
    const t0 = performance.now();
    let quest: Quest = local;
    let model: 'rules' | 'sonnet' | 'replay' | 'cache' = 'rules';
    let why = 'local chain template';
    try {
      const h = this.lf.ask('quest.offer', {
        giver: c.giver,
        context: {
          previousQuest: prev ? { id: prev.id, title: prev.title, summary: prev.summary } : null,
          outcome: prev ? 'completed' : 'start',
          chain: { id: c.id, title: c.title, step, of: c.of, earlier: c.quests.map((x) => x.title) },
          player: getHub().nickname ?? undefined,
        },
      }, { fallback: { quest: local } });
      const r = await h.instant;
      // the server's instant answer is its keyword rules (blind to the chain): only a cached AI quest beats the
      // local chain template
      if (r.result.quest && r.source === 'cache') {
        quest = r.result.quest;
        model = 'cache';
        why = r.why ?? 'cached AI follow-up';
      }
      // the AI follow-up usually lands within seconds: wait briefly for it (the giver "thinks")
      if (this.lf.online && !h.settled) {
        getHub().caption(`💭 ${npcLabel(c.giver)} is thinking about what comes next…`, 4);
        const up = await Promise.race([h.upgrade, new Promise<null>((res) => setTimeout(() => res(null), 6000))]);
        if (up?.result.quest) {
          quest = up.result.quest;
          model = this.lf.cassette === 'REPLAY' ? 'replay' : 'sonnet';
          why = up.why ?? 'AI follow-up';
        }
      }
    } catch {
      /* local template */
    }
    if (this.quests.isDone(quest.id) || this.quests.isActive(quest.id) || c.quests.some((x) => x.id === quest.id)) quest = { ...quest, id: `${quest.id}_${Date.now().toString(36)}` };
    quest = { ...quest, giver: c.giver };
    c.quests.push({ id: quest.id, title: quest.title, status: 'offered' });
    this.game.save.markDirty('wb_chains');
    this.lf.think({
      source: 'quests', actor: c.giver, kind: 'plan', model, ms: Math.round(performance.now() - t0),
      text: `quest chain ${c.title} ${step}/${c.of}: “${quest.title}”${prev ? ` (after “${prev.title}”: completed)` : ''} · ${quest.objectives.map((o) => `${o.type} ${o.target}${o.count ? ` ×${o.count}` : ''}`).join(', ')}`,
      data: { quest, why },
    });
    this.game.events.emit('questChainAdvanced', { chain: c.id, giver: c.giver, step, of: c.of, title: quest.title });
    this.quests.offer(quest, c.giver);
  }

  private localStep(giver: string, step: number): Quest {
    const steps = STEPS[giver] ?? STEPS.mara;
    const d = steps[Math.min(steps.length, step) - 1];
    return { ...d, id: `wb_${giver}_${step}_${Date.now().toString(36)}`, giver, origin: { kind: 'npc', ref: `chain_${giver}` }, tags: ['chain'] } as Quest;
  }
}

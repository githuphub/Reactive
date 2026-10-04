/**
 * "The village remembers": grief Mara's house → rumour, wary posture, higher prices, the golem confronts you, a
 * repair quest; mend it (≥ 80 %, or Bram co-builds) → trust recovers, a nickname, and the village raises a statue of
 * the player in their outfit colours on the plaza (`builder.plan` "statue of <nickname>").
 *
 * Online the server drives the chain (property_damage reaction, the repair_mara_house rule, the village mind's
 * posture, the statue_for_the_mender rule → `custom.statue`); offline the same beats run on local rules here.
 */
import type { Quest } from '@liveforge/sdk';
import type { Game } from '../game/game';
import { giveItem } from '../survival';
import { village, type RepairTracker } from '../village';
import { raiseStatue } from './build';
import { getHub, playerTitle } from './hub';
import { FACTION } from './ids';
import { getQuests } from './quests';
import type { LiveforgeService } from './service';
import { speakAs } from './voice';

/** The repair quest (same as the manifest's repair_mara_house rule, for offline and the demo button). */
export const REPAIR_QUEST: Quest = {
  id: 'repair_mara_house',
  title: "Mend Mara's house",
  summary: "You broke Mara's house. Put every block back, and Bram may lend a hand.",
  giver: 'mara',
  objectives: [
    { id: 'rebuild', type: 'repair', target: 'mara_house', count: 12, description: "Put the blocks back into Mara's house" },
    { id: 'apologise', type: 'talk', target: 'mara', description: "Tell Mara it's fixed" },
  ],
  rewards: [
    { type: 'reputation', id: 'oakhollow', amount: 0.3, description: 'Oakhollow trusts you again' },
    { type: 'item', id: 'bread', amount: 3, description: "Three loaves of Mara's bread" },
  ],
  dialogue: {
    offer: 'You broke it. You mend it. Every block, mind.',
    accept: 'Good. Bram has spare planks if you ask nicely.',
    complete: 'Hm. Better than before, actually. Thank you.',
  },
  origin: { kind: 'npc', ref: 'mara' },
  tags: ['dynamic', 'repair'],
};

export class Amends {
  private griefs: number[] = [];
  private chainAt = 0;
  private tracker: RepairTracker | null = null;
  private repaired = false;
  private statueRaised = false;
  private statueTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly game: Game, private readonly lf: LiveforgeService) {
    game.events.on('villageDamaged', (e) => {
      if (e.owner === 'mara') this.onGrief();
    });
    setInterval(() => this.checkRepair(), 1000);
    game.save.register('lf_amends', () => ({ statue: this.statueRaised, repaired: this.repaired }), (d: { statue?: boolean; repaired?: boolean }) => {
      this.statueRaised = !!d.statue;
      this.repaired = !!d.repaired;
    });
  }

  /** Demo "Make amends": materials for every missing block + the repair quest. */
  makeAmends(): void {
    const plan = village.repairPlan('mara_house');
    const mats = new Map<string, number>();
    for (const b of plan.blocks) mats.set(b.block, (mats.get(b.block) ?? 0) + 1);
    for (const [item, n] of mats) giveItem(this.game, village.normalizeItem(item), n);
    if (!plan.blocks.length) this.game.ui.toast("Mara's house isn't broken (yet)");
    this.repaired = false;
    this.tracker = village.repairTracker('mara_house');
    getQuests().accept(REPAIR_QUEST, 'mara');
    getHub().caption(`🤝 Making amends: ${plan.blocks.length} blocks to put back. Or ask Bram to help.`, 7);
  }

  /** Demo "Bram, help me repair it": an agent goal (the build tool co-builds the repair). */
  async askBram(): Promise<void> {
    if (!getQuests().isActive(REPAIR_QUEST.id) && !getQuests().isDone(REPAIR_QUEST.id)) getQuests().accept(REPAIR_QUEST, 'mara');
    this.tracker ??= village.repairTracker('mara_house');
    const r = await this.lf.client.agents.goal('bram', "Bram, help me repair Mara's house", { context: 'The player broke part of Mara\'s house and wants to make amends. Rebuild the missing blocks.' });
    getHub().caption(`Bram: ${(r.plan ?? []).join(' → ') || 'on my way'}${r.local ? ' (local rules)' : ''}`, 6);
  }

  /** `custom.statue` from the server (statue_for_the_mender). */
  statueFromServer(prompt?: string): void {
    if (this.statueTimer) clearTimeout(this.statueTimer);
    this.statueTimer = null;
    void this.raise(prompt);
  }

  private onGrief(): void {
    const now = performance.now();
    this.griefs = this.griefs.filter((t) => now - t < 60_000);
    this.griefs.push(now);
    this.repaired = false;
    if (this.griefs.length < 3 || now - this.chainAt < 45_000) return;
    this.chainAt = now;
    this.tracker = null;
    if (this.lf.online) {
      // the server's reactions should offer the quest; make sure the beat still lands
      setTimeout(() => {
        if (!getQuests().isActive(REPAIR_QUEST.id)) getQuests().offer(REPAIR_QUEST, 'mara');
      }, 12_000);
      return;
    }
    void this.localChain();
  }

  /** Offline: the same beats as the server chain, on rules. */
  private async localChain(): Promise<void> {
    const t = performance.now();
    const think = (kind: 'decision' | 'line' | 'thought', source: string, actor: string, text: string) => this.lf.think({ source, actor, kind, text, model: 'rules', ms: Math.round(performance.now() - t) });
    think('decision', 'reactions', 'mara', 'property_damage → repair_quest (owner mara, 3 blocks in 60 s)');
    const mara = village.controller('mara');
    if (mara) {
      void mara.walkTo('player', { run: true }).then(() => {
        void mara.emote('glare');
        void mara.say('My house! You break it, you mend it. Every block, mind.');
        speakAs(this.lf, 'mara', 'My house! You break it, you mend it. Every block, mind.');
      });
    }
    setTimeout(() => {
      const pip = village.controller('pip');
      const line = `Did you hear? ${this.lf.settings.playerName} has been breaking Mara's house!`;
      void pip?.say(line, { priority: 'schedule' });
      think('line', 'reactions', 'pip', `rumour spreads: "${line}"`);
    }, 4000);
    setTimeout(() => {
      village.setPosture('wary');
      village.setPriceMult(1.25);
      const ann = "Doors are bolted in Oakhollow. Someone keeps breaking Mara's house, so prices rise.";
      think('decision', 'factions', FACTION, `posture calm → wary, prices ×1.25: ${ann}`);
      void village.controller('rowan')?.say(ann, { priority: 'schedule' });
      speakAs(this.lf, 'captain_rowan', ann);
      getHub().caption(`🏰 Oakhollow turns wary: prices ×1.25`, 6);
    }, 6000);
    setTimeout(() => getQuests().offer(REPAIR_QUEST, 'mara'), 9000);
  }

  private checkRepair(): void {
    if (this.repaired || !getQuests().isActive(REPAIR_QUEST.id)) return;
    this.tracker ??= village.repairTracker('mara_house');
    if (!this.tracker || this.tracker.restoreProgress() < 0.8) return;
    this.repaired = true;
    this.game.save.markDirty('lf_amends');
    this.lf.signal('world.helped', { npc: 'mara', how: 'repaired her house' });
    this.lf.signal('social.gave', { to: 'mara', item: 'repairs' });
    getHub().caption("🏠 Mara's house is mended. The village noticed.", 6);
    void village.controller('mara')?.say('Hm. Better than before, actually. Thank you.', { priority: 'schedule', emote: 'nod' });
    if (!this.lf.online) {
      village.setPosture('calm');
      village.setPriceMult(1);
      this.lf.think({ source: 'factions', actor: FACTION, kind: 'decision', text: 'trust recovers: posture wary → calm, prices ×1.00', model: 'rules' });
      getQuests().achievement({ id: 'mender', title: 'The Mender', description: 'Rebuild what you broke.', icon: { glyph: 'hammer' } });
      const nick = getHub().nickname ?? 'the Mender';
      getHub().nickname = nick;
      this.lf.think({ source: 'reactions', actor: 'pip', kind: 'decision', text: `deed_nicknames: "${nick}" (rebuilt Mara's house)`, model: 'rules' });
      setTimeout(() => void this.raise(), 3000);
    } else {
      // the server's statue_for_the_mender rule sends custom.statue; fall back if it doesn't come
      this.statueTimer = setTimeout(() => void this.raise(), 15_000);
    }
  }

  private async raise(prompt?: string): Promise<void> {
    if (this.statueRaised) return;
    this.statueRaised = true;
    this.game.save.markDirty('lf_amends');
    const who = playerTitle();
    getHub().caption(`🗿 Oakhollow raises a statue of ${who}`, 8);
    const ok = await raiseStatue(this.game, this.lf, who, prompt?.replace(/\{\{\s*name\s*\}\}/g, who));
    if (!ok) this.statueRaised = false;
  }
}

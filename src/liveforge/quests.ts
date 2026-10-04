/**
 * Quests: offers (from `quest.offer` directives, Reaction Library payloads and local rules) with an accept UI, a
 * tracker (top-left) that measures objectives in the game (repair progress, fetch counts, kills, talks, nights), and
 * achievement toasts. Accept / complete are reported as `quest.accepted` / `quest.completed` signals.
 */
import type { Achievement, Quest } from '@liveforge/sdk';
import type { Game } from '../game/game';
import { findItem } from '../engine/items';
import { countItem, giveItem } from '../survival';
import type { Screen } from '../ui/ui';
import { lfOverlay } from '../ui/lf-styles';
import { village, type RepairTracker } from '../village';
import { lfNpcId, npcName, npcOf } from './ids';
import type { LiveforgeService } from './service';
import { zoneAt } from './signals';
import { speakAs } from './voice';

interface Active {
  quest: Quest;
  giver: string;
  progress: Record<string, number>;
  done: Set<string>;
  trackers: Record<string, RepairTracker | null>;
  kills: Record<string, number>;
}

const GLYPHS: Record<string, string> = { moon: '🌙', brick: '🧱', hammer: '🔨', tower: '🗼', heart: '❤️', anvil: '⚒️', skull: '💀', coin: '🪙', flame: '🔥', star: '⭐' };

type Listener = (q: Quest) => void;

/**
 * A custom objective evaluator (lane WB: chained quests with dynamic objectives). Returns progress 0..1, or null to
 * fall back to the built-in rules for that objective type.
 */
export type ObjectiveEvaluator = (objective: Quest['objectives'][number], quest: Quest, giver: string) => number | null;

export class Quests {
  private readonly offered = new Map<string, { quest: Quest; giver: string }>();
  private readonly active = new Map<string, Active>();
  private readonly completed = new Set<string>();
  private readonly unlocked = new Set<string>();
  private readonly tracker: HTMLElement;
  private readonly completeFns = new Set<Listener>();
  private readonly acceptFns = new Set<(q: Quest, giver: string) => void>();
  private readonly evaluators = new Map<string, ObjectiveEvaluator>();
  /** Optional tracker title (e.g. "Mara's Trust 2/3 · Seeds of Peace"); WB quest chains set it. */
  titleOf: ((q: Quest) => string | null) | null = null;
  /** Optional achievement handler (WB journal + rarity toast); return true to skip the plain toast. */
  onAchievement: ((a: Pick<Achievement, 'id' | 'title' | 'description'> & { icon?: { glyph?: string }; rarity?: string }) => boolean) | null = null;
  private queue: { quest: Quest; giver: string }[] = [];
  private offerScreen: Screen | null = null;
  private talkedTo = new Set<string>();
  private nights = 0;
  private forged = 0;

  constructor(private readonly game: Game, private readonly lf: LiveforgeService) {
    this.tracker = document.createElement('div');
    this.tracker.className = 'lcx-quests';
    lfOverlay().appendChild(this.tracker);
    game.events.on('mobKilled', (e) => {
      if (!e.byPlayer) return;
      for (const a of this.active.values()) for (const o of a.quest.objectives) if (o.type === 'kill' && (e.type === o.target || e.type.includes(o.target) || o.target === 'any' || o.target === 'raider')) a.kills[o.id] = (a.kills[o.id] ?? 0) + 1;
    });
    game.events.on('villagerTalk', (e) => this.talkedTo.add(lfNpcId(e.npc)));
    game.events.on('phaseChanged', (e) => {
      if (e.phase === 'dawn' && e.day > 0) this.nights++;
    });
    setInterval(() => this.evaluate(), 1000);
    game.save.register('lf_quests', () => ({
      active: [...this.active.values()].map((a) => ({ quest: a.quest, giver: a.giver, done: [...a.done] })),
      completed: [...this.completed],
      unlocked: [...this.unlocked],
    }), (d: { active?: { quest: Quest; giver: string; done: string[] }[]; completed?: string[]; unlocked?: string[] }) => {
      for (const c of d.completed ?? []) this.completed.add(c);
      for (const u of d.unlocked ?? []) this.unlocked.add(u);
      for (const a of d.active ?? []) this.start(a.quest, a.giver, new Set(a.done), true);
      this.render();
    });
  }

  /** Called whenever a quest completes. */
  onComplete(fn: Listener): () => void {
    this.completeFns.add(fn);
    return () => this.completeFns.delete(fn);
  }

  /** Called whenever a quest is accepted (not on save restore). */
  onAccept(fn: (q: Quest, giver: string) => void): () => void {
    this.acceptFns.add(fn);
    return () => this.acceptFns.delete(fn);
  }

  /** Registers (or overrides) how an objective type is measured; the evaluator may return null to use the default. */
  registerObjective(type: string, fn: ObjectiveEvaluator): void {
    this.evaluators.set(type, fn);
  }

  /** Active quests with their giver and finished objective ids (journal). */
  activeList(): { quest: Quest; giver: string; done: string[]; progress: Record<string, number> }[] {
    return [...this.active.values()].map((a) => ({ quest: a.quest, giver: a.giver, done: [...a.done], progress: { ...a.progress } }));
  }

  /** Re-renders the tracker (after a chain label changed). */
  refresh(): void {
    this.render();
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  isDone(id: string): boolean {
    return this.completed.has(id);
  }

  /** Count a forge (forge objectives). */
  noteForged(): void {
    this.forged++;
  }

  /** Offers a quest (deduped by id). Shows the offer card unless `autoAccept`. */
  offer(quest: Quest, giver?: string, opts: { autoAccept?: boolean } = {}): void {
    const g = lfNpcId(giver ?? quest.giver ?? 'mara');
    if (this.active.has(quest.id) || this.completed.has(quest.id)) return;
    if (opts.autoAccept) {
      this.offered.delete(quest.id);
      this.accept(quest, g);
      return;
    }
    if (this.offered.has(quest.id)) return;
    this.offered.set(quest.id, { quest, giver: g });
    const line = quest.dialogue?.offer;
    if (line) {
      void npcOf(g)?.bubble?.say(line);
      speakAs(this.lf, g, line);
    }
    this.queue.push({ quest, giver: g });
    this.showNextOffer();
  }

  /** Accepts a quest directly (demo "Make amends"). */
  accept(quest: Quest, giver: string): void {
    if (this.active.has(quest.id) || this.completed.has(quest.id)) return;
    this.offered.delete(quest.id);
    this.start(quest, giver, new Set(), false);
    this.lf.signal('quest.accepted', { quest: quest.id, giver });
    const line = quest.dialogue?.accept;
    if (line) {
      void npcOf(giver)?.bubble?.say(line);
      speakAs(this.lf, giver, line);
    }
    this.game.ui.toast(`Quest accepted: ${quest.title}`, { kind: 'good' });
    for (const fn of this.acceptFns) {
      try {
        fn(quest, giver);
      } catch (err) {
        console.error('[quests] onAccept failed', err);
      }
    }
    this.render();
  }

  /** Server progress (`quest.update`). */
  update(questId: string, status: string, objectiveId?: string, progress?: number): void {
    const a = this.active.get(questId);
    if (!a) return;
    if (objectiveId) {
      const o = a.quest.objectives.find((x) => x.id === objectiveId);
      if (o && progress !== undefined && progress >= Math.max(1, o.count ?? 1)) a.done.add(objectiveId);
      this.render();
    }
    if (status === 'completed' && !objectiveId) this.complete(a);
    else if (status === 'failed' || status === 'expired') {
      this.active.delete(questId);
      this.game.ui.toast(`Quest ${status}: ${a.quest.title}`, { kind: 'warn' });
      this.render();
    }
  }

  /** Achievement toast (server `achievement.unlocked` or local). */
  achievement(a: Pick<Achievement, 'id' | 'title' | 'description'> & { icon?: { glyph?: string }; rarity?: string }): void {
    if (this.unlocked.has(a.id)) return;
    this.unlocked.add(a.id);
    this.game.save.markDirty('lf_quests');
    if (this.onAchievement?.(a)) return; // lane WB: journal record + rarity toast
    const el = document.createElement('div');
    el.className = 'lcx-ach';
    const g = document.createElement('span');
    g.className = 'lcx-glyph';
    g.textContent = GLYPHS[a.icon?.glyph ?? ''] ?? '🏆';
    const t = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = 'ACHIEVEMENT GET!';
    t.append(b, document.createTextNode(`${a.title} — ${a.description}`));
    el.append(g, t);
    lfOverlay().appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  private start(quest: Quest, giver: string, done: Set<string>, restoring: boolean): void {
    const trackers: Record<string, RepairTracker | null> = {};
    for (const o of quest.objectives) if (o.type === 'repair') trackers[o.id] = village.repairTracker(o.target === 'mara' ? 'mara_house' : o.target);
    this.active.set(quest.id, { quest, giver, progress: {}, done, trackers, kills: {} });
    if (!restoring) this.game.save.markDirty('lf_quests');
  }

  private evaluate(): void {
    if (!this.active.size) return;
    let changed = false;
    const p = this.game.player.position;
    const zone = zoneAt(this.game, p.x, p.y, p.z);
    for (const a of [...this.active.values()]) {
      let blocked = false;
      for (const o of a.quest.objectives) {
        if (a.done.has(o.id)) continue;
        if (blocked && !o.optional) {
          a.progress[o.id] = 0;
          continue;
        }
        const need = Math.max(1, o.count ?? 1);
        let prog = 0;
        const custom = this.evaluators.get(o.type)?.(o, a.quest, a.giver);
        if (custom !== undefined && custom !== null) prog = custom;
        else switch (o.type) {
          case 'repair': {
            const t = a.trackers[o.id];
            prog = t ? Math.min(1, t.restoreProgress() / 0.8) : 0;
            break;
          }
          case 'fetch':
            prog = countItem(this.game, this.itemOf(o.target)) / need;
            break;
          case 'kill':
            prog = (a.kills[o.id] ?? 0) / need;
            break;
          case 'talk':
          case 'deliver':
            prog = this.talkedTo.has(lfNpcId(o.target)) ? 1 : 0;
            break;
          case 'survive':
            prog = this.nights > 0 ? 1 : 0;
            break;
          case 'explore':
            prog = zone === o.target ? 1 : 0;
            break;
          case 'forge':
            prog = this.forged / need;
            break;
          default:
            prog = 0;
        }
        prog = Math.max(0, Math.min(1, prog));
        if (a.progress[o.id] !== prog) {
          a.progress[o.id] = prog;
          changed = true;
        }
        if (prog >= 1) {
          a.done.add(o.id);
          changed = true;
          if (o.type === 'fetch' || o.type === 'repair') this.talkedTo.delete(lfNpcId(a.giver));
        } else if (!o.optional) blocked = true;
      }
      if (a.quest.objectives.every((o) => o.optional || a.done.has(o.id))) this.complete(a);
    }
    if (changed) this.render();
  }

  private itemOf(target: string): string {
    return findItem(target) ? target : village.normalizeItem(target);
  }

  private complete(a: Active): void {
    if (!this.active.has(a.quest.id)) return;
    this.active.delete(a.quest.id);
    this.completed.add(a.quest.id);
    this.lf.signal('quest.completed', { quest: a.quest.id });
    for (const r of a.quest.rewards) {
      if (r.type === 'item' && r.id) giveItem(this.game, this.itemOf(r.id), Math.max(1, Math.min(64, r.amount ?? 1)));
      if (r.type === 'gold') giveItem(this.game, 'coins', Math.max(1, Math.min(64, r.amount ?? 1)));
    }
    const line = a.quest.dialogue?.complete;
    if (line) {
      void npcOf(a.giver)?.bubble?.say(line);
      speakAs(this.lf, a.giver, line);
    }
    this.game.ui.toast(`Quest complete: ${a.quest.title}`, { kind: 'good', seconds: 4 });
    this.game.save.markDirty('lf_quests');
    for (const fn of this.completeFns) {
      try {
        fn(a.quest);
      } catch (err) {
        console.error('[quests] onComplete failed', err);
      }
    }
    this.render();
  }

  private render(): void {
    this.tracker.replaceChildren();
    for (const a of this.active.values()) {
      const card = document.createElement('div');
      card.className = 'lcx-quest';
      const title = document.createElement('b');
      title.textContent = `📜 ${this.titleOf?.(a.quest) ?? a.quest.title}`;
      card.appendChild(title);
      for (const o of a.quest.objectives) {
        const row = document.createElement('div');
        const done = a.done.has(o.id);
        row.className = `lcx-obj${done ? ' lcx-done' : ''}`;
        const pct = Math.round((done ? 1 : a.progress[o.id] ?? 0) * 100);
        row.textContent = `${done ? '✔' : '•'} ${o.description}${!done && pct > 0 ? ` (${pct}%)` : ''}`;
        card.appendChild(row);
        if (!done && o.type === 'repair') {
          const bar = document.createElement('div');
          bar.className = 'lcx-bar';
          const fill = document.createElement('i');
          fill.style.width = `${pct}%`;
          bar.appendChild(fill);
          card.appendChild(bar);
        }
      }
      this.tracker.appendChild(card);
    }
  }

  private showNextOffer(): void {
    const screens = this.game.ui.screens;
    if (this.offerScreen && screens.has('lf-quest-offer')) return;
    const next = this.queue.shift();
    if (!next) return;
    if (!this.offered.has(next.quest.id)) return this.showNextOffer();
    const { quest, giver } = next;
    const root = document.createElement('div');
    const box = document.createElement('div');
    box.className = 'lcx-offer';
    const h = document.createElement('h2');
    h.textContent = `📜 ${quest.title}`;
    const g = document.createElement('div');
    g.className = 'lcx-giver';
    g.textContent = `Offered by ${npcName(giver)}`;
    const s = document.createElement('div');
    s.textContent = quest.summary;
    const line = document.createElement('div');
    line.className = 'lcx-line';
    line.textContent = quest.dialogue?.offer ? `“${quest.dialogue.offer}”` : '';
    const ul = document.createElement('ul');
    for (const o of quest.objectives) {
      const li = document.createElement('li');
      li.textContent = o.description;
      ul.appendChild(li);
    }
    const rw = document.createElement('div');
    rw.className = 'lcx-hint';
    rw.textContent = quest.rewards.length ? `Rewards: ${quest.rewards.map((r) => r.description ?? `${r.amount ?? ''} ${r.id ?? r.type}`.trim()).join(', ')}` : '';
    const btns = document.createElement('div');
    btns.className = 'lcx-btns';
    const yes = document.createElement('button');
    yes.className = 'lc-btn';
    yes.textContent = 'Accept';
    const no = document.createElement('button');
    no.className = 'lc-btn';
    no.textContent = 'Not now';
    btns.append(yes, no);
    box.append(h, g, s, line, ul, rw, btns);
    root.appendChild(box);
    const screen: Screen = {
      id: 'lf-quest-offer',
      el: root,
      pausesGame: true,
      onClose: () => {
        this.offerScreen = null;
        setTimeout(() => this.showNextOffer(), 300);
      },
      onKey: (e) => {
        if (e.code === 'Enter') {
          yes.click();
          return true;
        }
        return false;
      },
    };
    yes.addEventListener('click', () => {
      this.accept(quest, giver);
      screens.close(screen);
      this.game.input.lock();
    });
    no.addEventListener('click', () => {
      this.offered.delete(quest.id);
      this.lf.signal('quest.failed', { quest: quest.id, reason: 'declined' });
      screens.close(screen);
      this.game.input.lock();
    });
    this.offerScreen = screen;
    screens.open(screen);
  }
}

let quests: Quests | null = null;

/** @internal */
export function initQuests(game: Game, lf: LiveforgeService): Quests {
  quests = new Quests(game, lf);
  return quests;
}

/** The quest system (after plugin init). */
export function getQuests(): Quests {
  if (!quests) throw new Error('quests not initialised');
  return quests;
}

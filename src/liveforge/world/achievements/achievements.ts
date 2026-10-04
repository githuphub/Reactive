/**
 * Achievements (lane WB).
 *
 * - **Instant rules:** the local list (list.ts) is checked against PlayerStats whenever a counter changes.
 * - **Generated:** after notable events (batched: 4 s debounce, at most one call per 25 s) the game asks
 *   `achievement.check {recent}` with the last 20 signal strings; the instant answer and the AI upgrade can both
 *   unlock quirky generated achievements.
 * - Server `achievement.unlocked` directives and V3's local ones (The Mender) come through `quests.onAchievement`.
 *
 * Every unlock gets one toast (icon + rarity glow) and is recorded for the journal (slot `wb_achievements`).
 */
import type { Achievement } from '@liveforge/sdk';
import type { Game } from '../../../game/game';
import { lfOverlay } from '../../../ui/lf-styles';
import { getHub } from '../../hub';
import { getQuests } from '../../quests';
import type { LiveforgeService } from '../../service';
import type { RumourBook } from '../rumours';
import type { PlayerStats, StatKey } from '../stats';
import { injectWorldStyles, RARITY_COLOR } from '../styles';
import { GLYPH_EMOJI, LOCAL_ACHIEVEMENTS, type AchContext } from './list';
import '../events';

/** An unlocked achievement as the journal shows it. */
export interface UnlockedAchievement {
  id: string;
  title: string;
  description: string;
  icon: string;
  rarity: string;
  at: number;
  source: 'server' | 'local';
  /** Generated for this player (vs. designer / local list). */
  personal: boolean;
}

/** Counters whose change makes a server check worthwhile. */
const NOTABLE: StatKey[] = ['griefs', 'kills', 'deaths', 'trades', 'hagglesWon', 'forged', 'nights', 'quests', 'rumoursAboutYou', 'makeovers', 'pillars', 'villagersHit'];

export class Achievements {
  private readonly unlocked = new Map<string, UnlockedAchievement>();
  private readonly toastQueue: UnlockedAchievement[] = [];
  private toasting = false;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCheck = 0;
  private localTimer: ReturnType<typeof setTimeout> | null = null;
  /** Chains finished (set by the quest chains). */
  chainsDone = 0;

  constructor(private readonly game: Game, private readonly lf: LiveforgeService, private readonly stats: PlayerStats, private readonly book: RumourBook) {
    injectWorldStyles();
    game.save.register('wb_achievements', () => ({ unlocked: [...this.unlocked.values()], chainsDone: this.chainsDone }), (d: { unlocked?: UnlockedAchievement[]; chainsDone?: number }) => {
      for (const a of d.unlocked ?? []) if (a?.id) this.unlocked.set(a.id, a);
      this.chainsDone = d.chainsDone ?? 0;
    });
    stats.onChange((key) => {
      this.scheduleLocal();
      if (NOTABLE.includes(key)) this.scheduleCheck();
    });
    book.onChange(() => this.scheduleLocal());
    try {
      getQuests().onAchievement = (a) => {
        this.record({ ...a, rarity: a.rarity ?? 'uncommon' } as Achievement, 'server');
        return true;
      };
    } catch {
      /* quests not initialised */
    }
    setInterval(() => this.checkLocal(), 10_000);
  }

  /** Unlocked achievements, newest first. */
  list(): UnlockedAchievement[] {
    return [...this.unlocked.values()].sort((a, b) => b.at - a.at);
  }

  /** Local achievements still locked (journal hints). */
  locked(): { title: string; hint: string; icon: string; rarity: string }[] {
    return LOCAL_ACHIEVEMENTS.filter((a) => !this.unlocked.has(a.id)).map((a) => ({ title: a.title, hint: a.hint, icon: a.icon, rarity: a.rarity }));
  }

  /** Runs `achievement.check` soon (batched). */
  scheduleCheck(delayMs = 4000): void {
    if (this.checkTimer) return;
    const wait = Math.max(delayMs, 25_000 - (Date.now() - this.lastCheck));
    this.checkTimer = setTimeout(() => {
      this.checkTimer = null;
      void this.check();
    }, wait);
  }

  /** Unlocks (once) and toasts. */
  record(a: Achievement | (Pick<Achievement, 'id' | 'title' | 'description'> & { icon?: Achievement['icon']; rarity?: string; personal?: boolean }), source: 'server' | 'local', icon?: string): void {
    const key = this.unlocked.has(a.id) ? a.id : [...this.unlocked.values()].find((u) => u.title.toLowerCase() === a.title.toLowerCase())?.id;
    if (key) return;
    const glyph = a.icon?.glyph ?? '';
    const u: UnlockedAchievement = {
      id: a.id, title: a.title, description: a.description, icon: icon ?? GLYPH_EMOJI[glyph] ?? (/\p{Extended_Pictographic}/u.test(glyph) ? glyph : '🏆'),
      rarity: a.rarity ?? 'common', at: Date.now(), source, personal: a.personal ?? source === 'server',
    };
    this.unlocked.set(u.id, u);
    this.game.save.markDirty('wb_achievements');
    this.game.events.emit('achievementUnlocked', { achievement: { id: u.id, title: u.title, description: u.description, icon: { glyph }, condition: 'condition' in a ? a.condition : 'local', rarity: u.rarity as Achievement['rarity'], personal: u.personal }, source });
    this.lf.think({ source: 'quests', actor: 'achievements', kind: 'decision', model: source === 'local' ? 'rules' : this.lf.cassette === 'REPLAY' ? 'replay' : 'rules', text: `🏆 ${u.title} (${u.rarity}): ${u.description}` });
    this.toastQueue.push(u);
    if (!this.toasting) void this.drainToasts();
  }

  private scheduleLocal(): void {
    if (this.localTimer) return;
    this.localTimer = setTimeout(() => {
      this.localTimer = null;
      this.checkLocal();
    }, 800);
  }

  private checkLocal(): void {
    if (!this.game.ready) return;
    const c: AchContext = { stats: this.stats, rumours: this.book.list(), nickname: getHub().nickname, chainsDone: this.chainsDone };
    for (const a of LOCAL_ACHIEVEMENTS) {
      if (this.unlocked.has(a.id)) continue;
      let ok = false;
      try {
        ok = a.test(c);
      } catch {
        ok = false;
      }
      if (ok) this.record({ id: a.id, title: a.title, description: a.description, rarity: a.rarity, personal: false }, 'local', a.icon);
    }
  }

  private async check(): Promise<void> {
    if (!this.lf.online) return;
    this.lastCheck = Date.now();
    const recent = this.stats.recent(20);
    if (!recent.length) return;
    try {
      const h = this.lf.ask('achievement.check', { recent });
      const r = await h.instant;
      for (const a of r.result.unlocked ?? []) this.record(a, 'server');
      h.onUpgrade((u) => {
        for (const a of u.result.unlocked ?? []) this.record(a, 'server');
      });
    } catch {
      /* the local list covers offline */
    }
  }

  private async drainToasts(): Promise<void> {
    this.toasting = true;
    while (this.toastQueue.length) {
      const u = this.toastQueue.shift()!;
      this.toast(u);
      await new Promise((r) => setTimeout(r, 4800));
    }
    this.toasting = false;
  }

  private toast(u: UnlockedAchievement): void {
    const el = document.createElement('div');
    el.className = 'wbw-ach';
    el.style.setProperty('--wbw-rar', RARITY_COLOR[u.rarity] ?? RARITY_COLOR.common);
    const icon = document.createElement('div');
    icon.className = 'wbw-icon';
    icon.textContent = u.icon;
    const body = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = `ACHIEVEMENT · ${u.rarity.toUpperCase()}${u.personal ? ' · JUST FOR YOU' : ''}`;
    const t = document.createElement('div');
    t.className = 'wbw-t';
    t.textContent = u.title;
    const d = document.createElement('div');
    d.className = 'wbw-d';
    d.textContent = u.description;
    body.append(b, t, d);
    el.append(icon, body);
    lfOverlay().appendChild(el);
    setTimeout(() => el.classList.add('wbw-out'), 4200);
    setTimeout(() => el.remove(), 4900);
  }
}

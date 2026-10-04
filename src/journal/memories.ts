/**
 * What each villager remembers about the player, for the journal's "What they think of you" page.
 *
 * Reactive has no public route for `persona.memories`, so the memories are built locally from what the game saw:
 * conversations (`npcReplied`), trades and haggles, griefing (owner + witnesses), hits, finished quests, rumours a
 * villager heard, makeovers, and the lines villagers said in directives. Each entry carries a sentiment; the local
 * attitude is their running sum. Online, the server's attitudes (`world.reactions` / `GET /v1/m/world/standing`),
 * Oakhollow's reputation and the village mind's trust (`lf.factions.state('oakhollow')`) replace the estimates.
 *
 * Nicknames coined by the Reaction Library (`deed_nicknames`) are collected too. Saved in the slot `wb_memories`.
 */
import type { Directive } from '@liveforge/sdk';
import type { Game } from '../game/game';
import { village } from '../village';
import { getHub } from '../liveforge/hub';
import { FACTION, LF_NAMED, lfNpcId } from '../liveforge/ids';
import { getQuests } from '../liveforge/quests';
import type { LiveforgeService } from '../liveforge/service';
import { npcLabel } from '../liveforge/world/stats';
import type { Rumours } from '../liveforge/world/rumours';
import '../liveforge/world/events';

export interface Memory {
  text: string;
  ts: number;
  kind: 'conversation' | 'witnessed' | 'rumour' | 'gift' | 'harm' | 'trade' | 'other';
  /** -1..1 how it felt. */
  sentiment: number;
}

/** Server-side standing (online only). */
export interface Standing {
  attitudes: Record<string, number>;
  reputation: { value: number; standing: string; name: string } | null;
  trust: number | null;
  posture: string | null;
  mood: number | null;
  priceMult: number | null;
  fetchedAt: number;
}

const MAX_PER_NPC = 14;
const NEGATIVE = /\b(broke|smash|wreck|stole|pinch|swindl|hit|hurt|grief|flatten|fell|slaughter)\w*/i;

export class Memories {
  private readonly entries = new Map<string, Memory[]>();
  private readonly attitude = new Map<string, number>();
  readonly nicknames: { name: string; because?: string; ts: number }[] = [];
  standing: Standing | null = null;
  private lastGrief = new Map<string, number>();

  constructor(private readonly game: Game, private readonly lf: LiveforgeService, private readonly rumours: Rumours, private readonly onFriend: (npc: string) => void) {
    const ev = game.events;
    ev.on('npcReplied', (e) => this.add(e.npc, 'conversation', `You said “${clip(e.said, 70)}”. I told you “${clip(e.text, 90)}”`, e.mood ?? 0.02));
    ev.on('traded', (e) => this.add(lfNpcId(e.npc), 'trade', e.kind === 'buy' ? `You bought ${e.count} ${e.item.replace(/_/g, ' ')} for ${e.price} coins.` : `You sold me ${e.count} ${e.item.replace(/_/g, ' ')}.`, 0.04));
    ev.on('haggled', (e) => this.add(lfNpcId(e.npc), 'trade', e.accepted ? 'You haggled and I gave in. This time.' : 'You tried to haggle. I held firm.', e.accepted ? -0.02 : -0.01));
    ev.on('villageDamaged', (e) => {
      const owner = lfNpcId(e.owner);
      const now = Date.now();
      if (now - (this.lastGrief.get(owner) ?? 0) < 30_000) {
        this.nudge(owner, -0.05);
        return;
      }
      this.lastGrief.set(owner, now);
      this.add(owner, 'harm', `You broke my house. I watched you do it.`, -0.25);
      for (const n of LF_NAMED) {
        if (n === owner || n === 'iron_golem') continue;
        const npc = village.npc(n);
        if (npc && Math.hypot(npc.position.x - e.x, npc.position.z - e.z) < 18) this.add(n, 'witnessed', `I saw you smash up ${npcLabel(owner)}'s house.`, -0.1);
      }
    });
    ev.on('entityHurt', (e) => {
      if (!e.source?.player || !e.entity.data?.villager) return;
      this.add(lfNpcId(String(e.entity.data.npcId ?? '')), 'harm', 'You hit me!', -0.3);
    });
    ev.on('rumourSpread', (e) => {
      const from = e.from ? ` (${npcLabel(e.from)} told me)` : '';
      this.add(e.to, 'rumour', `Heard: “${clip(e.content, 100)}”${from}`, NEGATIVE.test(e.content) ? -0.06 : 0.03);
    });
    ev.on('npcMakeover', (e) => this.add(e.npc, 'other', `Got a new look: ${e.summary.replace(/^.*?→ /, '')} (${reasonText(e.reason)}).`, e.reason === 'griefed' ? -0.02 : 0.05));
    try {
      getQuests().onComplete((q) => {
        const giver = q.giver ? lfNpcId(q.giver) : null;
        if (giver) this.add(giver, 'gift', `You finished “${q.title}” for me.`, 0.25);
      });
    } catch {
      /* quests not ready */
    }
    lf.client.on('*', (d: Directive) => this.fromDirective(d));

    game.save.register('wb_memories', () => ({
      entries: Object.fromEntries(this.entries), attitude: Object.fromEntries(this.attitude), nicknames: this.nicknames,
    }), (d: { entries?: Record<string, Memory[]>; attitude?: Record<string, number>; nicknames?: { name: string; because?: string; ts: number }[] }) => {
      for (const [k, v] of Object.entries(d.entries ?? {})) this.entries.set(k, v);
      for (const [k, v] of Object.entries(d.attitude ?? {})) this.attitude.set(k, v);
      this.nicknames.push(...(d.nicknames ?? []));
    });
  }

  /** Memories of one villager, newest first. */
  of(npc: string): Memory[] {
    return this.entries.get(lfNpcId(npc)) ?? [];
  }

  /** Attitude toward the player (-1..1): the server's when known, else the local estimate. */
  attitudeOf(npc: string): { value: number; source: 'server' | 'local' } {
    const id = lfNpcId(npc);
    const server = this.standing?.attitudes[id] ?? this.rumours.attitudes[id];
    if (typeof server === 'number' && this.lf.online) return { value: server, source: 'server' };
    return { value: this.attitude.get(id) ?? 0, source: 'local' };
  }

  /** Local reputation estimate for Oakhollow (mean attitude of the named villagers). */
  localReputation(): number {
    const ids = LF_NAMED.filter((n) => n !== 'iron_golem');
    return ids.reduce((s, n) => s + (this.attitude.get(n) ?? 0), 0) / ids.length;
  }

  /** Fetches standing, reputation and trust from the server (no-op offline). */
  async refresh(): Promise<void> {
    if (!this.lf.online) return;
    const c = this.lf.client;
    const s: Standing = { attitudes: {}, reputation: null, trust: null, posture: null, mood: null, priceMult: null, fetchedAt: Date.now() };
    try {
      const url = c.resolveUrl(`/v1/m/world/standing?world=${encodeURIComponent(c.world)}&player=${encodeURIComponent(c.player)}&npcs=${LF_NAMED.join(',')}`);
      const r = await fetch(url, { headers: c.authHeaders() });
      if (r.ok) {
        const j = (await r.json()) as { attitudes?: Record<string, number>; reputation?: Record<string, { value: number; standing: string; name: string }> };
        s.attitudes = j.attitudes ?? {};
        s.reputation = j.reputation?.[FACTION] ?? null;
      }
    } catch {
      /* world module off */
    }
    try {
      const mind = await c.factions.state(FACTION);
      if (mind) {
        s.trust = mind.trust?.[c.player] ?? null;
        s.posture = mind.posture ?? null;
        s.mood = mind.mood ?? null;
        s.priceMult = mind.priceMult ?? null;
      }
    } catch {
      /* factions off */
    }
    this.standing = s;
    for (const [npc, v] of Object.entries(s.attitudes)) if (v >= 0.6) this.onFriend(npc);
  }

  private fromDirective(d: Directive): void {
    const a = (d.args ?? {}) as Record<string, unknown>;
    if (d.kind === 'npc.bark' && typeof a.npc === 'string' && typeof a.text === 'string') {
      this.add(lfNpcId(a.npc), 'other', `Told you: “${clip(a.text, 100)}”`, 0);
    } else if (d.kind === 'custom.reaction') {
      const p = (a.payload ?? {}) as Record<string, unknown>;
      if (p.effect === 'nickname' && typeof p.nickname === 'string') this.nickname(p.nickname, typeof p.because === 'string' ? p.because : undefined);
      const who = typeof p.npc === 'string' ? p.npc : null;
      const line = typeof p.line === 'string' ? p.line : typeof a.line === 'string' ? a.line : null;
      if (who && line) this.add(lfNpcId(who), 'witnessed', `${humanRecipe(String(a.recipe ?? ''))}: “${clip(line, 100)}”`, 0);
    }
  }

  /** Records a nickname (deduped). */
  nickname(name: string, because?: string): void {
    if (this.nicknames.some((n) => n.name === name)) return;
    this.nicknames.unshift({ name, because, ts: Date.now() });
    this.game.save.markDirty('wb_memories');
  }

  /** All nicknames, including the hub's current one. */
  allNicknames(): { name: string; because?: string; ts: number }[] {
    const cur = getHub().nickname;
    if (cur && !this.nicknames.some((n) => n.name === cur)) this.nicknames.unshift({ name: cur, ts: Date.now() });
    return this.nicknames;
  }

  private add(npc: string, kind: Memory['kind'], text: string, sentiment: number): void {
    if (!npc || !village.npc(npc)) return;
    const list = this.entries.get(npc) ?? [];
    if (list[0]?.text === text) return;
    list.unshift({ text, ts: Date.now(), kind, sentiment });
    if (list.length > MAX_PER_NPC) list.length = MAX_PER_NPC;
    this.entries.set(npc, list);
    this.nudge(npc, sentiment);
    this.game.save.markDirty('wb_memories');
  }

  private nudge(npc: string, by: number): void {
    const before = this.attitude.get(npc) ?? 0;
    const v = Math.max(-1, Math.min(1, before + by));
    this.attitude.set(npc, v);
    if (before < 0.6 && v >= 0.6) this.onFriend(npc);
  }
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function humanRecipe(r: string): string {
  return r ? r.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : 'Said';
}

function reasonText(r: string): string {
  return ({ built_for_player: 'after building for you', griefed: 'after you broke my house', guarding: 'standing guard', festive: 'for the festival', helped: 'because you helped me', friend: "because we're friends" } as Record<string, string>)[r] ?? r;
}

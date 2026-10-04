/**
 * PlayerStats: what the player did, measured from Game events (no server needed). It feeds the offline trait
 * estimate in the journal, the local achievement list, the local rumour engine and the `recent` list sent with
 * `achievement.check`. Saved in the slot `wb_stats`.
 *
 * ```ts
 * const s = getStats();
 * s.count('blocksPlaced');            // lifetime counter
 * s.within('kills', 120);             // kills in the last 2 minutes
 * s.recent();                         // ["block.placed oak_planks", "combat.killed zombie", ...] newest last
 * ```
 */
import type { Game } from '../../game/game';
import { blockById } from '../../engine/blocks';
import { village } from '../../village';
import { inVillage, lfNpcId } from '../ids';
import './events';

/** Counter names (lifetime totals). */
export type StatKey =
  | 'blocksBroken' | 'blocksPlaced' | 'placedInVillage' | 'kills' | 'deaths' | 'trades' | 'haggles' | 'hagglesWon'
  | 'griefs' | 'crafted' | 'forged' | 'talks' | 'nights' | 'arrows' | 'pillars' | 'quests' | 'rumoursAboutYou'
  | 'makeovers' | 'villagersHit' | 'distance' | 'explosions';

/** A notable thing the player did (journal "recent moments"). */
export interface LocalMoment {
  ts: number;
  text: string;
  /** Short kind ("grief", "night", "death" ...). */
  kind: string;
}

interface Saved {
  counts: Partial<Record<StatKey, number>>;
  kills: Record<string, number>;
  deathCauses: Record<string, number>;
  talkedTo: string[];
  forgedNames: string[];
  maxPillar: number;
  moments: LocalMoment[];
}

type Listener = (key: StatKey, detail: string) => void;

export class PlayerStats {
  private counts: Partial<Record<StatKey, number>> = {};
  /** Kills by mob type. */
  readonly kills: Record<string, number> = {};
  readonly deathCauses: Record<string, number> = {};
  readonly talkedTo = new Set<string>();
  readonly forgedNames: string[] = [];
  maxPillar = 0;
  readonly moments: LocalMoment[] = [];
  /** [key, wall time ms] for windowed counts (last 30 minutes). */
  private readonly log: { key: StatKey; ts: number }[] = [];
  /** Signal-like strings, newest last (<= 40), for achievement.check `recent`. */
  private readonly recentSignals: string[] = [];
  private readonly listeners = new Set<Listener>();
  private lastPos: { x: number; z: number } | null = null;

  constructor(private readonly game: Game) {
    const ev = game.events;
    ev.on('blockBroken', (e) => {
      if (e.source !== 'player') return;
      const name = blockById(e.id)?.name ?? 'block';
      this.bump('blocksBroken', `block.broken ${name}`);
    });
    ev.on('blockPlaced', (e) => {
      if (e.source !== 'player') return;
      const name = blockById(e.id)?.name ?? 'block';
      this.bump('blocksPlaced', `block.placed ${name}`);
      if (inVillage(e.x, e.z, game.villageSite)) this.bump('placedInVillage', `block.placed{village=oakhollow} ${name}`);
    });
    ev.on('mobKilled', (e) => {
      if (!e.byPlayer) return;
      this.kills[e.type] = (this.kills[e.type] ?? 0) + 1;
      this.bump('kills', `combat.killed ${e.type}`);
    });
    ev.on('playerDied', (e) => {
      this.deathCauses[e.cause] = (this.deathCauses[e.cause] ?? 0) + 1;
      this.bump('deaths', `combat.died ${e.cause}`);
      this.moment('death', `Died: ${e.cause}`);
    });
    ev.on('traded', (e) => this.bump('trades', `economy.${e.kind === 'buy' ? 'bought' : 'sold'} ${e.item} from ${lfNpcId(e.npc)}`));
    ev.on('haggled', (e) => {
      this.bump('haggles', `economy.haggled ${lfNpcId(e.npc)} ${e.accepted ? 'won' : 'lost'}`);
      if (e.accepted) this.bump('hagglesWon', 'economy.haggled won');
    });
    ev.on('villageDamaged', (e) => {
      this.bump('griefs', `world.property_damaged owner=${lfNpcId(e.owner)}`);
      if (this.within('griefs', 60) === 3) this.moment('grief', `Broke ${npcLabel(e.owner)}'s house`);
    });
    ev.on('itemCrafted', (e) => this.bump('crafted', `item.crafted ${e.item}`));
    ev.on('villagerTalk', (e) => {
      const id = lfNpcId(e.npc);
      if (!this.talkedTo.has(id)) this.moment('talk', `Met ${npcLabel(id)}`);
      this.talkedTo.add(id);
      this.bump('talks', `social.talked_to ${id}`);
    });
    ev.on('phaseChanged', (e) => {
      if (e.phase === 'dawn' && e.day > 0) {
        this.bump('nights', `night.survived ${e.day}`);
        this.moment('night', `Survived night ${e.day}`);
      }
    });
    ev.on('playerShotBow', () => this.bump('arrows', 'combat.shot_bow'));
    ev.on('pillared', (e) => {
      if (e.height > this.maxPillar) this.maxPillar = e.height;
      this.bump('pillars', `build.pillared ${e.height}`);
    });
    ev.on('explosion', (e) => {
      if (Math.hypot(e.x - game.player.position.x, e.z - game.player.position.z) < 8) this.bump('explosions', `world.explosion ${e.source}`);
    });
    ev.on('entityHurt', (e) => {
      if (e.source?.player && e.entity.data?.villager) this.bump('villagersHit', `social.threatened ${lfNpcId(String(e.entity.data.npcId ?? 'villager'))}`);
    });
    ev.on('playerMoved', (e) => {
      if (this.lastPos) {
        const d = Math.hypot(e.x - this.lastPos.x, e.z - this.lastPos.z);
        if (d < 8) this.add('distance', d);
      }
      this.lastPos = { x: e.x, z: e.z };
    });
    ev.on('rumourCreated', () => this.bump('rumoursAboutYou', 'lf.world.rumour'));
    ev.on('npcMakeover', (e) => this.bump('makeovers', `npc.makeover ${e.npc}`));

    game.save.register('wb_stats', () => this.toJSON(), (d: Partial<Saved>) => this.restore(d));
    setInterval(() => game.save.markDirty('wb_stats'), 20_000);
  }

  /** Lifetime total of a counter. */
  count(key: StatKey): number {
    return this.counts[key] ?? 0;
  }

  /** How many `key` events happened in the last `seconds` (up to 30 minutes). */
  within(key: StatKey, seconds: number): number {
    const since = Date.now() - seconds * 1000;
    let n = 0;
    for (let i = this.log.length - 1; i >= 0 && this.log[i].ts >= since; i--) if (this.log[i].key === key) n++;
    return n;
  }

  /** Recent signal-like strings, oldest first (the last `n`). */
  recent(n = 20): string[] {
    return this.recentSignals.slice(-n);
  }

  /** Records something the game measured elsewhere (quests, forge, rumours). */
  note(key: StatKey, detail: string, momentText?: string): void {
    this.bump(key, detail);
    if (momentText) this.moment(key, momentText);
  }

  /** Remembers a forged thing's name (Feathered Friend etc.). */
  noteForged(name: string): void {
    this.forgedNames.push(name);
    if (this.forgedNames.length > 30) this.forgedNames.shift();
    this.note('forged', `item.forged ${name}`, `Forged ${name}`);
  }

  /** Adds a journal moment (newest first, <= 30). */
  moment(kind: string, text: string): void {
    this.moments.unshift({ ts: Date.now(), text, kind });
    if (this.moments.length > 30) this.moments.length = 30;
  }

  /** Called on every counter change (achievements re-check, rumours). */
  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private add(key: StatKey, by: number): void {
    this.counts[key] = (this.counts[key] ?? 0) + by;
  }

  private bump(key: StatKey, detail: string): void {
    this.add(key, 1);
    const now = Date.now();
    this.log.push({ key, ts: now });
    while (this.log.length && this.log[0].ts < now - 30 * 60_000) this.log.shift();
    if (this.log.length > 3000) this.log.splice(0, this.log.length - 3000);
    this.pushRecent(detail);
    for (const fn of this.listeners) {
      try {
        fn(key, detail);
      } catch (err) {
        console.error('[stats] listener failed', err);
      }
    }
  }

  private pushRecent(s: string): void {
    // collapse repeats ("block.placed oak_planks ×12") so the 20 recent slots stay meaningful
    const last = this.recentSignals[this.recentSignals.length - 1];
    const m = last?.match(/^(.*?)(?: ×(\d+))?$/);
    if (m && m[1] === s) this.recentSignals[this.recentSignals.length - 1] = `${s} ×${(Number(m[2]) || 1) + 1}`;
    else this.recentSignals.push(s.slice(0, 120));
    if (this.recentSignals.length > 40) this.recentSignals.shift();
  }

  private toJSON(): Saved {
    return {
      counts: this.counts, kills: this.kills, deathCauses: this.deathCauses, talkedTo: [...this.talkedTo],
      forgedNames: this.forgedNames, maxPillar: this.maxPillar, moments: this.moments,
    };
  }

  private restore(d: Partial<Saved>): void {
    this.counts = { ...(d.counts ?? {}) };
    Object.assign(this.kills, d.kills ?? {});
    Object.assign(this.deathCauses, d.deathCauses ?? {});
    for (const t of d.talkedTo ?? []) this.talkedTo.add(t);
    this.forgedNames.push(...(d.forgedNames ?? []));
    this.maxPillar = d.maxPillar ?? 0;
    this.moments.push(...(d.moments ?? []));
  }
}

/** "fire_titan" → "Fire Titan". */
export function humanise(id: string): string {
  return id.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Display name of a villager id (or the id). */
export function npcLabel(id: string): string {
  return village.npc(id === 'captain_rowan' ? 'rowan' : id)?.def.name ?? humanise(id);
}

let stats: PlayerStats | null = null;

/** @internal */
export function initStats(game: Game): PlayerStats {
  stats = new PlayerStats(game);
  return stats;
}

/** The player's stats (after the WB plugin init). */
export function getStats(): PlayerStats {
  if (!stats) throw new Error('PlayerStats not initialised (journal/plugin.ts)');
  return stats;
}

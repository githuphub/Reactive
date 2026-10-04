/**
 * Dynamic quest objectives measured from Game events (registered into V3's quest tracker with
 * `quests.registerObjective`). Kinds, with `target` / `count`:
 *
 * | type | target | progress |
 * |---|---|---|
 * | `gather` | item ("wheat") | items in the inventory / count |
 * | `place` | region | blocks the player placed there since accepting / count |
 * | `build` | region | blocks placed there by anyone (player, Bram, a blueprint build) since accepting / count |
 * | `deliver` | "item@npc" ("wheat@mara") | talk to the npc with the items: they are handed over |
 * | `survive` | "night" | dawns since accepting / count |
 * | `kill`, `talk`, `explore`, `forge`, `fetch`, `repair` | | V3's built-in rules |
 *
 * Regions: "oakhollow" / "village", "bram_plot" / "plot", a building id ("mara_house"), a village post ("gate",
 * "well", "farm" ...), a zone id, or "x,y,z[,radius]". Per-quest counters are saved in the slot `wb_objectives`.
 */
import type { Quest } from '@liveforge/sdk';
import type { Game } from '../../../game/game';
import { findItem } from '../../../engine/items';
import { countItem, takeItem } from '../../../survival';
import { village } from '../../../village';
import { inVillage, lfNpcId } from '../../ids';
import type { Quests } from '../../quests';
import { zoneAt } from '../../signals';
import { npcLabel, type PlayerStats } from '../stats';

interface Tracked {
  quest: Quest;
  giver: string;
  acceptedAt: number;
  nightsAtAccept: number;
  counters: Record<string, number>;
  delivered: string[];
}

type Objective = Quest['objectives'][number];

export class ObjectiveTracker {
  private readonly tracked = new Map<string, Tracked>();

  constructor(private readonly game: Game, private readonly quests: Quests, private readonly stats: PlayerStats) {
    quests.onAccept((q, giver) => this.track(q, giver));
    quests.onComplete((q) => {
      this.tracked.delete(q.id);
      game.save.markDirty('wb_objectives');
    });
    game.save.register('wb_objectives', () => ({ tracked: [...this.tracked.values()] }), (d: { tracked?: Tracked[] }) => {
      for (const t of d.tracked ?? []) if (t?.quest?.id) this.tracked.set(t.quest.id, t);
    });

    game.events.on('blockPlaced', (e) => {
      if (!this.tracked.size || e.source === 'gen' || e.source === 'fluid' || e.source === 'support') return;
      for (const t of this.tracked.values()) {
        if (!quests.isActive(t.quest.id)) continue;
        for (const o of t.quest.objectives) {
          if (o.type === 'place' && e.source !== 'player') continue;
          if (o.type !== 'place' && o.type !== 'build') continue;
          if (!inRegion(game, o.target, e.x, e.y, e.z)) continue;
          t.counters[o.id] = (t.counters[o.id] ?? 0) + 1;
        }
      }
    });
    game.events.on('villagerTalk', (e) => this.tryDeliver(lfNpcId(e.npc)));
    game.events.on('npcReplied', (e) => this.tryDeliver(e.npc));
    setInterval(() => game.save.markDirty('wb_objectives'), 15_000);

    quests.registerObjective('gather', (o) => countItem(game, itemOf(o.target)) / need(o));
    quests.registerObjective('place', (o, q) => this.counter(q, o));
    quests.registerObjective('build', (o, q) => this.counter(q, o));
    quests.registerObjective('survive', (o, q) => {
      const t = this.tracked.get(q.id);
      return t ? (stats.count('nights') - t.nightsAtAccept) / need(o) : null;
    });
    quests.registerObjective('deliver', (o, q) => {
      const parsed = parseDeliver(o.target);
      if (!parsed) return null; // plain npc target: V3's "talked to them" rule
      const t = this.tracked.get(q.id);
      if (t?.delivered.includes(o.id)) return 1;
      return Math.min(0.9, countItem(game, parsed.item) / need(o));
    });
  }

  /** Quest ids this tracker measures. */
  has(questId: string): boolean {
    return this.tracked.has(questId);
  }

  private track(q: Quest, giver: string): void {
    this.tracked.set(q.id, { quest: q, giver, acceptedAt: Date.now(), nightsAtAccept: this.stats.count('nights'), counters: {}, delivered: [] });
    this.game.save.markDirty('wb_objectives');
  }

  private counter(q: Quest, o: Objective): number | null {
    const t = this.tracked.get(q.id);
    return t ? (t.counters[o.id] ?? 0) / need(o) : null;
  }

  /** Hands the items over when the player talks to the npc of a `deliver` objective. */
  private tryDeliver(npc: string): void {
    for (const t of this.tracked.values()) {
      if (!this.quests.isActive(t.quest.id)) continue;
      for (const o of t.quest.objectives) {
        if (o.type !== 'deliver' || t.delivered.includes(o.id)) continue;
        const d = parseDeliver(o.target);
        if (!d || lfNpcId(d.npc) !== npc) continue;
        const n = need(o);
        if (countItem(this.game, d.item) < n) {
          this.game.ui.toast(`${npcLabel(npc)} needs ${n} ${findItem(d.item)?.displayName ?? d.item} (you have ${countItem(this.game, d.item)})`, { kind: 'warn' });
          continue;
        }
        if (!takeItem(this.game, d.item, n)) continue;
        t.delivered.push(o.id);
        this.game.ui.toast(`Delivered ${n} ${findItem(d.item)?.displayName ?? d.item} to ${npcLabel(npc)}`, { kind: 'good' });
        void village.controller(npc)?.say('Oh, wonderful, thank you!', { emote: 'cheer', priority: 'schedule' });
        this.game.save.markDirty('wb_objectives');
      }
    }
  }
}

function need(o: Objective): number {
  return Math.max(1, o.count ?? 1);
}

function itemOf(target: string): string {
  const t = target.trim().toLowerCase();
  return findItem(t) ? t : village.normalizeItem(t);
}

/** "wheat@mara" → {item, npc}. */
function parseDeliver(target: string): { item: string; npc: string } | null {
  const m = /^\s*([^@]+?)\s*@\s*(.+?)\s*$/.exec(target);
  return m ? { item: itemOf(m[1]), npc: m[2].toLowerCase() } : null;
}

/** Is (x, y, z) inside the named objective region? */
export function inRegion(game: Game, target: string, x: number, y: number, z: number): boolean {
  const t = target.trim().toLowerCase();
  if (t === 'oakhollow' || t === 'village' || t === 'anywhere') return t === 'anywhere' || inVillage(x, z, game.villageSite);
  if (t === 'bram_plot' || t === 'plot' || t === 'build_site') {
    const p = village.plots[0];
    return !!p && x >= p.rect.x0 - 1 && x <= p.rect.x1 + 1 && z >= p.rect.z0 - 1 && z <= p.rect.z1 + 1;
  }
  const coords = t.split(',').map(Number);
  if (coords.length >= 3 && coords.every((n) => Number.isFinite(n))) {
    const r = coords[3] ?? 6;
    return Math.hypot(x - coords[0], y - coords[1], z - coords[2]) <= r;
  }
  const b = village.building(t);
  if (b) return x >= b.bounds.min[0] - 2 && x <= b.bounds.max[0] + 2 && z >= b.bounds.min[2] - 2 && z <= b.bounds.max[2] + 2;
  const post = village.posts[t];
  if (post && Math.hypot(x - post.x, z - post.z) <= 8) return true;
  return zoneAt(game, x, y, z) === t;
}

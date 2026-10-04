/**
 * RumourBook: every rumour the game knows about, from three sources, merged by id:
 *
 * - the server: `world.reactions` polls (`rumours[]` with `knownBy`, every 30 s and after big events) and
 *   `rumour.heard` directives (one per hop; the directive's `why` names the teller: "Pip told Mara (and embellished it)");
 * - the local rumour engine (offline, and the Demo button), see local.ts.
 *
 * A new holder becomes a `rumourSpread` game event (the gossip visualiser walks the teller over and shows bubbles);
 * a new rumour becomes `rumourCreated`. Saved in the slot `wb_rumours`.
 */
import type { Rumour } from '@liveforge/sdk';
import type { Game } from '../../../game/game';
import { village } from '../../../village';
import { lfNpcId } from '../../ids';
import '../events';

/** A rumour as the game keeps it. */
export interface LcRumour {
  id: string;
  content: string;
  /** 0 = pure fabrication, 1 = true. */
  truthfulness: number;
  /** 0-1 how hot it is. */
  heat: number;
  /** Manifest npc ids that know it, in the order they heard it. */
  knownBy: string[];
  /** Who started it (npc id), if known. */
  origin: string | null;
  /** Is it about the player? */
  aboutPlayer: boolean;
  createdAt: number;
  mutations: number;
  /** Earlier wordings, latest first. */
  history: string[];
  source: 'server' | 'local';
  /** Spread edges (who told whom), oldest first. */
  edges: { from: string | null; to: string; ts: number }[];
}

const MAX = 40;

export class RumourBook {
  private readonly rumours = new Map<string, LcRumour>();
  private readonly listeners = new Set<() => void>();
  private seq = 0;

  constructor(private readonly game: Game) {
    game.save.register('wb_rumours', () => ({ rumours: this.list().slice(0, 30) }), (d: { rumours?: LcRumour[] }) => {
      for (const r of d.rumours ?? []) if (r?.id && r.content) this.rumours.set(r.id, { ...r, edges: r.edges ?? [], history: r.history ?? [] });
    });
    // heat decays (half-life ~15 min); cold local rumours are forgotten
    setInterval(() => {
      let changed = false;
      for (const r of this.rumours.values()) {
        const h = Math.round(r.heat * 0.977 * 1000) / 1000; // per minute
        if (h !== r.heat) changed = true;
        r.heat = h;
        if (r.heat < 0.03 && r.source === 'local') this.rumours.delete(r.id);
      }
      if (changed) this.changed(false);
    }, 60_000);
  }

  /** Hottest first. */
  list(): LcRumour[] {
    return [...this.rumours.values()].sort((a, b) => b.heat - a.heat || b.createdAt - a.createdAt);
  }

  get(id: string): LcRumour | undefined {
    return this.rumours.get(id);
  }

  /** Called whenever the book changes (board, journal). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Merges a server rumour (from `world.reactions`). New holders become spread events unless `quiet` (the first
   * poll after connecting just syncs).
   */
  fromServer(r: Rumour, quiet = false): void {
    const known = (r.knownBy ?? []).map(lfNpcId);
    const cur = this.rumours.get(r.id);
    if (!cur) {
      const lr: LcRumour = {
        id: r.id, content: r.content, truthfulness: r.truthfulness, heat: r.heat, knownBy: [], origin: r.origin?.npc ? lfNpcId(r.origin.npc) : known[0] ?? null,
        aboutPlayer: !!r.about?.player || !r.about?.npc, createdAt: r.createdAt ?? Date.now(), mutations: r.mutations ?? 0, history: r.history ?? [],
        source: 'server', edges: [],
      };
      this.rumours.set(r.id, lr);
      this.trim();
      if (quiet) {
        lr.knownBy = known;
        this.changed(false);
        return;
      }
      lr.knownBy = known.slice(0, 1);
      this.game.events.emit('rumourCreated', { rumourId: r.id, content: r.content, origin: lr.origin, source: 'server' });
      for (const npc of known.slice(1)) this.hop(lr, lr.knownBy[lr.knownBy.length - 1] ?? null, npc, r.content, 'server');
      this.changed(true);
      return;
    }
    cur.heat = r.heat;
    cur.truthfulness = r.truthfulness;
    cur.mutations = r.mutations ?? cur.mutations;
    const fresh = known.filter((k) => !cur.knownBy.includes(k));
    if (quiet || !fresh.length) {
      if (r.content !== cur.content) this.reword(cur, r.content);
      for (const k of fresh) cur.knownBy.push(k);
      this.changed(false);
      return;
    }
    for (const npc of fresh) this.hop(cur, this.guessTeller(cur, npc), npc, r.content, 'server');
    this.changed(true);
  }

  /**
   * A `rumour.heard` directive: `npc` heard `content`. The teller is parsed from `why` ("Pip told Mara …"); "X
   * witnessed it" means X started it.
   */
  heard(npc: string, rumourId: string, content: string, heat: number | undefined, why: string | undefined): void {
    const to = lfNpcId(npc);
    const told = /^(.+?) told (.+?)(\s*\(.*\))?$/.exec(why ?? '');
    const teller = told ? idOfName(told[1]) : null;
    let r = this.rumours.get(rumourId);
    if (!r) {
      r = {
        id: rumourId, content, truthfulness: 1, heat: heat ?? 0.5, knownBy: [], origin: teller ?? to, aboutPlayer: true, createdAt: Date.now(),
        mutations: 0, history: [], source: 'server', edges: [],
      };
      this.rumours.set(rumourId, r);
      this.trim();
      if (!teller) {
        r.knownBy.push(to);
        this.game.events.emit('rumourCreated', { rumourId, content, origin: to, source: 'server' });
        this.changed(true);
        return;
      }
      r.knownBy.push(teller);
      this.game.events.emit('rumourCreated', { rumourId, content, origin: teller, source: 'server' });
    }
    if (heat !== undefined) r.heat = heat;
    if (r.knownBy.includes(to)) {
      if (content !== r.content) this.reword(r, content);
      this.changed(false);
      return;
    }
    this.hop(r, teller ?? this.guessTeller(r, to), to, content, 'server');
    this.changed(true);
  }

  /** Starts a local rumour (local engine / Demo). Returns it. */
  createLocal(content: string, origin: string, opts: { heat?: number; truthfulness?: number; aboutPlayer?: boolean } = {}): LcRumour {
    const r: LcRumour = {
      id: `lr_${Date.now().toString(36)}_${(this.seq++).toString(36)}`, content, truthfulness: opts.truthfulness ?? 1, heat: opts.heat ?? 0.8,
      knownBy: [origin], origin, aboutPlayer: opts.aboutPlayer ?? true, createdAt: Date.now(), mutations: 0, history: [], source: 'local', edges: [],
    };
    this.rumours.set(r.id, r);
    this.trim();
    this.game.events.emit('rumourCreated', { rumourId: r.id, content, origin, source: 'local' });
    this.changed(true);
    return r;
  }

  /** A local hop: `from` tells `to`, in `content` (new wording = a mutation). */
  spreadLocal(id: string, from: string, to: string, content: string): void {
    const r = this.rumours.get(id);
    if (!r || r.knownBy.includes(to)) return;
    if (content !== r.content) r.truthfulness = Math.max(0, Math.round((r.truthfulness - 0.15) * 100) / 100);
    r.heat = Math.min(1, r.heat + 0.03);
    this.hop(r, from, to, content, 'local');
    this.changed(true);
  }

  private hop(r: LcRumour, from: string | null, to: string, content: string, source: 'server' | 'local'): void {
    const previous = r.content;
    const mutated = content !== previous;
    if (mutated) this.reword(r, content);
    r.knownBy.push(to);
    r.edges.push({ from, to, ts: Date.now() });
    if (r.edges.length > 20) r.edges.shift();
    this.game.events.emit('rumourSpread', { rumourId: r.id, from, to, content, previous: mutated ? previous : null, mutated, source });
  }

  private reword(r: LcRumour, content: string): void {
    r.history.unshift(r.content);
    if (r.history.length > 8) r.history.length = 8;
    r.content = content;
    r.mutations++;
  }

  /** Best guess at who told `to`: the latest holder standing closest to them. */
  private guessTeller(r: LcRumour, to: string): string | null {
    const target = village.npc(to);
    let best: string | null = r.knownBy[r.knownBy.length - 1] ?? r.origin;
    let bestD = Infinity;
    if (target) {
      for (const k of r.knownBy) {
        const n = village.npc(k);
        if (!n) continue;
        const d = n.position.distanceTo(target.position);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
    }
    return best;
  }

  private trim(): void {
    if (this.rumours.size <= MAX) return;
    const cold = [...this.rumours.values()].sort((a, b) => a.heat - b.heat).slice(0, this.rumours.size - MAX);
    for (const r of cold) this.rumours.delete(r.id);
  }

  private changed(important: boolean): void {
    if (important) this.game.save.markDirty('wb_rumours');
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.error('[rumours] listener failed', err);
      }
    }
  }
}

/** "Captain Rowan" → "captain_rowan" (manifest id), or null. */
export function idOfName(name: string): string | null {
  const n = village.npc(name.trim());
  return n ? lfNpcId(n.def.id) : null;
}

/**
 * Rumours (lane WB): the rumour book, the server sync, the local rumour engine, gossip scenes and the rumour board.
 *
 * - Online: `world.reactions {zone, npcs}` every 30 s and after big events (`refresh()`), plus `rumour.heard`
 *   directives (taken over from the plain "Have you heard?" line via `hub.onRumourHeard`).
 * - Offline: the local engine starts rumours from big Game events and spreads them with template mutations.
 * - `startDemoRumour()`: the Demo panel's "📜 Start a rumour" (a juicy signal for the server + a local rumour that
 *   reaches 3 villagers in ~30 s).
 */
import type { Directive } from '@liveforge/sdk';
import type { Game } from '../../../game/game';
import { getHub, playerTitle } from '../../hub';
import { FACTION, LF_NAMED } from '../../ids';
import type { LiveforgeService } from '../../service';
import { RumourBoard } from './board';
import { Gossip } from './gossip';
import { LocalRumourEngine } from './local';
import { RumourBook } from './rumours';

export { RumourBook, type LcRumour } from './rumours';
export { mutateRumour } from './local';

export class Rumours {
  readonly book: RumourBook;
  readonly gossip: Gossip;
  readonly engine: LocalRumourEngine;
  readonly board: RumourBoard;
  /** Villager attitudes toward the player from the last `world.reactions` answer (npc id → -1..1). */
  attitudes: Record<string, number> = {};
  private synced = false;
  private lastPoll = 0;
  private polling = false;

  constructor(private readonly game: Game, private readonly lf: LiveforgeService, openJournal: (tab: string) => void) {
    this.book = new RumourBook(game);
    this.gossip = new Gossip(game, lf);
    this.engine = new LocalRumourEngine(game, lf, this.book, () => this.gossip.busy);
    this.board = new RumourBoard(game, this.book, () => openJournal('rumours'), () => this.refresh());

    getHub().onRumourHeard = (d: Directive) => {
      const a = d.args as { npc?: string; rumourId?: string; content?: string; heat?: number };
      if (!a.npc || !a.rumourId || !a.content) return false;
      this.book.heard(a.npc, a.rumourId, a.content, a.heat, d.why);
      return true;
    };

    setInterval(() => void this.poll(), 30_000);
    lf.on('online', () => {
      this.synced = false;
      void this.poll();
    });
    lf.on('status', (s) => {
      if (s !== 'online') this.synced = false;
    });
    // important events: poll a little later (the server needs the signals first)
    const soon = () => setTimeout(() => this.refresh(), 2500);
    game.events.on('villageDamaged', soon);
    game.events.on('playerDied', soon);
    game.events.on('phaseChanged', (e) => {
      if (e.phase === 'dawn') soon();
    });
  }

  /** Asks the server for rumours now (throttled to one per 5 s; no-op offline). */
  refresh(): void {
    if (performance.now() - this.lastPoll < 5000) return;
    void this.poll();
  }

  /** Demo: a juicy rumour that forms at once and spreads across 3 villagers within ~30 s. */
  startDemoRumour(): void {
    const p = playerTitle();
    // the server forms its own rumour from the signal (economy.stole is a rumour source), seen by Pip
    this.lf.signal('economy.stole', { from: 'mara', item: 'pie', value: 2, seen: true, witnesses: ['pip'] });
    void this.lf.client.flush().catch(() => {});
    this.engine.start(`${p.charAt(0).toUpperCase()}${p.slice(1)} pinched a pie from Mara's windowsill!`, 'pip', 0.95, 0.9);
    getHub().caption('📜 Pip saw something juicy… watch it spread (and grow) through Oakhollow', 7);
    setTimeout(() => this.refresh(), 3000);
  }

  private async poll(): Promise<void> {
    if (!this.lf.online || this.polling || !this.game.ready) return;
    this.polling = true;
    this.lastPoll = performance.now();
    try {
      const r = await this.lf.ask('world.reactions', { zone: FACTION, npcs: [...LF_NAMED] }, { upgrade: false, timeoutMs: 5000 }).instant;
      const quiet = !this.synced;
      for (const rumour of r.result.rumours ?? []) this.book.fromServer(rumour, quiet);
      this.attitudes = { ...this.attitudes, ...(r.result.attitudes ?? {}) };
      this.synced = true;
    } catch {
      /* offline or module off: the local engine covers it */
    } finally {
      this.polling = false;
    }
  }
}

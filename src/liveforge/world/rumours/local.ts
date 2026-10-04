/**
 * The local rumour engine (offline rules, and the Demo button): big Game events become rumours about the player, and
 * every few seconds the hottest rumour hops to a villager who hasn't heard it, often in new words (templates that
 * exaggerate numbers, escalate verbs, add hedges and each villager's way of telling things).
 *
 * Online, the server's world module forms and spreads rumours itself, so the engine only starts rumours while
 * Reactive is offline (or when asked to by `start()`); it always keeps spreading its own local rumours.
 */
import type { Game } from '../../../game/game';
import { village } from '../../../village';
import { playerTitle } from '../../hub';
import { inVillage, lfNpcId } from '../../ids';
import type { LiveforgeService } from '../../service';
import { zoneAt } from '../../signals';
import { npcLabel } from '../stats';
import type { LcRumour, RumourBook } from './rumours';
import '../events';

/** Villagers who pass rumours on (the golem doesn't gossip). */
const GOSSIPS = ['pip', 'mara', 'bram', 'hilde', 'captain_rowan'];

/** How each villager retells a rumour. */
const VOICE: Record<string, string[]> = {
  pip: ['In confidence: ', 'You did NOT hear this from me, but ', 'Oh! Oh! '],
  mara: ['Bless me, ', 'Well I never, ', 'Mark my words, '],
  bram: ['Between you and me, ', 'Funny thing, ', ''],
  hilde: ['Hmph. ', 'Mind you, ', ''],
  captain_rowan: ['Report: ', 'For the record, ', 'Eyes open: '],
};

const HEDGES = /^(I heard |Apparently |Word is |They say |In confidence: |You did NOT hear this from me, but |Oh! Oh! |Bless me, |Well I never, |Mark my words, |Between you and me, |Funny thing, |Hmph\. |Mind you, |Report: |For the record, |Eyes open: )+/i;

/** Verb / noun escalations, applied one per retelling. */
const ESCALATE: [RegExp, string][] = [
  [/\bbroke a hole in\b/i, 'smashed up'],
  [/\bsmashed up\b/i, 'wrecked'],
  [/\bwrecked\b/i, 'flattened half of'],
  [/\bpinched a pie\b/i, 'stole three pies'],
  [/\bstole three pies\b/i, 'made off with a whole cartload of pies'],
  [/\bcut down\b/i, 'slaughtered'],
  [/\bslew\b/i, 'single-handedly slew'],
  [/\bsomething big\b/i, 'a castle'],
  [/\ba castle\b/i, 'a castle with a moat'],
  [/\btalked (.+?) down on prices\b/i, 'swindled $1 out of a fortune'],
  [/\bhelped\b/i, 'saved'],
  [/\bfell\b/i, 'came a cropper'],
  [/\bforged\b/i, 'conjured'],
];

const TAILS = [' At midnight, no less!', ' And laughed about it!', ' Bold as brass!', ' With their bare hands!', ' I saw it myself. Well, nearly.', ' Twice!'];

/** Retells `text` as `teller`: one escalation (or a doubled number, or a tail), plus their voice. */
export function mutateRumour(text: string, teller: string, rnd: () => number = Math.random): string {
  let core = text.replace(HEDGES, '');
  core = core.charAt(0).toUpperCase() + core.slice(1);
  let next = core;
  for (const [re, to] of ESCALATE) {
    if (re.test(next)) {
      next = next.replace(re, to);
      break;
    }
  }
  if (next === core) {
    const num = /\b(\d+)\b/.exec(next);
    if (num) next = next.replace(num[0], String(Number(num[1]) * 2 + (rnd() < 0.5 ? 1 : 0)));
    else if (!TAILS.some((t) => next.endsWith(t))) next = `${next.replace(/[.!]*$/, '!')}${TAILS[Math.floor(rnd() * TAILS.length)]}`;
  }
  const voices = VOICE[teller] ?? [''];
  const v = voices[Math.floor(rnd() * voices.length)];
  const out = v ? `${v}${next.charAt(0).toLowerCase()}${next.slice(1)}` : next;
  return out.slice(0, 180);
}

export class LocalRumourEngine {
  /** Seconds between local hops (≈ 3 hops in 30 s for the demo). */
  spreadEvery = 9;
  /** A rumour stops spreading after this many holders. */
  maxHolders = 4;
  /** Chance a retelling changes the wording. */
  mutationChance = 0.65;
  private lastSpread = 0;
  private readonly cooldown = new Map<string, number>();

  constructor(private readonly game: Game, private readonly lf: LiveforgeService, private readonly book: RumourBook, private readonly busy: () => boolean) {
    const ev = game.events;
    const p = () => playerTitle();
    ev.on('villageDamaged', (e) => {
      if (!this.ready(`grief:${e.buildingId}`, 300)) return;
      const owner = lfNpcId(e.owner);
      this.offline(`${cap(p())} broke a hole in ${npcLabel(owner)}'s house!`, owner, 0.9, 0.95);
    });
    ev.on('blockPlaced', (e) => {
      if (e.source !== 'player' || !inVillage(e.x, e.z, game.villageSite)) return;
      this.placed.push(Date.now());
      const since = Date.now() - 180_000;
      while (this.placed.length && this.placed[0] < since) this.placed.shift();
      if (this.placed.length >= 20 && this.ready('build', 600)) {
        const zone = zoneAt(game, e.x, e.y, e.z);
        const where = zone === 'bram_plot' ? "Bram's plot" : zone === 'farm' ? 'the farm' : zone === 'smithy' ? 'the smithy' : 'the plaza';
        this.offline(`${cap(p())} is building something big near ${where}.`, this.witness(e.x, e.z), 0.6, 1);
      }
    });
    ev.on('playerDied', (e) => {
      if (!this.ready('death', 240)) return;
      const pos = game.player.position;
      if (!inVillage(pos.x, pos.z, game.villageSite) && Math.hypot(pos.x - (game.villageSite?.x ?? 0), pos.z - (game.villageSite?.z ?? 0)) > 80) return;
      this.offline(`${cap(p())} fell ${deathPhrase(e.cause)}, right in front of everyone.`, this.witness(pos.x, pos.z), 0.7, 0.9);
    });
    ev.on('mobKilled', (e) => {
      if (!e.byPlayer) return;
      this.kills.push(Date.now());
      const since = Date.now() - 120_000;
      while (this.kills.length && this.kills[0] < since) this.kills.shift();
      if (this.kills.length >= 6 && this.ready('kills', 600)) {
        const pos = game.player.position;
        this.offline(`${cap(p())} cut down ${this.kills.length} ${e.type.replace(/_/g, ' ')}s in one go.`, this.witness(pos.x, pos.z), 0.7, 1);
      }
    });
    ev.on('haggled', (e) => {
      if (e.accepted && this.ready(`haggle:${e.npc}`, 600)) this.offline(`${cap(p())} talked ${npcLabel(lfNpcId(e.npc))} down on prices.`, lfNpcId(e.npc), 0.5, 1);
    });
    setInterval(() => this.tick(), 1000);
  }

  private readonly placed: number[] = [];
  private readonly kills: number[] = [];

  /** Starts a rumour now (Demo button), whatever the connection. */
  start(content: string, origin: string, heat = 0.95, truthfulness = 1): LcRumour {
    this.lastSpread = Date.now() - (this.spreadEvery - 4) * 1000; // first hop ~4 s later
    return this.book.createLocal(content, origin, { heat, truthfulness });
  }

  /** Called when a quest for a villager completes (a kind rumour). */
  helped(giver: string, title: string): void {
    if (this.ready(`helped:${giver}`, 300)) this.offline(`${cap(playerTitle())} helped ${npcLabel(giver)} (${title.toLowerCase()}).`, giver, 0.6, 1);
  }

  private offline(content: string, origin: string, heat: number, truthfulness: number): void {
    if (this.lf.online) return; // the server's world module forms rumours from the same signals
    this.start(content, origin, heat, truthfulness);
  }

  private ready(key: string, seconds: number): boolean {
    const now = Date.now();
    if ((this.cooldown.get(key) ?? 0) > now) return false;
    this.cooldown.set(key, now + seconds * 1000);
    return true;
  }

  /** The named villager closest to (x, z): the witness. */
  private witness(x: number, z: number): string {
    let best = 'pip';
    let bestD = Infinity;
    for (const id of GOSSIPS) {
      const n = village.npc(id);
      if (!n) continue;
      const d = Math.hypot(n.position.x - x, n.position.z - z);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  /** One local hop every `spreadEvery` seconds (while the visualiser is free). */
  private tick(): void {
    if (!this.game.ready || this.busy()) return;
    if (Date.now() - this.lastSpread < this.spreadEvery * 1000) return;
    const r = this.book.list().find((x) => x.source === 'local' && x.heat > 0.15 && x.knownBy.length < this.maxHolders && GOSSIPS.some((g) => !x.knownBy.includes(g) && village.npc(g)));
    if (!r) return;
    const player = this.game.player.position;
    // teller: the holder nearest the player (so the hop is on camera); listener: the non-holder nearest the teller
    const tellers = r.knownBy.filter((k) => GOSSIPS.includes(k) && village.npc(k));
    if (!tellers.length) return;
    tellers.sort((a, b) => village.npc(a)!.position.distanceTo(player) - village.npc(b)!.position.distanceTo(player));
    const from = tellers[0];
    const fromNpc = village.npc(from)!;
    const listeners = GOSSIPS.filter((g) => !r.knownBy.includes(g) && village.npc(g));
    listeners.sort((a, b) => village.npc(a)!.position.distanceTo(fromNpc.position) - village.npc(b)!.position.distanceTo(fromNpc.position));
    const to = listeners[0];
    if (!to) return;
    this.lastSpread = Date.now();
    const content = Math.random() < this.mutationChance ? mutateRumour(r.content, from) : r.content;
    this.book.spreadLocal(r.id, from, to, content);
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function deathPhrase(cause: string): string {
  const c = cause.toLowerCase();
  if (c.includes('fall')) return 'off a ledge';
  if (c.includes('explo') || c.includes('creeper')) return 'to a creeper';
  if (c.includes('lava') || c.includes('fire') || c.includes('burn')) return 'into the fire';
  if (c.includes('drown')) return 'in the well';
  if (c.includes('starv')) return 'over from hunger';
  return 'in a fight';
}

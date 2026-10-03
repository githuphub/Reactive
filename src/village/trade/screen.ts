/**
 * Trade screen: a villager's offers priced in coins at the current multiplier, live price updates
 * when the village posture changes prices, and a Haggle button that calls the village's haggle
 * hook (V3 wires it to Liveforge; the default is a rules-based haggle).
 */
import { findItem } from '../../engine/items';
import type { Game } from '../../game/game';
import { el, type Screen } from '../../ui/ui';
import { COINS } from '../items';
import type { Npc } from '../npc/npc';
import { injectVillageStyles } from '../ui/styles';
import { OFFERS, priceAt, type TradeOffer } from './offers';

export interface HaggleRequest {
  npc: Npc;
  /** The offer being looked at, if any. */
  offer: TradeOffer | null;
  /** Multiplier currently in force for this session. */
  multiplier: number;
  /** Haggles already tried this session. */
  attempts: number;
}

export interface HaggleResult {
  accepted: boolean;
  /** New multiplier for this session (defaults to −10% when accepted). */
  multiplier?: number;
  /** What the villager says. */
  line?: string;
}

export type HaggleHandler = (req: HaggleRequest) => Promise<HaggleResult | void> | HaggleResult | void;

export interface TradeSession {
  npc: Npc;
  multiplier: number;
  /** Resolves with a one-line summary when the screen closes. */
  closed: Promise<string>;
}

export interface TradeHost {
  readonly game: Game;
  /** Village-wide multiplier (posture). */
  readonly priceMult: number;
  haggle(req: HaggleRequest): Promise<HaggleResult>;
}

export class TradeScreen {
  private screen: Screen | null = null;
  private session: { npc: Npc; base: number | null; haggle: number; attempts: number; done: string[]; resolve: (s: string) => void; lastOffer: TradeOffer | null } | null = null;
  private rows: { offer: TradeOffer; price: HTMLElement; btn: HTMLButtonElement }[] = [];
  private coinsEl: HTMLElement | null = null;
  private multEl: HTMLElement | null = null;
  private lineEl: HTMLElement | null = null;
  private haggleBtn: HTMLButtonElement | null = null;
  private offInv: (() => void) | null = null;

  constructor(private readonly host: TradeHost) {
    injectVillageStyles();
  }

  get isOpen(): boolean {
    return this.screen !== null;
  }

  /** The multiplier in force for the open session. */
  get multiplier(): number {
    const s = this.session;
    if (!s) return this.host.priceMult;
    return (s.base ?? this.host.priceMult) * s.haggle;
  }

  /** Opens the trade screen for a trader. Returns null if the villager has no offers. */
  open(npc: Npc, opts: { priceMultiplier?: number } = {}): TradeSession | null {
    const offers = OFFERS[npc.def.id];
    if (!offers?.length) return null;
    this.close();
    const game = this.host.game;
    let resolve!: (s: string) => void;
    const closed = new Promise<string>((r) => (resolve = r));
    const base = typeof opts.priceMultiplier === 'number' && Number.isFinite(opts.priceMultiplier) ? Math.max(0.25, Math.min(4, opts.priceMultiplier)) : null;
    this.session = { npc, base, haggle: 1, attempts: 0, done: [], resolve, lastOffer: null };

    const root = el('div');
    const panel = el('div', 'lc-panel lcv-trade');
    panel.appendChild(el('h2', undefined, `${npc.def.name} · ${npc.def.role}`));
    const head = el('div', 'lcv-trade-head');
    const coins = el('span', 'lcv-coins');
    const coinIcon = el('canvas');
    coinIcon.width = coinIcon.height = 32;
    game.icons.drawInto(coinIcon, COINS);
    const coinCount = el('span');
    coins.append(coinIcon, coinCount);
    this.coinsEl = coinCount;
    this.multEl = el('span', 'lcv-mult');
    head.append(coins, this.multEl);
    panel.appendChild(head);
    const list = el('div', 'lcv-offers');
    this.rows = offers.map((offer) => {
      const row = el('div', 'lcv-offer');
      const give = offer.kind === 'buy' ? COINS : offer.item;
      const get = offer.kind === 'buy' ? offer.item : COINS;
      const icon = (item: string) => {
        const c = el('canvas');
        c.width = c.height = 32;
        game.icons.drawInto(c, item);
        c.title = findItem(item)?.displayName ?? item;
        return c;
      };
      const giveLabel = el('span');
      const getLabel = el('span');
      const name = findItem(offer.item)?.displayName ?? offer.item;
      const price = el('span');
      if (offer.kind === 'buy') {
        giveLabel.appendChild(price);
        getLabel.textContent = `${offer.count} ${name}`;
      } else {
        giveLabel.textContent = `${offer.count} ${name}`;
        getLabel.appendChild(price);
      }
      const btn = el('button', 'lc-btn', offer.kind === 'buy' ? 'Buy' : 'Sell');
      btn.addEventListener('click', () => this.deal(offer));
      btn.addEventListener('mouseenter', () => this.session && (this.session.lastOffer = offer));
      row.append(icon(give), giveLabel, el('span', 'lcv-arrow', '→'), icon(get), getLabel, btn);
      list.appendChild(row);
      return { offer, price, btn };
    });
    panel.appendChild(list);
    this.lineEl = el('div', 'lcv-trade-line', npc.def.greeting);
    panel.appendChild(this.lineEl);
    const foot = el('div', 'lcv-trade-foot');
    const haggle = el('button', 'lc-btn', 'Haggle');
    haggle.addEventListener('click', () => void this.doHaggle());
    this.haggleBtn = haggle;
    const close = el('button', 'lc-btn', 'Close');
    close.addEventListener('click', () => this.close());
    foot.append(haggle, close);
    panel.appendChild(foot);
    root.appendChild(panel);

    const screen: Screen = {
      id: 'trade',
      el: root,
      pausesGame: false,
      onKey: (e) => {
        if (e.code === 'KeyE') {
          this.close();
          return true;
        }
        return false;
      },
      onClose: () => this.finish(),
    };
    this.screen = screen;
    game.ui.screens.open(screen);
    this.offInv = game.events.on('inventoryChanged', () => this.refresh());
    this.refresh();
    npc.lookAtTarget(game.player, 6);
    return { npc, multiplier: this.multiplier, closed };
  }

  close(): void {
    if (this.screen) this.host.game.ui.screens.close(this.screen);
  }

  /** Re-prices every row (call after multiplier changes). */
  refresh(): void {
    const s = this.session;
    if (!s || !this.coinsEl || !this.multEl) return;
    const inv = this.host.game.inventory;
    const have = inv.count(COINS);
    this.coinsEl.textContent = String(have);
    const m = this.multiplier;
    this.multEl.textContent = `prices ×${m.toFixed(2)}`;
    this.multEl.className = `lcv-mult${m > 1.02 ? ' up' : m < 0.98 ? ' down' : ''}`;
    for (const r of this.rows) {
      const p = priceAt(r.offer, m);
      r.price.textContent = `${p} coins`;
      r.btn.disabled = r.offer.kind === 'buy' ? have < p : inv.count(r.offer.item) < r.offer.count;
    }
    if (this.haggleBtn) this.haggleBtn.disabled = s.attempts >= 3;
  }

  private deal(offer: TradeOffer): void {
    const s = this.session;
    if (!s) return;
    const game = this.host.game;
    const inv = game.inventory;
    const m = this.multiplier;
    const price = priceAt(offer, m);
    if (offer.kind === 'buy') {
      if (inv.count(COINS) < price) return this.say("You're short a few coins.");
      inv.remove(COINS, price);
      const left = inv.add({ item: offer.item, count: offer.count });
      if (left > 0) inv.add({ item: COINS, count: price });
      if (left > 0) return this.say('Your pockets are full!');
    } else {
      if (inv.count(offer.item) < offer.count) return this.say(`Bring me ${offer.count} first.`);
      inv.remove(offer.item, offer.count);
      inv.add({ item: COINS, count: price });
    }
    s.done.push(`${offer.kind === 'buy' ? 'bought' : 'sold'} ${offer.count} ${offer.item} for ${price} coins`);
    s.npc.playEmote('nod', 0.8);
    game.events.emit('traded', { npc: s.npc.def.id, item: offer.item, count: offer.count, price, kind: offer.kind, multiplier: m });
    this.say(pick(THANKS));
    this.refresh();
  }

  private async doHaggle(): Promise<void> {
    const s = this.session;
    if (!s || s.attempts >= 3) return;
    s.attempts++;
    if (this.haggleBtn) this.haggleBtn.disabled = true;
    this.say('…');
    const res = await this.host.haggle({ npc: s.npc, offer: s.lastOffer, multiplier: this.multiplier, attempts: s.attempts });
    if (this.session !== s) return;
    if (res.accepted) {
      const next = res.multiplier ?? this.multiplier * 0.9;
      const base = s.base ?? this.host.priceMult;
      s.haggle = Math.max(0.3, next / Math.max(0.01, base));
    }
    this.say(res.line ?? (res.accepted ? 'Fine. A little off, just for you.' : 'Those are fair prices.'));
    this.host.game.events.emit('haggled', { npc: s.npc.def.id, accepted: res.accepted, multiplier: this.multiplier, line: res.line });
    this.refresh();
  }

  private say(line: string): void {
    if (this.lineEl) this.lineEl.textContent = line;
  }

  private finish(): void {
    const s = this.session;
    this.offInv?.();
    this.offInv = null;
    this.screen = null;
    this.session = null;
    this.rows = [];
    if (s) s.resolve(s.done.length ? s.done.join('; ') : 'closed the trade without a deal');
  }
}

const THANKS = ['Pleasure doing business.', 'A fair deal.', 'Come again!', "That'll serve you well."];

function pick<T>(a: T[]): T {
  return a[Math.floor(Math.random() * a.length)];
}

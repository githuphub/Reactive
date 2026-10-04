/**
 * Gossip visualisation: each rumour hop plays as a small scene the camera can read.
 *
 * 1. The teller walks over to the listener (or just turns, when close), both look at each other.
 * 2. The teller says the rumour, in the words of this retelling (speech bubble), while 💬 particles travel from the
 *    teller's head to the listener's.
 * 3. The listener reacts (an emote) with a thought bubble of what they now believe.
 * 4. A Brain entry: `rumour: "<text>" Pip → Mara (mutated: "<before>")`.
 *
 * Hops queue up and play one at a time (throttled), so a burst of server spreads still reads clearly on video. Hops
 * far from the player only write the Brain entry.
 */
import type { Game } from '../../../game/game';
import { village, type Npc } from '../../../village';
import { getHub } from '../../hub';
import type { LiveforgeService } from '../../service';
import { npcLabel } from '../stats';
import type { RumourSpreadEvent } from '../events';
import { injectWorldStyles } from '../styles';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const VISIBLE_RANGE = 56;

interface Floater {
  el: HTMLElement;
  /** World anchor (re-read every frame). */
  at: () => { x: number; y: number; z: number } | null;
  until: number;
  /** Particle flight: from → to over [t0, t1]. */
  flight?: { from: () => { x: number; y: number; z: number } | null; t0: number; t1: number };
}

export class Gossip {
  /** Minimum ms between two hop scenes. */
  gapMs = 1200;
  private readonly layer: HTMLElement;
  private readonly floaters = new Set<Floater>();
  private readonly queue: RumourSpreadEvent[] = [];
  private playing = false;
  private raf = 0;

  constructor(private readonly game: Game, private readonly lf: LiveforgeService) {
    injectWorldStyles();
    this.layer = document.createElement('div');
    this.layer.className = 'wbw-gossip';
    game.ui.hud.appendChild(this.layer);
    game.events.on('rumourSpread', (e) => this.enqueue(e));
    game.events.on('rumourCreated', (e) => {
      const who = e.origin ? npcLabel(e.origin) : 'someone';
      this.lf.think({ source: 'rumours', actor: e.origin ?? 'reactions', kind: 'thought', text: `new rumour (${who}): "${e.content}"`, model: 'rules' });
      const n = e.origin ? village.npc(e.origin) : undefined;
      if (n && this.near(n)) {
        this.bubble(n, `💭 ${e.content}`, 'thought', 5);
        void n.controller.emote('think', { priority: 'schedule' });
      }
    });
  }

  /** True while a scene plays or waits (the local engine holds its next hop). */
  get busy(): boolean {
    return this.playing || this.queue.length > 0;
  }

  private enqueue(e: RumourSpreadEvent): void {
    this.queue.push(e);
    // a burst: older hops only get their Brain entry
    while (this.queue.length > 5) this.brain(this.queue.shift()!);
    if (!this.playing) void this.drain();
  }

  private async drain(): Promise<void> {
    this.playing = true;
    try {
      while (this.queue.length) {
        const e = this.queue.shift()!;
        try {
          await this.play(e);
        } catch (err) {
          console.warn('[gossip] scene failed', err);
        }
        await sleep(this.gapMs);
      }
    } finally {
      this.playing = false;
    }
  }

  private async play(e: RumourSpreadEvent): Promise<void> {
    this.brain(e);
    const from = e.from ? village.npc(e.from) : undefined;
    const to = village.npc(e.to);
    if (!to || !from || from === to || (!this.near(from) && !this.near(to))) return;
    getHub().caption(`🗣 ${from.def.name} → ${to.def.name}: “${short(e.content, 90)}”`, 6);
    // 1. walk over (or turn)
    const d = from.position.distanceTo(to.position);
    const agentBusy = from.controller.busy && from.controller.agentControlled;
    if (d > 3.5 && !agentBusy) {
      await Promise.race([from.controller.walkTo(to, { run: d > 10, reach: 2.2 }), sleep(d > 10 ? 7000 : 4500)]);
    }
    void from.controller.lookAt(to, { priority: 'schedule' });
    void to.controller.lookAt(from, { priority: 'schedule' });
    // 2. the telling
    void from.controller.say(e.content, { priority: 'schedule', seconds: 4.5 });
    for (let i = 0; i < 6; i++) this.particle(from, to, i * 230);
    await sleep(1500);
    // 3. the listener's reaction
    const bad = /\b(broke|smash|wreck|flatten|stole|pinch|made off|swindl|fell|slaughter|hole)\w*/i.test(e.content);
    void to.controller.emote(bad ? 'shake' : 'laugh', { priority: 'schedule' });
    this.bubble(to, `💭 ${short(e.content, 110)}`, 'thought', 5);
    if (e.mutated && e.previous) this.bubble(from, `✏️ was: “${short(e.previous, 70)}”`, 'note', 4);
    await sleep(2600);
  }

  private brain(e: RumourSpreadEvent): void {
    const who = `${e.from ? npcLabel(e.from) : '?'} → ${npcLabel(e.to)}`;
    this.lf.think({
      source: 'rumours', actor: e.from ?? e.to, kind: 'line', model: 'rules',
      text: `rumour: "${e.content}" ${who}${e.mutated && e.previous ? ` (mutated: "${e.previous}")` : ''}`,
      data: { rumourId: e.rumourId, from: e.from, to: e.to, mutated: e.mutated, previous: e.previous, source: e.source },
    });
  }

  private near(n: Npc): boolean {
    return n.position.distanceTo(this.game.player.position) < VISIBLE_RANGE;
  }

  /** A thought / note bubble over a villager's head (separate from their speech bubble). */
  private bubble(n: Npc, text: string, kind: 'thought' | 'note', seconds: number): void {
    const el = document.createElement('div');
    el.className = `wbw-bubble wbw-${kind}`;
    el.textContent = text;
    this.add({ el, at: () => head(n, kind === 'thought' ? 0.95 : 1.35), until: performance.now() + seconds * 1000 });
  }

  /** One 💬 flying from the teller's head to the listener's. */
  private particle(from: Npc, to: Npc, delayMs: number): void {
    const el = document.createElement('div');
    el.className = 'wbw-particle';
    el.textContent = Math.random() < 0.25 ? '❗' : '💬';
    const t0 = performance.now() + delayMs;
    this.add({ el, at: () => head(to, 0.2), until: t0 + 1100, flight: { from: () => head(from, 0.2), t0, t1: t0 + 1100 } });
  }

  private add(f: Floater): void {
    f.el.style.display = 'none';
    this.layer.appendChild(f.el);
    this.floaters.add(f);
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  private frame(): void {
    this.raf = 0;
    const now = performance.now();
    for (const f of this.floaters) {
      if (now > f.until) {
        f.el.remove();
        this.floaters.delete(f);
        continue;
      }
      const b = f.at();
      if (!b) continue;
      let x: number, y: number, ok: boolean;
      const sb = this.game.worldToScreen(b.x, b.y, b.z);
      if (f.flight) {
        if (now < f.flight.t0) {
          f.el.style.display = 'none';
          continue;
        }
        const a = f.flight.from();
        if (!a) continue;
        const sa = this.game.worldToScreen(a.x, a.y, a.z);
        const t = Math.min(1, (now - f.flight.t0) / (f.flight.t1 - f.flight.t0));
        const e = t * t * (3 - 2 * t);
        x = sa.x + (sb.x - sa.x) * e;
        y = sa.y + (sb.y - sa.y) * e - Math.sin(Math.PI * t) * 46;
        ok = sa.visible || sb.visible;
        f.el.style.opacity = String(t < 0.85 ? 1 : (1 - t) / 0.15);
      } else {
        x = sb.x;
        y = sb.y;
        ok = sb.visible && sb.distance < VISIBLE_RANGE;
      }
      f.el.style.display = ok ? '' : 'none';
      f.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    }
    if (this.floaters.size) this.raf = requestAnimationFrame(() => this.frame());
  }
}

/** A point above a villager's head. */
function head(n: Npc, above: number): { x: number; y: number; z: number } | null {
  if (n.removed) return null;
  return { x: n.position.x, y: n.position.y + n.height + above, z: n.position.z };
}

function short(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

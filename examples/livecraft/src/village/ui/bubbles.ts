/**
 * 3D-anchored DOM overlays: villager name tags with speech bubbles (typewriter text) and static
 * world labels (e.g. Bram's plot sign). Positions follow `game.worldToScreen` every frame.
 */
import type { Game } from '../../game/game';
import type { Vec3Like } from '../nav';
import { injectVillageStyles } from './styles';

export interface SayOptions {
  /** How long the full line stays up after typing (default depends on length). */
  seconds?: number;
  /** Render as an emote line ("*waves*"). */
  emote?: boolean;
  /** Characters per second for the typewriter (default 38). */
  cps?: number;
}

/** A name tag plus speech bubble above one villager. */
export class Bubble {
  readonly el: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly bubbleEl: HTMLElement;
  private text = '';
  private shown = 0;
  private cps = 38;
  private hold = 0;
  private resolve: (() => void) | null = null;
  removed = false;

  constructor(private readonly layer: BubbleLayer, readonly anchor: () => Vec3Like, name: string, role?: string) {
    this.el = document.createElement('div');
    this.el.className = 'lcv-tag';
    this.bubbleEl = document.createElement('div');
    this.bubbleEl.className = 'lcv-bubble lcv-hidden';
    this.nameEl = document.createElement('div');
    this.nameEl.className = 'lcv-name';
    this.el.append(this.bubbleEl, this.nameEl);
    this.setName(name, role);
  }

  setName(name: string, role?: string): void {
    this.nameEl.textContent = name;
    if (role) {
      const s = document.createElement('small');
      s.textContent = role;
      this.nameEl.appendChild(s);
    }
  }

  /** True while a line is typing or being held on screen. */
  get speaking(): boolean {
    return this.text !== '';
  }

  /** Shows a line with a typewriter effect; resolves when it has been read (or replaced). */
  say(text: string, opts: SayOptions = {}): Promise<void> {
    this.finish();
    this.text = opts.emote ? `*${text.replace(/^\*|\*$/g, '')}*` : text;
    this.shown = 0;
    this.cps = opts.cps ?? 38;
    this.hold = opts.seconds ?? Math.min(7, 1.6 + this.text.length * 0.045);
    this.bubbleEl.classList.toggle('lcv-emote', !!opts.emote);
    this.bubbleEl.classList.remove('lcv-hidden');
    this.bubbleEl.textContent = '';
    return new Promise((r) => (this.resolve = r));
  }

  /** Hides the bubble now. */
  clear(): void {
    this.finish();
  }

  private finish(): void {
    this.text = '';
    this.bubbleEl.classList.add('lcv-hidden');
    const r = this.resolve;
    this.resolve = null;
    r?.();
  }

  /** @internal */
  tick(dt: number): void {
    if (!this.text) return;
    if (this.shown < this.text.length) {
      this.shown = Math.min(this.text.length, this.shown + dt * this.cps);
      this.bubbleEl.textContent = this.text.slice(0, Math.floor(this.shown));
    } else {
      this.hold -= dt;
      if (this.hold <= 0) this.finish();
    }
  }

  remove(): void {
    this.finish();
    this.removed = true;
    this.el.remove();
    this.layer.forget(this);
  }

  /** @internal */
  place(game: Game, tagsVisible: boolean): void {
    const a = this.anchor();
    const s = game.worldToScreen(a.x, a.y, a.z);
    const talking = this.text !== '';
    const maxD = talking ? 34 : 16;
    if (!s.visible || s.distance > maxD) {
      this.el.style.display = 'none';
      return;
    }
    this.el.style.display = '';
    this.nameEl.classList.toggle('lcv-hidden', !tagsVisible && !talking);
    const k = Math.max(0.55, Math.min(1.05, 1.25 - s.distance / 26));
    this.el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -100%) scale(${k.toFixed(3)})`;
    this.el.style.zIndex = String(1000 - Math.round(s.distance * 10));
  }
}

/** A static label floating over a world point. */
export class WorldLabel {
  readonly el: HTMLElement;

  constructor(readonly at: Vec3Like, text: string, readonly maxDistance = 22) {
    this.el = document.createElement('div');
    this.el.className = 'lcv-label';
    this.el.textContent = text;
  }

  setText(text: string): void {
    this.el.textContent = text;
  }

  /** @internal */
  place(game: Game): void {
    const s = game.worldToScreen(this.at.x, this.at.y, this.at.z);
    if (!s.visible || s.distance > this.maxDistance) {
      this.el.style.display = 'none';
      return;
    }
    this.el.style.display = '';
    const k = Math.max(0.6, Math.min(1.1, 1.3 - s.distance / 22));
    this.el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -100%) scale(${k.toFixed(3)})`;
  }
}

/** Owns all bubbles and labels; mount once, then call `update(dt)` every frame. */
export class BubbleLayer {
  readonly el: HTMLElement;
  private readonly bubbles = new Set<Bubble>();
  private readonly labels = new Set<WorldLabel>();
  /** Show name tags (speech bubbles always show). */
  tagsVisible = true;

  constructor(private readonly game: Game) {
    injectVillageStyles();
    this.el = document.createElement('div');
    this.el.className = 'lcv-layer';
    game.ui.hud.appendChild(this.el);
  }

  add(anchor: () => Vec3Like, name: string, role?: string): Bubble {
    const b = new Bubble(this, anchor, name, role);
    this.bubbles.add(b);
    this.el.appendChild(b.el);
    return b;
  }

  label(at: Vec3Like, text: string, maxDistance?: number): WorldLabel {
    const l = new WorldLabel(at, text, maxDistance);
    this.labels.add(l);
    this.el.appendChild(l.el);
    return l;
  }

  removeLabel(l: WorldLabel): void {
    this.labels.delete(l);
    l.el.remove();
  }

  /** @internal */
  forget(b: Bubble): void {
    this.bubbles.delete(b);
  }

  /** Advances typewriters (only while the game runs). */
  tick(dt: number): void {
    for (const b of this.bubbles) b.tick(dt);
  }

  /** Repositions overlays (every rendered frame). */
  place(): void {
    for (const b of this.bubbles) b.place(this.game, this.tagsVisible);
    for (const l of this.labels) l.place(this.game);
  }
}

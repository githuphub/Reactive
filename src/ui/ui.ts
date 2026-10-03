/**
 * UI layer: a HUD with named anchor slots, a stack of modal screens, and toasts.
 *
 * - HUD: `game.ui.mount('bottom-center', el, { order })` places an element in an anchor column.
 *   The hotbar lives in 'bottom-center' (order 100); V1 hearts/hunger mount above it (order < 100).
 * - Screens: `game.ui.screens.open(screen)`. While any screen is open, pointer lock is released
 *   and gameplay input is disabled; Esc closes the top screen. With no screen open, Esc (pointer
 *   lock loss) opens the pause menu.
 */

export type Anchor =
  | 'top-left' | 'top-center' | 'top-right'
  | 'center'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

const ANCHORS: Anchor[] = ['top-left', 'top-center', 'top-right', 'center', 'bottom-left', 'bottom-center', 'bottom-right'];

export interface Screen {
  /** Unique id, e.g. 'pause', 'inventory', 'trade'. */
  id: string;
  /** Root element (the stack positions it as a full-screen layer). */
  el: HTMLElement;
  /** Pause world simulation while open. Default true. */
  pausesGame?: boolean;
  /** Dim the game behind the screen. Default true. */
  dim?: boolean;
  onOpen?(): void;
  onClose?(): void;
  /** Return true when the key was handled. Esc closes the screen unless handled. */
  onKey?(e: KeyboardEvent): boolean;
}

export class ScreenStack {
  private readonly stack: Screen[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly host: HTMLElement) {}

  /** Opens a screen on top (no-op if it is already open). */
  open(screen: Screen): void {
    if (this.stack.includes(screen)) return;
    this.stack.push(screen);
    screen.el.classList.add('lc-screen');
    screen.el.classList.toggle('lc-dim', screen.dim !== false);
    this.host.appendChild(screen.el);
    screen.onOpen?.();
    this.changed();
  }

  /** Closes the given screen (or the top one). */
  close(screen?: Screen): void {
    const s = screen ?? this.stack[this.stack.length - 1];
    if (!s) return;
    const i = this.stack.indexOf(s);
    if (i < 0) return;
    this.stack.splice(i, 1);
    s.el.remove();
    s.onClose?.();
    this.changed();
  }

  closeAll(): void {
    while (this.stack.length) this.close();
  }

  /** Toggles a screen (handy for key bindings like E for inventory). */
  toggle(screen: Screen): void {
    if (this.stack.includes(screen)) this.close(screen);
    else this.open(screen);
  }

  get top(): Screen | undefined {
    return this.stack[this.stack.length - 1];
  }

  get isOpen(): boolean {
    return this.stack.length > 0;
  }

  has(id: string): boolean {
    return this.stack.some((s) => s.id === id);
  }

  /** True if any open screen pauses the game. */
  get pausing(): boolean {
    return this.stack.some((s) => s.pausesGame !== false);
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** @internal routes a key to the top screen; returns true if consumed. */
  handleKey(e: KeyboardEvent): boolean {
    const top = this.top;
    if (!top) return false;
    if (top.onKey?.(e)) return true;
    if (e.code === 'Escape') {
      this.close(top);
      return true;
    }
    return false;
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }
}

export class UI {
  readonly root: HTMLElement;
  /** Full-screen, click-through HUD layer. */
  readonly hud: HTMLElement;
  readonly screens: ScreenStack;
  private readonly anchors = new Map<Anchor, HTMLElement>();
  private readonly toasts: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    root.classList.add('lc-ui');
    this.hud = el('div', 'lc-hud');
    root.appendChild(this.hud);
    for (const a of ANCHORS) {
      const div = el('div', `lc-anchor lc-anchor-${a}`);
      this.hud.appendChild(div);
      this.anchors.set(a, div);
    }
    this.toasts = el('div', 'lc-toasts');
    this.hud.appendChild(this.toasts);
    const screenHost = el('div', 'lc-screens');
    root.appendChild(screenHost);
    this.screens = new ScreenStack(screenHost);
  }

  /** The container for an anchor (a flex column). */
  anchor(a: Anchor): HTMLElement {
    return this.anchors.get(a)!;
  }

  /**
   * Mounts an element into a HUD anchor. Lower `order` comes first (top of the column).
   * Returns an unmount function.
   */
  mount(anchor: Anchor, element: HTMLElement, opts: { order?: number } = {}): () => void {
    const host = this.anchor(anchor);
    element.style.order = String(opts.order ?? 50);
    host.appendChild(element);
    return () => element.remove();
  }

  /** Shows a short message near the top of the screen. */
  toast(text: string, opts: { seconds?: number; kind?: 'info' | 'good' | 'warn' } = {}): void {
    const t = el('div', `lc-toast lc-toast-${opts.kind ?? 'info'}`);
    t.textContent = text;
    this.toasts.appendChild(t);
    setTimeout(() => t.classList.add('lc-toast-out'), (opts.seconds ?? 3) * 1000);
    setTimeout(() => t.remove(), (opts.seconds ?? 3) * 1000 + 500);
  }

  /** Shows/hides the whole HUD (F1). */
  setHudVisible(v: boolean): void {
    this.hud.style.display = v ? '' : 'none';
  }
}

/** Tiny DOM helper. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Keyboard/mouse state with pointer lock. Systems read it each frame; per-frame edges
 * (`pressed`) and mouse deltas reset in `endFrame()`.
 */

/** Default key bindings (KeyboardEvent.code). */
export const KEYS = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  sneak: 'ShiftLeft',
  sprint: 'ControlLeft',
  inventory: 'KeyE',
  drop: 'KeyQ',
  chat: 'KeyT',
  debug: 'F3',
  view: 'F5',
  hideHud: 'F1',
} as const;

export class Input {
  private readonly down = new Set<string>();
  private readonly pressedKeys = new Set<string>();
  private readonly buttons = new Set<number>();
  private readonly pressedButtons = new Set<number>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  /** When false (screen open), gameplay keys report nothing. */
  enabled = true;
  private lockListeners = new Set<(locked: boolean) => void>();
  private keyListeners = new Set<(e: KeyboardEvent) => boolean | void>();

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      for (const l of this.keyListeners) if (l(e) === true) {
        e.preventDefault();
        return;
      }
      // Let text fields (chat, signs, trade search) receive their keys untouched.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (['Space', 'F3', 'F5', 'F1', 'Tab', 'AltLeft'].includes(e.code)) e.preventDefault();
      if (e.ctrlKey && ['KeyS', 'KeyD', 'KeyW', 'KeyA'].includes(e.code) && this.locked) e.preventDefault();
      if (!e.repeat) this.pressedKeys.add(e.code);
      this.down.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => {
      this.down.clear();
      this.buttons.clear();
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this.buttons.add(e.button);
      this.pressedButtons.add(e.button);
      e.preventDefault();
    });
    window.addEventListener('mouseup', (e) => this.buttons.delete(e.button));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener(
      'wheel',
      (e) => {
        if (!this.locked) return;
        this.wheel += Math.sign(e.deltaY);
      },
      { passive: true },
    );
    document.addEventListener('pointerlockchange', () => {
      const locked = this.locked;
      if (!locked) {
        this.buttons.clear();
        this.down.clear();
      }
      for (const l of this.lockListeners) l(locked);
    });
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /** Requests pointer lock (must follow a user gesture). Errors are swallowed. */
  lock(): void {
    if (this.locked) return;
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {});
    } catch {
      // ignore
    }
  }

  unlock(): void {
    if (this.locked) document.exitPointerLock();
  }

  onLockChange(cb: (locked: boolean) => void): () => void {
    this.lockListeners.add(cb);
    return () => this.lockListeners.delete(cb);
  }

  /** Raw keydown hook that runs before game handling; return true to swallow the key. */
  onKey(cb: (e: KeyboardEvent) => boolean | void): () => void {
    this.keyListeners.add(cb);
    return () => this.keyListeners.delete(cb);
  }

  isDown(code: string): boolean {
    return this.enabled && this.down.has(code);
  }

  /** True only on the frame the key went down. */
  wasPressed(code: string): boolean {
    return this.enabled && this.pressedKeys.has(code);
  }

  isButtonDown(button: number): boolean {
    return this.enabled && this.buttons.has(button);
  }

  wasButtonPressed(button: number): boolean {
    return this.enabled && this.pressedButtons.has(button);
  }

  endFrame(): void {
    this.pressedKeys.clear();
    this.pressedButtons.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}

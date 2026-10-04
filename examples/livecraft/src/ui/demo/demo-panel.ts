/**
 * Demo panel (`?demo`, top-right; also "Demo" in the pause menu): one click per presentation scenario plus
 * utilities. The panel only renders buttons; the actions come from the caller (liveforge/scenarios.ts).
 * A status badge (Online / Offline + cassette mode) sits above it and is always visible.
 */
import { lfOverlay } from '../lf-styles';

export interface DemoButton {
  label: string;
  hint?: string;
  run(): void | Promise<void>;
}

export interface DemoToggle {
  label: string;
  get(): boolean;
  set(on: boolean): void;
}

export interface DemoAction {
  label: string;
  run(): void | Promise<void>;
}

export class DemoPanel {
  readonly el: HTMLElement;
  private readonly toggles: { t: DemoToggle; b: HTMLElement }[] = [];
  private visible: boolean;

  constructor(scenarios: DemoButton[], utilities: (DemoToggle | DemoAction)[], opts: { visible: boolean; title?: string }) {
    this.visible = opts.visible;
    this.el = document.createElement('div');
    this.el.className = 'lcx-demo';
    const h = document.createElement('h3');
    const t = document.createElement('span');
    t.textContent = opts.title ?? 'LIVECRAFT DEMO';
    const x = document.createElement('button');
    x.className = 'lcx-ib';
    x.textContent = '✕';
    x.title = 'Hide (open again from the pause menu)';
    x.addEventListener('click', () => this.setVisible(false));
    h.append(t, x);
    this.el.appendChild(h);
    for (const s of scenarios) {
      const b = document.createElement('button');
      b.className = 'lcx-db';
      b.textContent = s.label;
      if (s.hint) {
        const small = document.createElement('small');
        small.textContent = s.hint;
        b.appendChild(small);
      }
      b.addEventListener('click', () => {
        b.classList.add('lcx-busy');
        Promise.resolve()
          .then(() => s.run())
          .catch((err) => console.error(`[demo] ${s.label} failed`, err))
          .finally(() => b.classList.remove('lcx-busy'));
      });
      this.el.appendChild(b);
    }
    const grid = document.createElement('div');
    grid.className = 'lcx-utils';
    for (const u of utilities) {
      const b = document.createElement('button');
      b.className = 'lcx-ub';
      b.textContent = u.label;
      if ('get' in u) {
        this.toggles.push({ t: u, b });
        b.addEventListener('click', () => {
          u.set(!u.get());
          this.sync();
        });
      } else {
        b.addEventListener('click', () => void Promise.resolve(u.run()).catch((err) => console.error(`[demo] ${u.label} failed`, err)).finally(() => this.sync()));
      }
      grid.appendChild(b);
    }
    this.el.appendChild(grid);
    this.el.classList.toggle('lcx-hidden', !this.visible);
    lfOverlay().appendChild(this.el);
    this.sync();
    setInterval(() => this.sync(), 1000);
  }

  get isVisible(): boolean {
    return this.visible;
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.classList.toggle('lcx-hidden', !v);
  }

  /** Re-reads toggle states (labels show ON/OFF). */
  sync(): void {
    for (const { t, b } of this.toggles) {
      const on = t.get();
      b.classList.toggle('lcx-on', on);
      b.textContent = `${t.label}: ${on ? 'on' : 'off'}`;
    }
  }
}

/** Online / offline dot + cassette label (top-right). */
export class StatusBadge {
  readonly el: HTMLElement;
  private readonly dot: HTMLElement;
  private readonly text: HTMLElement;
  private readonly cas: HTMLElement;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'lcx-lfbadge';
    this.el.title = 'Reactive connection · cassette mode';
    this.dot = document.createElement('span');
    this.dot.className = 'lcx-dot';
    this.text = document.createElement('span');
    this.cas = document.createElement('span');
    this.cas.className = 'lcx-cas';
    this.el.append(this.dot, this.text, this.cas);
    lfOverlay().appendChild(this.el);
  }

  set(status: string, cassette: string): void {
    this.dot.className = `lcx-dot lcx-${status === 'off' ? 'offline' : status}`;
    this.text.textContent = status === 'online' ? 'Reactive online' : status === 'connecting' ? 'Reactive…' : status === 'off' ? 'Reactive off (local rules)' : 'Offline · local rules';
    this.cas.textContent = cassette;
    this.cas.className = `lcx-cas lcx-${cassette}`;
  }
}

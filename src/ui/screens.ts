/**
 * Loading screen (progress until spawn chunks are meshed) and the pause menu (Esc).
 */
import type { Game } from '../game/game';
import { el, type Screen } from './ui';

export class LoadingScreen {
  readonly el: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly status: HTMLElement;
  private readonly play: HTMLElement;
  private done = false;

  constructor(host: HTMLElement, seedText: string) {
    this.el = el('div', 'lc-loading');
    const title = el('h1', undefined, 'LIVECRAFT');
    const barWrap = el('div', 'lc-bar');
    this.bar = el('div');
    barWrap.appendChild(this.bar);
    this.status = el('div', 'lc-status', `Generating world "${seedText}"…`);
    this.play = el('div', 'lc-play', 'Click to play');
    this.play.style.visibility = 'hidden';
    this.el.append(title, barWrap, this.status, this.play);
    host.appendChild(this.el);
  }

  setProgress(f: number, text?: string): void {
    this.bar.style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;
    if (text) this.status.textContent = text;
  }

  /** Switches to "click to play"; resolves when clicked. */
  ready(): Promise<void> {
    this.setProgress(1, 'World ready');
    this.play.style.visibility = 'visible';
    return new Promise((resolve) => {
      const go = () => {
        if (this.done) return;
        this.done = true;
        this.el.style.opacity = '0';
        setTimeout(() => this.el.remove(), 450);
        resolve();
      };
      this.el.addEventListener('click', go, { once: true });
    });
  }
}

/** Pause menu with resume and settings. */
export function createPauseScreen(game: Game): Screen {
  const root = el('div');
  const panel = el('div', 'lc-panel');
  panel.appendChild(el('h2', undefined, 'Game Paused'));

  const resume = el('button', 'lc-btn', 'Back to Game');
  resume.addEventListener('click', () => {
    game.ui.screens.close(screen);
    game.input.lock();
  });
  panel.appendChild(resume);

  const slider = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt = (v: number) => String(v)) => {
    const row = el('div', 'lc-row');
    const name = el('span', undefined, label);
    const input = el('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const val = el('span', 'lc-val');
    const sync = () => {
      input.value = String(get());
      val.textContent = fmt(get());
    };
    input.addEventListener('input', () => {
      set(Number(input.value));
      val.textContent = fmt(Number(input.value));
    });
    row.append(name, input, val);
    sync();
    return { row, sync };
  };

  const rd = slider('Render distance', 2, 10, 1, () => game.settings.renderDistance, (v) => game.setSetting('renderDistance', v), (v) => `${v}`);
  const fov = slider('FOV', 50, 110, 1, () => game.settings.fov, (v) => game.setSetting('fov', v), (v) => `${v}°`);
  const sens = slider('Mouse sensitivity', 0.2, 3, 0.05, () => game.settings.sensitivity, (v) => game.setSetting('sensitivity', v), (v) => v.toFixed(2));
  panel.append(rd.row, fov.row, sens.row);

  const bob = el('button', 'lc-btn');
  const syncBob = () => (bob.textContent = `View bobbing: ${game.settings.viewBob ? 'ON' : 'OFF'}`);
  bob.addEventListener('click', () => {
    game.setSetting('viewBob', !game.settings.viewBob);
    syncBob();
  });
  panel.appendChild(bob);

  const mode = el('button', 'lc-btn');
  const syncMode = () => (mode.textContent = `Game mode: ${game.player.mode === 'creative' ? 'Creative' : 'Survival'}`);
  mode.addEventListener('click', () => {
    game.setGameMode(game.player.mode === 'creative' ? 'survival' : 'creative');
    syncMode();
  });
  panel.appendChild(mode);

  const seed = el('div', 'lc-muted');
  panel.appendChild(seed);
  const help = el('div', 'lc-muted', 'WASD move · Space jump · Shift sneak · Ctrl/double-W sprint · LMB break · RMB place · MMB pick · 1-9/wheel hotbar · F3 debug · F5 view · F1 HUD');
  panel.appendChild(help);
  root.appendChild(panel);

  const screen: Screen = {
    id: 'pause',
    el: root,
    pausesGame: true,
    onOpen() {
      rd.sync();
      fov.sync();
      sens.sync();
      syncBob();
      syncMode();
      seed.textContent = `Seed: ${game.seedText}`;
    },
  };
  return screen;
}

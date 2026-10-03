/**
 * Survival HUD: hearts, hunger and air above the hotbar; a red hurt vignette; a fire overlay;
 * an attack / bow / eating indicator under the crosshair; and the death screen.
 */
import type { Game } from '../game/game';
import { el, type Screen } from '../ui/ui';
import { getCombat } from './combat';
import { MAX_AIR, getHealth } from './health';

// -- pixel icons (9×9, original) -----------------------------------------------------------------

type Pix = (ctx: CanvasRenderingContext2D) => void;

function icon(draw: Pix): string {
  const c = document.createElement('canvas');
  c.width = c.height = 9;
  const ctx = c.getContext('2d')!;
  draw(ctx);
  return c.toDataURL();
}

function rows(ctx: CanvasRenderingContext2D, map: string[], colors: Record<string, string>): void {
  map.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const col = colors[row[x]];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 1, 1);
    }
  });
}

const HEART = [
  ' kk   kk ',
  'krrk krrk',
  'krwrkrrrk',
  'krrrrrrrk',
  'krrrrrrdk',
  ' krrrrdk ',
  '  krrdk  ',
  '   kdk   ',
  '    k    ',
];
const HUNGER = [
  '    kk   ',
  '   kbbk  ',
  '  kbwbbk ',
  ' kbbbbbk ',
  ' kbbbbdk ',
  'kcbbbddk ',
  'kcckddk  ',
  ' kk kk   ',
  '         ',
];
const BUBBLE = [
  '         ',
  '  kkkkk  ',
  ' kaaaaak ',
  ' kawaaak ',
  ' kaaaaak ',
  ' kaaaaak ',
  ' kaaaaak ',
  '  kkkkk  ',
  '         ',
];

function half(map: string[], fill: Record<string, string>, empty: Record<string, string>): Pix {
  return (ctx) => {
    rows(ctx, map, empty);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, 4.5, 9);
    ctx.clip();
    rows(ctx, map, fill);
    ctx.restore();
  };
}

let icons: Record<string, string> | null = null;
function getIcons(): Record<string, string> {
  if (icons) return icons;
  const heartFull = { k: '#1a0606', r: '#d8232a', w: '#ffb0b0', d: '#8a1016' };
  const heartEmpty = { k: '#1a0606', r: '#3a1414', w: '#4a1c1c', d: '#2a0c0c' };
  const heartFlash = { k: '#ffffff', r: '#3a1414', w: '#4a1c1c', d: '#2a0c0c' };
  const foodFull = { k: '#2a1606', b: '#b8743a', w: '#f0c890', d: '#7a4a1e', c: '#efe6d6' };
  const foodEmpty = { k: '#2a1606', b: '#3a2614', w: '#4a3220', d: '#2a1a0c', c: '#5a5040' };
  icons = {
    heart: icon((c) => rows(c, HEART, heartFull)),
    heartHalf: icon(half(HEART, heartFull, heartEmpty)),
    heartEmpty: icon((c) => rows(c, HEART, heartEmpty)),
    heartFlash: icon((c) => rows(c, HEART, heartFlash)),
    food: icon((c) => rows(c, HUNGER, foodFull)),
    foodHalf: icon(half(HUNGER, foodFull, foodEmpty)),
    foodEmpty: icon((c) => rows(c, HUNGER, foodEmpty)),
    bubble: icon((c) => rows(c, BUBBLE, { k: '#1a3a6a', a: '#4aa0ff', w: '#e8f6ff' })),
  };
  return icons;
}

// -- HUD -----------------------------------------------------------------------------------------

export class SurvivalHud {
  readonly el: HTMLElement;
  private readonly hearts: HTMLElement[] = [];
  private readonly food: HTMLElement[] = [];
  private readonly air: HTMLElement[] = [];
  private readonly airRow: HTMLElement;
  private readonly heartRow: HTMLElement;
  private readonly foodRow: HTMLElement;
  private readonly vignette: HTMLElement;
  private readonly fire: HTMLElement;
  private readonly indicator: HTMLElement;
  private readonly indicatorBar: HTMLElement;
  private lastHealth = 20;
  private flashTimer = 0;

  constructor(private readonly game: Game) {
    const ic = getIcons();
    this.el = el('div', 'lcs-status');
    const left = el('div', 'lcs-col');
    const right = el('div', 'lcs-col lcs-right');
    this.airRow = el('div', 'lcs-row lcs-air');
    this.heartRow = el('div', 'lcs-row');
    this.foodRow = el('div', 'lcs-row lcs-food');
    for (let i = 0; i < 10; i++) {
      const h = el('span', 'lcs-icon');
      h.style.backgroundImage = `url(${ic.heart})`;
      this.heartRow.appendChild(h);
      this.hearts.push(h);
      const f = el('span', 'lcs-icon');
      f.style.backgroundImage = `url(${ic.food})`;
      this.foodRow.appendChild(f);
      this.food.push(f);
      const a = el('span', 'lcs-icon');
      a.style.backgroundImage = `url(${ic.bubble})`;
      this.airRow.appendChild(a);
      this.air.push(a);
    }
    left.append(this.heartRow);
    right.append(this.airRow, this.foodRow);
    this.el.append(left, right);

    this.vignette = el('div', 'lcs-vignette');
    this.fire = el('div', 'lcs-fire');
    this.indicator = el('div', 'lcs-indicator');
    this.indicatorBar = el('div');
    this.indicator.appendChild(this.indicatorBar);
    game.ui.hud.append(this.vignette, this.fire, this.indicator);

    game.events.on('playerStatsChanged', () => this.refresh());
    game.events.on('gameModeChanged', () => this.refresh());
    game.events.on('playerHurt', () => {
      this.flashTimer = 0.45;
      this.vignette.style.transition = 'none';
      this.vignette.style.opacity = '1';
      requestAnimationFrame(() => {
        this.vignette.style.transition = 'opacity 0.6s ease-out';
        this.vignette.style.opacity = '0';
      });
    });
    game.addSystem({ name: 'survival-hud', update: (dt) => this.update(dt) });
    this.refresh();
  }

  refresh(): void {
    const ic = getIcons();
    const h = getHealth(this.game);
    const creative = this.game.player.mode === 'creative';
    this.el.style.visibility = creative ? 'hidden' : 'visible';
    const flash = this.flashTimer > 0 && Math.floor(this.flashTimer * 10) % 2 === 0;
    for (let i = 0; i < 10; i++) {
      const v = h.health - i * 2;
      this.hearts[i].style.backgroundImage = `url(${v >= 2 ? ic.heart : v === 1 ? ic.heartHalf : flash ? ic.heartFlash : ic.heartEmpty})`;
      // Food fills from the right.
      const fv = h.hunger - i * 2;
      this.food[i].style.backgroundImage = `url(${fv >= 2 ? ic.food : fv === 1 ? ic.foodHalf : ic.foodEmpty})`;
    }
    const bubbles = Math.ceil((h.air / MAX_AIR) * 10);
    this.airRow.style.visibility = h.air < MAX_AIR - 0.01 ? 'visible' : 'hidden';
    for (let i = 0; i < 10; i++) this.air[i].style.opacity = i < bubbles ? '1' : '0';
    this.heartRow.classList.toggle('lcs-low', h.health <= 4 && !h.dead);
    this.foodRow.classList.toggle('lcs-starving', h.hunger <= 4);
    this.lastHealth = h.health;
  }

  private update(dt: number): void {
    const game = this.game;
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      this.refresh();
    }
    const h = getHealth(game);
    this.fire.style.opacity = h.burning > 0 && game.player.mode === 'survival' ? '1' : '0';
    // Under-crosshair indicator: bow draw, eating, or attack recharge.
    const c = getCombat(game);
    let v = -1;
    let cls = '';
    if (c.bowCharge > 0) {
      v = c.bowCharge;
      cls = c.bowCharge >= 1 ? 'lcs-full' : '';
    } else if (c.eatProgress > 0) {
      v = c.eatProgress;
      cls = 'lcs-eat';
    } else if (c.attackStrength < 1) v = c.attackStrength;
    this.indicator.style.opacity = v >= 0 ? '1' : '0';
    if (v >= 0) {
      this.indicatorBar.style.width = `${Math.round(v * 100)}%`;
      this.indicator.className = `lcs-indicator ${cls}`;
    }
    void this.lastHealth;
  }
}

// -- death screen --------------------------------------------------------------------------------

export function createDeathScreen(game: Game): Screen & { setCause(text: string): void } {
  const root = el('div', 'lcs-death');
  const title = el('h1', undefined, 'You died!');
  const cause = el('div', 'lcs-death-cause');
  const btn = el('button', 'lc-btn', 'Respawn');
  const panel = el('div', 'lcs-death-panel');
  panel.append(title, cause, btn);
  root.appendChild(panel);
  const screen: Screen & { setCause(text: string): void } = {
    id: 'death',
    el: root,
    pausesGame: false,
    dim: false,
    onKey: (e) => e.code === 'Escape' || e.code === 'KeyE',
    setCause(text) {
      cause.textContent = text;
    },
  };
  btn.addEventListener('click', () => {
    getHealth(game).respawn();
    game.ui.screens.close(screen);
    game.input.lock();
  });
  return screen;
}

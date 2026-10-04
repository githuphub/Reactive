/**
 * The rumour board: Oakhollow's notice board on the plaza (V2 stamps it at `layout.board`) shows the live rumours as
 * parchment notes pinned to it, drawn into a canvas texture on both faces of the board.
 *
 * - Look at it: a hint appears and the rumours refresh (`world.reactions`, throttled).
 * - Right-click it: opens the journal on the Rumours tab.
 * - The newest note glows for a few seconds when a rumour forms or changes.
 */
import * as THREE from 'three';
import type { Game } from '../../../game/game';
import { village } from '../../../village';
import { npcLabel } from '../stats';
import { injectWorldStyles } from '../styles';
import type { LcRumour, RumourBook } from './rumours';

const W = 512;
const H = 512;

export class RumourBoard {
  private readonly canvas = document.createElement('canvas');
  private readonly tex: THREE.CanvasTexture;
  private readonly mat: THREE.MeshBasicMaterial;
  private readonly group = new THREE.Group();
  private region: { x0: number; x1: number; y0: number; y1: number; z: number } | null = null;
  private readonly hint: HTMLElement;
  private redrawTimer: ReturnType<typeof setTimeout> | null = null;
  private highlight: { id: string; until: number } | null = null;
  private lastLook = 0;

  /**
   * @param onRead right-click (open the journal's Rumours tab)
   * @param refresh asks the server for fresh rumours (throttled by the caller)
   */
  constructor(private readonly game: Game, private readonly book: RumourBook, onRead: () => void, refresh: () => void) {
    injectWorldStyles();
    this.canvas.width = W;
    this.canvas.height = H;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.mat = new THREE.MeshBasicMaterial({ map: this.tex });
    this.hint = document.createElement('div');
    this.hint.className = 'wbw-hint wbw-hidden';
    this.hint.textContent = '📜 Rumour board · right-click to read';
    game.ui.hud.appendChild(this.hint);

    void village.ready.then(() => this.mount());
    book.onChange(() => this.schedule());
    game.events.on('rumourCreated', (e) => this.flash(e.rumourId));
    game.events.on('rumourSpread', (e) => {
      if (e.mutated) this.flash(e.rumourId);
    });
    game.events.on('timeChanged', () => this.light());
    game.events.on('blockInteract', (e) => {
      if (!this.inRegion(e.x, e.y, e.z)) return;
      e.handled = true;
      refresh();
      onRead();
    });
    game.addSystem({
      name: 'wb-rumour-board',
      update: () => {
        const t = game.interaction.target;
        const looking = !!t && this.inRegion(t.x, t.y, t.z) && !game.ui.screens.isOpen;
        this.hint.classList.toggle('wbw-hidden', !looking);
        if (looking && performance.now() - this.lastLook > 10_000) {
          this.lastLook = performance.now();
          refresh();
        }
        if (this.highlight && performance.now() > this.highlight.until) {
          this.highlight = null;
          this.schedule();
        }
      },
    });
  }

  /** Where the board is (world block coords of its face), or null without a village. */
  get position(): { x: number; y: number; z: number } | null {
    const r = this.region;
    return r ? { x: (r.x0 + r.x1 + 1) / 2, y: r.y0 + 2, z: r.z + 0.5 } : null;
  }

  private mount(): void {
    const l = village.layout;
    if (!l) return;
    const { x, z } = l.board;
    const y0 = l.y0;
    this.region = { x0: x - 1, x1: x + 4, y0: y0 + 1, y1: y0 + 4, z };
    const geo = new THREE.PlaneGeometry(2, 2);
    const south = new THREE.Mesh(geo, this.mat);
    south.position.set(x + 2, y0 + 3, z + 1.012);
    const north = new THREE.Mesh(geo, this.mat);
    north.position.set(x + 2, y0 + 3, z - 0.012);
    north.rotation.y = Math.PI;
    this.group.add(south, north);
    this.group.name = 'wb-rumour-board';
    this.game.scene.add(this.group);
    this.light();
    this.draw();
  }

  private inRegion(x: number, y: number, z: number): boolean {
    const r = this.region;
    return !!r && z === r.z && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
  }

  private light(): void {
    const d = this.game.time.daylight ?? 1;
    this.mat.color.setScalar(Math.min(1, 0.32 + d * 0.75));
  }

  private flash(id: string): void {
    this.highlight = { id, until: performance.now() + 4000 };
    this.schedule();
  }

  private schedule(): void {
    if (this.redrawTimer) return;
    this.redrawTimer = setTimeout(() => {
      this.redrawTimer = null;
      this.draw();
    }, 250);
  }

  private draw(): void {
    const g = this.canvas.getContext('2d')!;
    // cork + frame
    g.fillStyle = '#7a5532';
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 900; i++) {
      g.fillStyle = i % 3 ? 'rgba(60,35,15,0.25)' : 'rgba(170,120,70,0.25)';
      g.fillRect((i * 97) % W, (i * 57 + (i >> 3) * 13) % H, 3, 2);
    }
    g.strokeStyle = '#3e2712';
    g.lineWidth = 14;
    g.strokeRect(7, 7, W - 14, H - 14);
    // header plaque
    g.fillStyle = '#e8d6a8';
    g.fillRect(150, 18, 212, 40);
    g.strokeStyle = '#5a3a18';
    g.lineWidth = 3;
    g.strokeRect(150, 18, 212, 40);
    g.fillStyle = '#4a2a10';
    g.font = 'bold 26px Georgia, serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('RUMOURS', W / 2, 39);

    const rs = this.book.list().slice(0, 4);
    if (!rs.length) {
      this.note(g, 140, 120, 232, 200, -0.03, { text: 'No gossip yet… Oakhollow is quiet. Suspiciously quiet.', foot: '— Pip', heat: 0, glow: false });
    }
    const slots = [[28, 76], [262, 84], [36, 290], [270, 296]];
    rs.forEach((r, i) => {
      const [sx, sy] = slots[i];
      const tilt = ((hash(r.id) % 9) - 4) * 0.012;
      this.note(g, sx, sy, 218, 196, tilt, {
        text: r.content,
        foot: footOf(r),
        heat: r.heat,
        glow: this.highlight?.id === r.id,
        drift: r.mutations,
      });
    });
    this.tex.needsUpdate = true;
  }

  private note(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, tilt: number, n: { text: string; foot: string; heat: number; glow: boolean; drift?: number }): void {
    g.save();
    g.translate(x + w / 2, y + h / 2);
    g.rotate(tilt);
    g.translate(-w / 2, -h / 2);
    if (n.glow) {
      g.shadowColor = '#ffe066';
      g.shadowBlur = 28;
    } else {
      g.shadowColor = 'rgba(0,0,0,0.45)';
      g.shadowBlur = 8;
      g.shadowOffsetY = 4;
    }
    g.fillStyle = n.glow ? '#fff3c4' : '#efe2c0';
    g.fillRect(0, 0, w, h);
    g.shadowColor = 'transparent';
    g.shadowBlur = 0;
    g.shadowOffsetY = 0;
    // torn bottom edge
    g.fillStyle = '#7a5532';
    for (let i = 0; i < w; i += 12) g.fillRect(i, h - 4 + ((i / 12) % 2) * 2, 6, 6);
    // pin
    g.fillStyle = '#b8262b';
    g.beginPath();
    g.arc(w / 2, 12, 8, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.6)';
    g.fillRect(w / 2 - 3, 8, 3, 3);
    // text
    g.fillStyle = '#2e2010';
    g.font = 'italic 19px Georgia, serif';
    g.textAlign = 'left';
    g.textBaseline = 'top';
    const lines = wrap(g, `“${n.text}”`, w - 24).slice(0, 6);
    lines.forEach((ln, i) => g.fillText(ln, 12, 28 + i * 23));
    // footer: who knows it, heat
    g.font = '15px Georgia, serif';
    g.fillStyle = '#6a4a22';
    g.fillText(n.foot, 12, h - 46);
    if (n.heat > 0) {
      const flames = Math.max(1, Math.round(n.heat * 4));
      g.fillStyle = '#c24a12';
      g.font = 'bold 15px Georgia, serif';
      g.fillText(`${'▲'.repeat(flames)} hot${n.drift ? ` · retold ${n.drift}×` : ''}`, 12, h - 26);
    }
    g.restore();
  }
}

function footOf(r: LcRumour): string {
  const names = r.knownBy.map((k) => npcLabel(k).split(' ').pop()!);
  return names.length ? `known by ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}` : 'whispered about';
}

function wrap(g: CanvasRenderingContext2D, text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (g.measureText(t).width > max && line) {
      out.push(line);
      line = w;
    } else line = t;
  }
  if (line) out.push(line);
  if (out.length > 6) out[5] = `${out[5].replace(/\s*\S+$/, '')}…`;
  return out;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

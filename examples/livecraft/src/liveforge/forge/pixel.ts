/**
 * Rules pixel-art generator for forged items: a 16×16 tool silhouette per type, coloured from the item palette,
 * with glow pixels in the element colour. AI pixel grids (16 rows of palette-index characters) are used as is.
 */

/** RGBA pixels, row-major, 16×16 (y = 0 is the top row). */
export type Pixels = Uint8ClampedArray;

export type ToolShape = 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'sword' | 'hammer' | 'spear' | 'staff' | 'bow';

export interface IconSpec {
  shape: ToolShape;
  /** Head / blade colour. */
  main: string;
  /** Handle colour. */
  handle: string;
  /** Trim / edge colour. */
  trim: string;
  /** Glow colour (element). */
  glow: string;
  /** Deterministic sparkle placement. */
  seed: number;
  /** Extra sparks around the head (lightning). */
  sparks?: boolean;
}

// cell codes: 0 empty, 1 handle, 2 handle shade, 3 head, 4 head outline, 5 head highlight, 6 glow, 7 trim
type Grid = Uint8Array;

const S = 16;
const at = (x: number, y: number) => y * S + x;

function put(g: Grid, x: number, y: number, v: number, overwrite = true): void {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  if (!overwrite && g[at(x, y)]) return;
  g[at(x, y)] = v;
}

function line(g: Grid, x0: number, y0: number, x1: number, y1: number, v: number, thick = 1): void {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n, y = y0 + ((y1 - y0) * i) / n;
    put(g, x, y, v);
    if (thick > 1) put(g, x + 1, y, v);
  }
}

function handle(g: Grid, x0: number, y0: number, x1: number, y1: number): void {
  line(g, x0, y0, x1, y1, 1);
  // shade under the handle
  const n = Math.max(Math.abs(x1 - x0), 1);
  for (let i = 0; i <= n; i += 2) put(g, x0 + ((x1 - x0) * i) / n + 1, y0 + ((y1 - y0) * i) / n, 2, false);
}

/** Head pixels with a dark outline and a highlight on the upper edge. */
function outline(g: Grid): void {
  const copy = g.slice();
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (copy[at(x, y)] !== 3) continue;
    const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const nx = x + dx, ny = y + dy;
      return nx < 0 || ny < 0 || nx >= S || ny >= S || copy[at(nx, ny)] === 0;
    });
    const top = y === 0 || copy[at(x, y - 1)] === 0;
    if (edge) g[at(x, y)] = top ? 5 : 4;
  }
}

function shapeGrid(shape: ToolShape): Grid {
  const g = new Uint8Array(S * S);
  switch (shape) {
    case 'pickaxe': {
      handle(g, 2, 14, 10, 6);
      for (let s = -6; s <= 5; s++) {
        const c = Math.round(2 - (s * s) / 14);
        const x = 10 + s + c, y = 6 + s - c;
        put(g, x, y, 3);
        put(g, x - 1, y, 3);
        if (Math.abs(s) < 5) put(g, x, y + 1, 3);
      }
      break;
    }
    case 'axe': {
      handle(g, 2, 14, 11, 5);
      for (let t = 0; t <= 4; t++) {
        const hx = 7 + t, hy = 9 - t;
        const len = t === 0 || t === 4 ? 3 : 5;
        for (let k = 1; k <= len; k++) {
          put(g, hx - k, hy - k, 3);
          put(g, hx - k + 1, hy - k, 3);
        }
      }
      break;
    }
    case 'shovel': {
      handle(g, 2, 14, 9, 7);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const u = x - 12 + (y - 4), v = x - 12 - (y - 4);
        if (Math.abs(u) <= 3 && Math.abs(v) <= 4) put(g, x, y, 3);
      }
      break;
    }
    case 'hoe': {
      handle(g, 2, 14, 11, 5);
      line(g, 7, 2, 12, 5, 3, 2);
      put(g, 12, 4, 3);
      break;
    }
    case 'sword': {
      line(g, 5, 10, 14, 1, 3, 2);
      put(g, 15, 0, 3);
      line(g, 3, 8, 7, 12, 7);
      line(g, 2, 13, 4, 11, 1);
      put(g, 1, 14, 7);
      break;
    }
    case 'hammer': {
      handle(g, 2, 14, 10, 6);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const u = x - 12 + (y - 4), v = x - 12 - (y - 4);
        if (Math.abs(u) <= 2.5 && Math.abs(v) <= 5) put(g, x, y, 3);
      }
      break;
    }
    case 'spear': {
      handle(g, 1, 14, 11, 4);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const u = x - 13 + (y - 2), v = x - 13 - (y - 2);
        if (Math.abs(u) <= 1.5 && Math.abs(v) <= 3.5 && x + y >= 13) put(g, x, y, 3);
      }
      break;
    }
    case 'staff': {
      handle(g, 1, 14, 10, 5);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (Math.hypot(x - 12, y - 3) <= 2.6) put(g, x, y, 3);
      put(g, 12, 3, 6);
      break;
    }
    case 'bow': {
      for (let a = 0; a <= 90; a += 3) {
        const r = (a * Math.PI) / 180;
        const x = 1 + 13 * Math.sin(r), y = 14 - 13 * Math.cos(r);
        put(g, x, y, 1);
        put(g, x - 0.6, y + 0.6, 2, false);
      }
      line(g, 1, 1, 14, 14, 7);
      put(g, 1, 1, 3);
      put(g, 14, 14, 3);
      put(g, 7, 7, 3);
      put(g, 8, 6, 3);
      break;
    }
  }
  outline(g);
  return g;
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0').slice(0, 6);
  const n = parseInt(f, 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [200, 200, 200];
}

const shade = (c: [number, number, number], f: number): [number, number, number] => [Math.min(255, c[0] * f), Math.min(255, c[1] * f), Math.min(255, c[2] * f)];

function rand(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** Paints the icon (rules). */
export function paintIcon(spec: IconSpec): Pixels {
  const g = shapeGrid(spec.shape);
  const r = rand(spec.seed);
  // glow pixels on the head
  const head: number[] = [];
  for (let i = 0; i < g.length; i++) if (g[i] === 3) head.push(i);
  for (let k = 0; k < Math.min(6, Math.ceil(head.length / 5)); k++) g[head[Math.floor(r() * head.length)]] = 6;
  if (spec.sparks) {
    for (let k = 0; k < 4; k++) {
      const x = 9 + Math.floor(r() * 7), y = Math.floor(r() * 7);
      if (!g[at(x, y)]) g[at(x, y)] = 6;
    }
  }
  const main = rgb(spec.main), hand = rgb(spec.handle), trim = rgb(spec.trim), glow = rgb(spec.glow);
  const colors: Record<number, [number, number, number]> = {
    1: hand, 2: shade(hand, 0.65), 3: main, 4: shade(main, 0.55), 5: shade(main, 1.35), 6: glow, 7: trim,
  };
  const out = new Uint8ClampedArray(S * S * 4);
  for (let i = 0; i < g.length; i++) {
    const c = colors[g[i]];
    if (!c) continue;
    out.set([c[0], c[1], c[2], 255], i * 4);
  }
  return out;
}

/**
 * An AI pixel grid → pixels: 16 strings of 16 characters, each a palette index (0-9, a-f) or "." / " " for empty.
 * Returns null when the grid isn't usable.
 */
export function pixelsFromGrid(grid: unknown, palette: string[]): Pixels | null {
  if (!Array.isArray(grid) || grid.length < 8 || !palette.length) return null;
  const out = new Uint8ClampedArray(S * S * 4);
  let filled = 0;
  for (let y = 0; y < Math.min(S, grid.length); y++) {
    const row = Array.isArray(grid[y]) ? (grid[y] as unknown[]).map((v) => String(v)).join('') : String(grid[y] ?? '');
    for (let x = 0; x < Math.min(S, row.length); x++) {
      const ch = row[x];
      if (ch === '.' || ch === ' ' || ch === '-') continue;
      const idx = parseInt(ch, 16);
      if (!Number.isFinite(idx)) continue;
      const c = rgb(palette[idx % palette.length]);
      out.set([c[0], c[1], c[2], 255], (y * S + x) * 4);
      filled++;
    }
  }
  return filled >= 12 ? out : null;
}

/** Pixels → a canvas (for the result card). */
export function pixelsToCanvas(px: Pixels): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  img.data.set(px);
  ctx.putImageData(img, 0, 0);
  return c;
}

/**
 * Tiny pixel-art toolkit used by the procedural texture painters. Works on raw RGBA arrays
 * so it runs anywhere (main thread or worker) without a canvas.
 */
export type RGB = readonly [number, number, number];

export const TILE = 16;

/** Parses `#rrggbb`. */
export function hex(h: string): RGB {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Parses a list of `#rrggbb` colours. */
export function pal(...hs: string[]): RGB[] {
  return hs.map(hex);
}

export function shade(c: RGB, f: number): RGB {
  return [clamp255(c[0] * f), clamp255(c[1] * f), clamp255(c[2] * f)];
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [clamp255(a[0] + (b[0] - a[0]) * t), clamp255(a[1] + (b[1] - a[1]) * t), clamp255(a[2] + (b[2] - a[2]) * t)];
}

function clamp255(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : Math.round(n);
}

/** A 16×16 RGBA tile. */
export class Tile {
  readonly size: number;
  readonly data: Uint8ClampedArray;

  constructor(size = TILE) {
    this.size = size;
    this.data = new Uint8ClampedArray(size * size * 4);
  }

  /** Sets a pixel (wraps coordinates, so painters can draw across edges seamlessly). */
  set(x: number, y: number, c: RGB, a = 255): void {
    const s = this.size;
    const i = ((((y % s) + s) % s) * s + (((x % s) + s) % s)) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = a;
  }

  /** Sets a pixel only if inside the tile (no wrap). */
  put(x: number, y: number, c: RGB, a = 255): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.set(x, y, c, a);
  }

  get(x: number, y: number): [number, number, number, number] {
    const s = this.size;
    const i = ((((y % s) + s) % s) * s + (((x % s) + s) % s)) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  alpha(x: number, y: number): number {
    return this.get(x, y)[3];
  }

  /** Multiplies a pixel's colour by f. */
  tint(x: number, y: number, f: number): void {
    const [r, g, b, a] = this.get(x, y);
    this.set(x, y, [clamp255(r * f), clamp255(g * f), clamp255(b * f)], a);
  }

  fill(c: RGB, a = 255): void {
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) this.set(x, y, c, a);
  }

  rect(x0: number, y0: number, w: number, h: number, c: RGB, a = 255): void {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.put(x, y, c, a);
  }

  clear(): void {
    this.data.fill(0);
  }

  copyFrom(other: Tile): void {
    this.data.set(other.data);
  }
}

/** Seeded, tileable 2D value noise with `cells` lattice cells across the tile. Returns 0..1. */
export function tileNoise(rng: () => number, cells: number, size = TILE): (x: number, y: number) => number {
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
  const step = size / cells;
  return (x: number, y: number) => {
    const fx = x / step;
    const fy = y / step;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = smooth(fx - x0);
    const ty = smooth(fy - y0);
    const a = lattice[mod(y0, cells) * cells + mod(x0, cells)];
    const b = lattice[mod(y0, cells) * cells + mod(x0 + 1, cells)];
    const c = lattice[mod(y0 + 1, cells) * cells + mod(x0, cells)];
    const d = lattice[mod(y0 + 1, cells) * cells + mod(x0 + 1, cells)];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

export function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** Picks a palette entry for v in 0..1. */
export function pick(p: readonly RGB[], v: number): RGB {
  return p[Math.max(0, Math.min(p.length - 1, Math.floor(v * p.length)))];
}

/** Fills the tile with palette colours driven by blotchy noise plus per-pixel grain. */
export function noiseFill(t: Tile, rng: () => number, p: readonly RGB[], cells = 4, grain = 0.35): void {
  const n = tileNoise(rng, cells);
  for (let y = 0; y < t.size; y++)
    for (let x = 0; x < t.size; x++) t.set(x, y, pick(p, n(x, y) * (1 - grain) + rng() * grain));
}

/** Scatters `count` single pixels from the palette. */
export function speckle(t: Tile, rng: () => number, p: readonly RGB[], count: number, alpha = 255): void {
  for (let i = 0; i < count; i++) t.set(Math.floor(rng() * t.size), Math.floor(rng() * t.size), p[Math.floor(rng() * p.length)], alpha);
}

/** Draws a 1px line (Bresenham). */
export function line(t: Tile, x0: number, y0: number, x1: number, y1: number, c: RGB, a = 255): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    t.put(x0, y0, c, a);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/** Voronoi cells on a wrapping tile. Returns per-pixel {cell index, edge distance}. */
export function voronoi(rng: () => number, count: number, size = TILE): { cell: Int8Array; edge: Float32Array } {
  const pts: [number, number][] = [];
  for (let i = 0; i < count; i++) pts.push([rng() * size, rng() * size]);
  const cell = new Int8Array(size * size);
  const edge = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let best = 1e9;
      let second = 1e9;
      let bi = 0;
      for (let i = 0; i < pts.length; i++) {
        let dx = Math.abs(x + 0.5 - pts[i][0]);
        let dy = Math.abs(y + 0.5 - pts[i][1]);
        if (dx > size / 2) dx = size - dx;
        if (dy > size / 2) dy = size - dy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < best) {
          second = best;
          best = d;
          bi = i;
        } else if (d < second) second = d;
      }
      cell[y * size + x] = bi;
      edge[y * size + x] = second - best;
    }
  return { cell, edge };
}

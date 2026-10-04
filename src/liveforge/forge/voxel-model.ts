/**
 * VoxelModel rendering (forge.thing models): one merged, face-culled mesh with vertex colours and a slight
 * per-voxel shade noise for a hand-crafted look, optional limb parts split out for animation, and isometric
 * snapshots painted on a 2D canvas (hotbar icons, atlas tiles for dropped items, the result card).
 *
 * Model space: voxels 0..size-1 per axis, +Y up. Creatures face +Z; held items point up +Y with the grip at `pivot`.
 */
import * as THREE from 'three';
import { expandVoxelModel, type ThingPart, type VoxelModel } from '@liveforge/sdk';

/** One expanded voxel with its colour as linear RGB 0..1 and the source hex. */
export interface Vox {
  x: number;
  y: number;
  z: number;
  color: string;
}

export interface ExpandedVoxels {
  voxels: Vox[];
  size: [number, number, number];
}

const expandCache = new WeakMap<VoxelModel, ExpandedVoxels>();

/** Expands a model (cached per model object). Never throws: a broken model becomes one grey voxel. */
export function expand(model: VoxelModel): ExpandedVoxels {
  let e = expandCache.get(model);
  if (e) return e;
  try {
    const r = expandVoxelModel(model);
    e = { voxels: r.voxels.map((v) => ({ x: v.x, y: v.y, z: v.z, color: v.color })), size: [r.size[0], r.size[1], r.size[2]] };
  } catch (err) {
    console.warn('[forge] model did not expand', err);
    e = { voxels: [{ x: 0, y: 0, z: 0, color: '#9a9a9a' }], size: [1, 1, 1] };
  }
  if (!e.voxels.length) e.voxels.push({ x: 0, y: 0, z: 0, color: '#9a9a9a' });
  expandCache.set(model, e);
  return e;
}

/** Real bounds of the voxels (min inclusive, max exclusive), in voxels. */
export function voxelBounds(vox: readonly Vox[]): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const v of vox) {
    min[0] = Math.min(min[0], v.x);
    min[1] = Math.min(min[1], v.y);
    min[2] = Math.min(min[2], v.z);
    max[0] = Math.max(max[0], v.x + 1);
    max[1] = Math.max(max[1], v.y + 1);
    max[2] = Math.max(max[2], v.z + 1);
  }
  return { min, max };
}

const hash3 = (x: number, y: number, z: number) => {
  let h = Math.imul(x * 73856093 ^ y * 19349663 ^ z * 83492791, 0x9e3779b1);
  h ^= h >>> 15;
  return ((h >>> 0) % 1000) / 1000;
};

export interface GeometryOptions {
  /** Units per voxel. Default 1/16 (one voxel = one pixel of a block). */
  unit?: number;
  /** Model-space point placed at the origin. Default: bottom centre of the model box ([sx/2, 0, sz/2]). */
  origin?: readonly [number, number, number];
  /** Bake a fixed per-face shade (for unlit MeshBasic materials). Default false (lit materials). */
  faceShade?: boolean;
  /** Only these voxels (default all). Faces against voxels outside the subset are still culled when `solid` has them. */
  subset?: readonly Vox[];
}

/** Builds a merged, face-culled geometry with vertex colours. */
export function voxelGeometry(model: VoxelModel, opts: GeometryOptions = {}): THREE.BufferGeometry {
  const { voxels, size } = expand(model);
  const unit = opts.unit ?? 1 / 16;
  const o = opts.origin ?? [size[0] / 2, 0, size[2] / 2];
  const solid = new Set<number>();
  const k = (x: number, y: number, z: number) => (x + 64) * 16384 + (y + 64) * 128 + (z + 64);
  for (const v of voxels) solid.add(k(v.x, v.y, v.z));
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  const FACES: { n: [number, number, number]; shade: number; quad: [number, number, number][] }[] = [
    { n: [1, 0, 0], shade: 0.72, quad: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
    { n: [-1, 0, 0], shade: 0.72, quad: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
    { n: [0, 1, 0], shade: 1, quad: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
    { n: [0, -1, 0], shade: 0.5, quad: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { n: [0, 0, 1], shade: 0.85, quad: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
    { n: [0, 0, -1], shade: 0.85, quad: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
  ];
  for (const v of opts.subset ?? voxels) {
    c.set(v.color);
    const noise = 0.9 + hash3(v.x, v.y, v.z) * 0.14;
    for (const f of FACES) {
      if (solid.has(k(v.x + f.n[0], v.y + f.n[1], v.z + f.n[2]))) continue;
      const s = noise * (opts.faceShade ? f.shade : 1);
      const q = f.quad.map(([a, b, d]) => [(v.x + a - o[0]) * unit, (v.y + b - o[1]) * unit, (v.z + d - o[2]) * unit]);
      for (const i of [0, 1, 2, 0, 2, 3]) {
        pos.push(q[i][0], q[i][1], q[i][2]);
        nor.push(f.n[0], f.n[1], f.n[2]);
        col.push(c.r * s, c.g * s, c.b * s);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/** A lit voxel mesh (MeshLambert, for world entities: creatures, decorations, wearables). */
export function voxelMesh(model: VoxelModel, opts: GeometryOptions & { material?: THREE.Material } = {}): THREE.Mesh {
  const mat = opts.material ?? new THREE.MeshLambertMaterial({ vertexColors: true });
  return new THREE.Mesh(voxelGeometry(model, opts), mat);
}

// ---------------------------------------------------------------- parts (creature limbs)

/** A limb split out of the body: its voxels, its joint (model space) and how it animates. */
export interface SplitPart {
  name: string;
  voxels: Vox[];
  joint: [number, number, number];
  kind: 'leg' | 'wing' | 'head' | 'tail' | 'other';
  /** -1 left (x below centre), 1 right, 0 middle. */
  side: number;
  /** -1 front half (+z), 1 back half. */
  fore: number;
}

/** Splits limb boxes out of the model. Voxels in no part stay in `body`. Parts with no voxels are dropped. */
export function splitParts(model: VoxelModel, parts: readonly ThingPart[] | undefined): { body: Vox[]; parts: SplitPart[] } {
  const { voxels, size } = expand(model);
  if (!parts?.length) return { body: voxels, parts: [] };
  const taken = new Set<Vox>();
  const out: SplitPart[] = [];
  const cx = size[0] / 2, cz = size[2] / 2;
  for (const p of parts) {
    const lo = [0, 1, 2].map((i) => Math.min(p.from[i], p.to[i]));
    const hi = [0, 1, 2].map((i) => Math.max(p.from[i], p.to[i]));
    const vs = voxels.filter((v) => !taken.has(v) && v.x >= lo[0] && v.x <= hi[0] && v.y >= lo[1] && v.y <= hi[1] && v.z >= lo[2] && v.z <= hi[2]);
    if (!vs.length) continue;
    for (const v of vs) taken.add(v);
    const n = p.name.toLowerCase();
    const kind: SplitPart['kind'] = /leg|foot|feet|paw|arm|claw/.test(n) ? 'leg' : /wing|fin|flipper/.test(n) ? 'wing' : /head|neck|beak|face/.test(n) ? 'head' : /tail/.test(n) ? 'tail' : 'other';
    const mx = (lo[0] + hi[0] + 1) / 2, mz = (lo[2] + hi[2] + 1) / 2;
    const side = /left/.test(n) ? -1 : /right/.test(n) ? 1 : Math.abs(mx - cx) < 0.6 ? 0 : mx < cx ? -1 : 1;
    const fore = /front|fore/.test(n) ? -1 : /back|hind|rear/.test(n) ? 1 : mz >= cz ? -1 : 1;
    let joint: [number, number, number];
    if (kind === 'leg') joint = [mx, hi[1] + 1, mz];
    else if (kind === 'wing') joint = [side < 0 ? hi[0] + 1 : side > 0 ? lo[0] : mx, hi[1] + 1, mz];
    else if (kind === 'head') joint = [mx, lo[1], lo[2]];
    else if (kind === 'tail') joint = [mx, (lo[1] + hi[1] + 1) / 2, hi[2] + 1];
    else joint = [mx, (lo[1] + hi[1] + 1) / 2, mz];
    out.push({ name: p.name, voxels: vs, joint, kind, side, fore });
  }
  return { body: voxels.filter((v) => !taken.has(v)), parts: out };
}

// ---------------------------------------------------------------- isometric snapshots

const hexRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [154, 154, 154];
};
const css = (rgb: [number, number, number], f: number) => `rgb(${Math.min(255, Math.round(rgb[0] * f))},${Math.min(255, Math.round(rgb[1] * f))},${Math.min(255, Math.round(rgb[2] * f))})`;

export interface IsoOptions {
  /** Canvas size in px (square). Default 32. */
  size?: number;
  /** Padding in px. Default size / 16. */
  pad?: number;
  /** Turn the model a quarter turn first (items that are thin on z read better side-on). Default auto. */
  turn?: boolean;
  /** Draw thin outlines between cubes (larger snapshots). Default size >= 64. */
  outline?: boolean;
}

/**
 * Paints an isometric snapshot of a model (viewed from +x +y +z, front faces lit) onto a fresh canvas. Painter's
 * order, only exposed faces, fitted and centred.
 */
export function isoCanvas(model: VoxelModel, opts: IsoOptions = {}): HTMLCanvasElement {
  const S = opts.size ?? 32;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  paintIso(canvas, model, opts);
  return canvas;
}

/** Paints the isometric snapshot into an existing canvas (cleared first). */
export function paintIso(canvas: HTMLCanvasElement, model: VoxelModel, opts: IsoOptions = {}): void {
  const S = canvas.width;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, S, canvas.height);
  const { voxels, size } = expand(model);
  // thin-on-x models (a flat sword in the x/y plane is fine; one flat on z/y) turn so their broad side shows
  const b = voxelBounds(voxels);
  const w = b.max[0] - b.min[0], d = b.max[2] - b.min[2];
  const turn = opts.turn ?? (w <= 2 && d > w);
  const vox = turn ? voxels.map((v) => ({ ...v, x: v.z, z: size[0] - 1 - v.x })) : voxels;
  const solid = new Set<string>(vox.map((v) => `${v.x},${v.y},${v.z}`));
  const has = (x: number, y: number, z: number) => solid.has(`${x},${y},${z}`);
  const P = (x: number, y: number, z: number): [number, number] => [(x - z), (x + z) / 2 - y];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const v of vox) {
    for (const [a, bb, c] of [[0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1], [0, 1, 0], [1, 1, 0], [0, 1, 1], [1, 1, 1]]) {
      const [px, py] = P(v.x + a, v.y + bb, v.z + c);
      x0 = Math.min(x0, px);
      x1 = Math.max(x1, px);
      y0 = Math.min(y0, py);
      y1 = Math.max(y1, py);
    }
  }
  const pad = opts.pad ?? Math.max(1, S / 16);
  const scale = Math.min((S - pad * 2) / Math.max(0.001, x1 - x0), (canvas.height - pad * 2) / Math.max(0.001, y1 - y0));
  const ox = (S - (x1 - x0) * scale) / 2 - x0 * scale;
  const oy = (canvas.height - (y1 - y0) * scale) / 2 - y0 * scale;
  const tx = (x: number, y: number, z: number): [number, number] => {
    const [px, py] = P(x, y, z);
    return [ox + px * scale, oy + py * scale];
  };
  const sorted = [...vox].sort((a, bb) => a.x + a.y + a.z - (bb.x + bb.y + bb.z) || a.y - bb.y);
  const outline = opts.outline ?? S >= 64;
  ctx.lineJoin = 'round';
  const quad = (pts: [number, number][], fill: string) => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = outline ? 'rgba(0,0,0,0.18)' : fill;
    ctx.lineWidth = outline ? Math.max(0.5, scale * 0.06) : 0.6;
    ctx.stroke();
  };
  for (const v of sorted) {
    const rgb = hexRgb(v.color);
    const n = 0.92 + hash3(v.x, v.y, v.z) * 0.12;
    const { x, y, z } = v;
    if (!has(x, y + 1, z)) quad([tx(x, y + 1, z), tx(x + 1, y + 1, z), tx(x + 1, y + 1, z + 1), tx(x, y + 1, z + 1)], css(rgb, 1.08 * n));
    if (!has(x, y, z + 1)) quad([tx(x, y, z + 1), tx(x + 1, y, z + 1), tx(x + 1, y + 1, z + 1), tx(x, y + 1, z + 1)], css(rgb, 0.86 * n));
    if (!has(x + 1, y, z)) quad([tx(x + 1, y, z), tx(x + 1, y + 1, z), tx(x + 1, y + 1, z + 1), tx(x + 1, y, z + 1)], css(rgb, 0.66 * n));
  }
}

/** A 16×16 RGBA snapshot (atlas tile: dropped-item sprites and the held fallback). */
export function isoPixels(model: VoxelModel): Uint8ClampedArray {
  const c = isoCanvas(model, { size: 16, pad: 0.5, outline: false });
  return c.getContext('2d')!.getImageData(0, 0, 16, 16).data;
}

// ---------------------------------------------------------------- generated models (eggs, wands)

const shadeHex = (hex: string, f: number) => {
  const [r, g, b] = hexRgb(hex);
  const t = (v: number) => Math.max(0, Math.min(255, Math.round(f >= 0 ? v + (255 - v) * f : v * (1 + f))));
  return `#${[t(r), t(g), t(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
};

/** The main colours of a model palette, most used first. */
export function mainColors(model: VoxelModel, n = 3): string[] {
  const counts = new Map<string, number>();
  for (const v of expand(model).voxels) counts.set(v.color, (counts.get(v.color) ?? 0) + 1);
  const out = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  while (out.length < n) out.push(out[0] ?? '#9a9a9a');
  return out.slice(0, n);
}

/** A spawn egg: an 8×10×8 egg in the creature's main colour with spots of its second and third colours. */
export function eggModel(colors: readonly string[]): VoxelModel {
  const base = colors[0] ?? '#f4f0e0', spot = colors[1] ?? shadeHex(base, -0.35), spot2 = colors[2] ?? spot;
  return {
    size: [8, 10, 8],
    pivot: [3.5, 0, 3.5],
    palette: { shell: base, spot, spot2, shine: shadeHex(base, 0.45) },
    ops: [
      { op: 'cylinder', center: [3, 0, 3], radius: 2, height: 1, block: 'shell' },
      { op: 'cylinder', center: [3, 1, 3], radius: 3, height: 4, block: 'shell' },
      { op: 'cylinder', center: [3, 5, 3], radius: 3, height: 2, block: 'shell' },
      { op: 'cylinder', center: [3, 7, 3], radius: 2, height: 2, block: 'shell' },
      { op: 'cylinder', center: [3, 9, 3], radius: 1, height: 1, block: 'shell' },
      { op: 'block', at: [6, 3, 4], block: 'spot' },
      { op: 'block', at: [4, 5, 6], block: 'spot' },
      { op: 'block', at: [2, 2, 6], block: 'spot2' },
      { op: 'block', at: [6, 6, 2], block: 'spot2' },
      { op: 'block', at: [5, 7, 5], block: 'spot' },
      { op: 'block', at: [4, 7, 5], block: 'shine' },
    ],
  } as unknown as VoxelModel;
}

/** A spell wand: a wooden staff with a glowing gem head in the spell's colours (grip at the bottom, up +Y). */
export function wandModel(colors: readonly string[]): VoxelModel {
  const gem = colors[0] ?? '#8a4fd0', glow = colors[1] ?? shadeHex(gem, 0.5), trim = colors[2] ?? '#f2c230';
  return {
    size: [5, 15, 5],
    pivot: [2, 0, 2],
    palette: { wood: '#7a5230', dark: '#4a3020', trim, gem, glow },
    ops: [
      { op: 'line', from: [2, 0, 2], to: [2, 10, 2], block: 'wood' },
      { op: 'block', at: [2, 0, 2], block: 'dark' },
      { op: 'block', at: [2, 3, 2], block: 'dark' },
      { op: 'box', from: [1, 10, 1], to: [3, 10, 3], block: 'trim' },
      { op: 'box', from: [1, 11, 1], to: [3, 13, 3], block: 'gem' },
      { op: 'block', at: [2, 14, 2], block: 'glow' },
      { op: 'block', at: [0, 12, 2], block: 'glow' },
      { op: 'block', at: [4, 12, 2], block: 'glow' },
      { op: 'block', at: [2, 12, 0], block: 'glow' },
      { op: 'block', at: [2, 12, 4], block: 'glow' },
    ],
  } as unknown as VoxelModel;
}

/** A full block (block-category things): the model's main colours on a 16³ cube with a darker rim and speckles. */
export function cubeModel(colors: readonly string[]): VoxelModel {
  const main = colors[0] ?? '#9a9a9a', b = colors[1] ?? shadeHex(main, -0.2), c = colors[2] ?? shadeHex(main, 0.2);
  return {
    size: [16, 16, 16],
    pivot: [8, 0, 8],
    palette: { main, rim: shadeHex(main, -0.25), b, c },
    ops: [
      { op: 'box', from: [0, 0, 0], to: [15, 15, 15], block: 'main' },
      { op: 'edges', from: [0, 0, 0], to: [15, 15, 15], block: 'rim' },
      { op: 'box', from: [3, 15, 3], to: [5, 15, 5], block: 'b' },
      { op: 'box', from: [10, 15, 9], to: [12, 15, 11], block: 'c' },
      { op: 'box', from: [15, 4, 3], to: [15, 6, 5], block: 'b' },
      { op: 'box', from: [9, 9, 15], to: [11, 11, 15], block: 'c' },
      { op: 'box', from: [15, 10, 10], to: [15, 12, 12], block: 'c' },
      { op: 'box', from: [3, 3, 15], to: [5, 5, 15], block: 'b' },
    ],
  } as unknown as VoxelModel;
}

export { shadeHex };

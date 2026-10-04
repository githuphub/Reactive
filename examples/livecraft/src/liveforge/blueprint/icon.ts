/**
 * Blueprint icon: a 16×16 pixel-art paper scroll (rolled ends) with a tiny building drawn in the plan's main block
 * colours, plus a few magic sparkles.
 */
import type { Pixels } from '../forge/pixel';

const S = 16;

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [180, 180, 180];
}

const shade = (c: [number, number, number], f: number): [number, number, number] => [Math.min(255, c[0] * f), Math.min(255, c[1] * f), Math.min(255, c[2] * f)];

/** Paints the scroll. `colors` = [walls, roof, accent] (#rrggbb); `seed` places the sparkles. */
export function paintScroll(colors: readonly string[], seed: number): Pixels {
  const out = new Uint8ClampedArray(S * S * 4);
  const put = (x: number, y: number, c: [number, number, number]) => out.set([c[0], c[1], c[2], 255], (y * S + x) * 4);
  const paper = rgb('#efe0b4'), paperEdge = rgb('#cdb27a'), roll = rgb('#dcc48c'), rollDark = rgb('#a88750'), rollEnd = rgb('#6b4a26');
  const wall = rgb(colors[0] ?? '#9a9a9a'), roof = rgb(colors[1] ?? colors[0] ?? '#7a4a2a'), accent = rgb(colors[2] ?? '#b48cff');
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const rollRow = y === 1 || y === 2 || y === 13 || y === 14;
    if (rollRow && x >= 1 && x <= 14) put(x, y, x === 1 || x === 14 ? rollEnd : y === 1 || y === 13 ? roll : rollDark);
    else if (y >= 3 && y <= 12 && x >= 2 && x <= 13) put(x, y, x === 2 || x === 13 ? paperEdge : paper);
  }
  // the building: a roof triangle over a wall block, a door and two lit windows
  for (let r = 0; r < 3; r++) for (let x = 7 - r; x <= 8 + r; x++) put(x, 4 + r, r === 2 ? shade(roof, 0.8) : roof);
  for (let y = 7; y <= 11; y++) for (let x = 5; x <= 10; x++) put(x, y, x === 5 || x === 10 ? shade(wall, 0.75) : wall);
  for (let y = 10; y <= 11; y++) for (let x = 7; x <= 8; x++) put(x, y, rgb('#3a2a1a'));
  put(6, 8, rgb('#ffe9a0'));
  put(9, 8, rgb('#ffe9a0'));
  // sparkles
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let k = 0; k < 3; k++) {
    const x = 3 + Math.floor(rnd() * 10), y = 3 + Math.floor(rnd() * 3);
    if (x < 6 || x > 9) put(x, y, k === 0 ? rgb('#ffffff') : accent);
  }
  return out;
}

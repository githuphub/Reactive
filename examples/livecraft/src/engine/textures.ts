/**
 * Procedural 16×16 texture painters, keyed by texture name. All art is original and generated
 * here from seeded noise; nothing is loaded from disk. Register more with {@link registerTexture}.
 */
import { hashString, mulberry32 } from './random';
import {
  Tile, hex, line, mix, mod, noiseFill, pal, pick, shade, speckle, tileNoise, voronoi, type RGB,
} from './paint';

/** Paints one frame of a texture into `t` (already cleared to transparent). */
export type Painter = (t: Tile, rng: () => number, frame: number, frames: number) => void;

export interface TextureDef {
  painter: Painter;
  /** Animation frames (laid out side by side in the atlas). Default 1. */
  frames: number;
  /** Edge padding mode in the atlas: `wrap` for tiling textures, `clamp` for sprites. */
  pad: 'wrap' | 'clamp';
}

const registry = new Map<string, TextureDef>();

/** Registers (or replaces) a texture painter. */
export function registerTexture(key: string, painter: Painter, opts: Partial<Omit<TextureDef, 'painter'>> = {}): void {
  registry.set(key, { painter, frames: opts.frames ?? 1, pad: opts.pad ?? 'wrap' });
}

export function getTextureDef(key: string): TextureDef {
  return registry.get(key) ?? { painter: missingPainter, frames: 1, pad: 'wrap' };
}

export function hasTexture(key: string): boolean {
  return registry.has(key);
}

/** Paints a texture frame into a fresh tile using the key-seeded RNG (deterministic). */
export function paintTexture(key: string, frame = 0): Tile {
  const def = getTextureDef(key);
  const t = new Tile();
  def.painter(t, mulberry32(hashString(key)), frame, def.frames);
  return t;
}

const missingPainter: Painter = (t) => {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) t.set(x, y, ((x >> 3) ^ (y >> 3)) & 1 ? hex('#f0f') : hex('#111'));
};

// ---------------------------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------------------------

const STONE = pal('#6c6c6c', '#777777', '#808080', '#8a8a8a', '#939393');
const DIRT = pal('#6b4a31', '#79553a', '#866043', '#93694a');
const GRASS = pal('#4c8631', '#58963a', '#64a442', '#71b44b', '#7fc154');
const SNOW = pal('#dfe8f3', '#e9f0f8', '#f3f7fc', '#ffffff');
const SAND = pal('#d1c48a', '#d9cf98', '#e0d7a6', '#e7dfb4');
const WOOD = {
  oak: { bark: pal('#4a3520', '#57402a', '#634a30', '#6f5537'), inner: pal('#9c7647', '#b48a56'), planks: pal('#8f6c3e', '#9c7747', '#a7824f', '#b28c58') },
  birch: { bark: pal('#d9d4c5', '#e4e0d4', '#eeebe2', '#f6f4ee'), inner: pal('#c4b282', '#d8c79a'), planks: pal('#bfae78', '#cab984', '#d4c48e', '#dccd99') },
  spruce: { bark: pal('#2c2013', '#352717', '#3e2e1c', '#473521'), inner: pal('#68492a', '#7a5a36'), planks: pal('#5c4024', '#664829', '#70502e', '#7a5834') },
};
const LEAVES = {
  oak: pal('#2f6a20', '#3a7a27', '#46892e', '#529836', '#5fa73e'),
  birch: pal('#557f2e', '#628f37', '#6f9e40', '#7cad4a'),
  spruce: pal('#21452c', '#2a5335', '#33613e', '#3d6f48'),
};
const HANDLE = pal('#5a3e1e', '#8a6438');

// ---------------------------------------------------------------------------------------------
// Natural blocks
// ---------------------------------------------------------------------------------------------

function stone(t: Tile, rng: () => number): void {
  noiseFill(t, rng, STONE, 4, 0.4);
  for (let i = 0; i < 5; i++) {
    const x = Math.floor(rng() * 16);
    const y = Math.floor(rng() * 16);
    const len = 2 + Math.floor(rng() * 3);
    for (let k = 0; k < len; k++) t.set(x + k, y + (k > 1 && rng() < 0.4 ? 1 : 0), hex('#5f5f5f'));
  }
}
registerTexture('stone', stone);

function dirt(t: Tile, rng: () => number): void {
  noiseFill(t, rng, DIRT, 4, 0.5);
  speckle(t, rng, pal('#a07b5a', '#5a3d27'), 14);
}
registerTexture('dirt', dirt);

registerTexture('grass_top', (t, rng) => {
  noiseFill(t, rng, GRASS, 4, 0.55);
  speckle(t, rng, pal('#8ccf5c', '#3f7428'), 18);
});

function sideWithCap(t: Tile, rng: () => number, cap: readonly RGB[], edge: RGB): void {
  dirt(t, rng);
  for (let x = 0; x < 16; x++) {
    const d = 3 + (rng() < 0.5 ? 1 : 0) + (rng() < 0.25 ? 1 : 0) - (rng() < 0.15 ? 1 : 0);
    for (let y = 0; y < d; y++) t.set(x, y, pick(cap, rng()));
    t.set(x, d, edge);
    if (rng() < 0.2) t.set(x, d + 1, edge);
  }
}
registerTexture('grass_side', (t, rng) => sideWithCap(t, rng, GRASS, hex('#467a2d')));
registerTexture('snowy_grass_side', (t, rng) => sideWithCap(t, rng, SNOW, hex('#c9d6e6')));
registerTexture('snow', (t, rng) => {
  noiseFill(t, rng, SNOW, 4, 0.5);
  speckle(t, rng, pal('#cbd8ea'), 8);
});

registerTexture('sand', (t, rng) => {
  noiseFill(t, rng, SAND, 8, 0.7);
  speckle(t, rng, pal('#c4b67c', '#efe8c6'), 12);
});
registerTexture('sandstone_top', (t, rng) => {
  noiseFill(t, rng, SAND, 4, 0.3);
  speckle(t, rng, pal('#c9bb80'), 6);
});
registerTexture('sandstone', (t, rng) => {
  noiseFill(t, rng, SAND, 8, 0.4);
  for (let x = 0; x < 16; x++) {
    t.set(x, 0, hex('#e9e1b9'));
    t.set(x, 1, hex('#e2d9ab'));
    t.set(x, 4, shade(pick(SAND, rng()), 0.92));
    t.set(x, 10, shade(pick(SAND, rng()), 0.9));
    t.set(x, 14, hex('#c8ba7f'));
    t.set(x, 15, hex('#bfb075'));
  }
});

registerTexture('gravel', (t, rng) => {
  t.fill(hex('#77716c'));
  noiseFill(t, rng, pal('#6e6863', '#7a746f', '#857f79'), 8, 0.6);
  const stones = pal('#8e8a86', '#6b6662', '#9c958e', '#5c5753', '#a08c7a', '#7c6d61');
  for (let i = 0; i < 20; i++) {
    const cx = Math.floor(rng() * 16);
    const cy = Math.floor(rng() * 16);
    const c = stones[Math.floor(rng() * stones.length)];
    t.set(cx, cy, c);
    t.set(cx + 1, cy, shade(c, 0.85));
    t.set(cx, cy + 1, shade(c, 0.75));
    t.set(cx + 1, cy + 1, shade(c, 0.7));
    t.set(cx, cy - 1, shade(c, 1.15));
  }
});

registerTexture('clay', (t, rng) => {
  noiseFill(t, rng, pal('#8f96a3', '#9aa1ae', '#a4abb9', '#adb4c1'), 2, 0.3);
  speckle(t, rng, pal('#b9bfcb'), 6);
});

registerTexture('ice', (t, rng) => {
  noiseFill(t, rng, pal('#8fb6ec', '#9cc1f2', '#a8cbf6'), 2, 0.3);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) t.set(x, y, t.get(x, y) as unknown as RGB, 175);
  for (let i = 0; i < 3; i++) {
    const x0 = Math.floor(rng() * 16);
    const y0 = Math.floor(rng() * 16);
    for (let k = 0; k < 4; k++) t.set(x0 + k, y0 - k, hex('#e6f2ff'), 220);
  }
});

registerTexture(
  'water',
  (t, rng, frame, frames) => {
    const p = pal('#2a52b5', '#2b59c3', '#3065cf', '#3870d8', '#4079de');
    const n = tileNoise(rng, 4);
    const ph = (frame / frames) * Math.PI * 2;
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const w = Math.sin((x / 16) * Math.PI * 2 + (y / 16) * Math.PI * 4 + ph) * 0.5 + 0.5;
        const v = w * 0.6 + n(x, y) * 0.4;
        t.set(x, y, pick(p, v), 165);
        if (v > 0.86) t.set(x, y, hex('#6b9bf0'), 190);
      }
  },
  { frames: 4 },
);

registerTexture(
  'lava',
  (t, rng, frame, frames) => {
    const p = pal('#8a2a0c', '#c2410c', '#e2570e', '#f97316', '#fb923c', '#fdba74', '#ffd28a');
    const n = tileNoise(rng, 4);
    const ph = (frame / frames) * Math.PI * 2;
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const w = Math.sin((x / 16) * Math.PI * 2 + ph) * Math.cos((y / 16) * Math.PI * 4 - ph) * 0.5 + 0.5;
        t.set(x, y, pick(p, w * 0.55 + n(x, y) * 0.45));
      }
  },
  { frames: 4 },
);

registerTexture('bedrock', (t, rng) => {
  noiseFill(t, rng, pal('#1c1c1c', '#2d2d2d', '#3e3e3e', '#555555', '#6a6a6a'), 8, 0.8);
});

registerTexture('obsidian', (t, rng) => {
  noiseFill(t, rng, pal('#0f0a18', '#140d20', '#1a1028', '#211534'), 4, 0.5);
  speckle(t, rng, pal('#3b2360', '#4b2d73', '#6a46a0'), 10);
});

// Ores ----------------------------------------------------------------------------------------

function ore(colors: readonly RGB[]): Painter {
  return (t, rng) => {
    stone(t, rng);
    const clusters = 4 + Math.floor(rng() * 2);
    for (let i = 0; i < clusters; i++) {
      const cx = 2 + Math.floor(rng() * 12);
      const cy = 2 + Math.floor(rng() * 12);
      const n = 3 + Math.floor(rng() * 3);
      for (let k = 0; k < n; k++) {
        const x = cx + Math.floor(rng() * 3) - 1;
        const y = cy + Math.floor(rng() * 3) - 1;
        t.set(x, y, colors[1]);
        t.set(x + 1, y + 1, colors[2]);
      }
      t.set(cx, cy, colors[0]);
    }
  };
}
registerTexture('coal_ore', ore(pal('#4a4a4a', '#232323', '#111111')));
registerTexture('iron_ore', ore(pal('#f1d5bd', '#d8af93', '#a87b5c')));
registerTexture('gold_ore', ore(pal('#fff7a6', '#fcdf3b', '#c99a10')));
registerTexture('diamond_ore', ore(pal('#d2fdff', '#5decf5', '#1fa3ad')));
registerTexture('redstone_ore', ore(pal('#ff7a7a', '#d81b1b', '#8a0b0b')));

// Wood ----------------------------------------------------------------------------------------

function bark(p: readonly RGB[], birch = false): Painter {
  return (t, rng) => {
    for (let x = 0; x < 16; x++) {
      const base = Math.floor(rng() * p.length);
      for (let y = 0; y < 16; y++) {
        const v = Math.max(0, Math.min(p.length - 1, base + (rng() < 0.3 ? (rng() < 0.5 ? -1 : 1) : 0)));
        t.set(x, y, p[v]);
      }
    }
    if (birch) {
      for (let i = 0; i < 9; i++) {
        const x = Math.floor(rng() * 16);
        const y = Math.floor(rng() * 16);
        const len = 2 + Math.floor(rng() * 3);
        for (let k = 0; k < len; k++) t.set(x + k, y, k === 0 || k === len - 1 ? hex('#5a5a50') : hex('#2b2b2b'));
      }
    } else {
      for (let i = 0; i < 4; i++) {
        const x = Math.floor(rng() * 16);
        const y = Math.floor(rng() * 16);
        const len = 3 + Math.floor(rng() * 6);
        for (let k = 0; k < len; k++) t.set(x, y + k, shade(p[0], 0.75));
      }
    }
  };
}

function logTop(inner: readonly RGB[], barkP: readonly RGB[]): Painter {
  return (t, rng) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
        if (d > 6.6) t.set(x, y, pick(barkP, rng()));
        else {
          const ring = Math.floor(d + rng() * 0.6) % 2;
          t.set(x, y, shade(inner[ring], 0.95 + rng() * 0.1));
        }
      }
    t.set(7, 7, shade(inner[0], 0.8));
    t.set(8, 8, shade(inner[0], 0.85));
  };
}

function planks(p: readonly RGB[]): Painter {
  return (t, rng) => {
    for (let row = 0; row < 4; row++) {
      const joint = Math.floor(rng() * 16);
      const n = tileNoise(rng, 2);
      for (let yy = 0; yy < 4; yy++) {
        const y = row * 4 + yy;
        for (let x = 0; x < 16; x++) {
          let c = pick(p.slice(1), n(x, yy * 2) * 0.7 + rng() * 0.3);
          if (yy === 3) c = shade(p[0], 0.82);
          else if (x === joint && yy < 3) c = shade(p[0], 0.75);
          else if (yy === 0) c = shade(c, 1.06);
          t.set(x, y, c);
        }
      }
      if (rng() < 0.5) t.set(mod(joint + 2, 16), row * 4 + 1, shade(p[0], 0.6));
    }
  };
}

function leavesPainter(p: readonly RGB[]): Painter {
  return (t, rng) => {
    const n = tileNoise(rng, 4);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const v = n(x, y) * 0.5 + rng() * 0.5;
        if (rng() < 0.16 + (1 - n(x, y)) * 0.08) continue; // hole
        t.set(x, y, pick(p, v));
      }
    speckle(t, rng, [shade(p[p.length - 1], 1.15)], 6);
  };
}

for (const w of ['oak', 'birch', 'spruce'] as const) {
  registerTexture(`${w}_log`, bark(WOOD[w].bark, w === 'birch'));
  registerTexture(`${w}_log_top`, logTop(WOOD[w].inner, w === 'birch' ? WOOD.birch.bark : WOOD[w].bark));
  registerTexture(`${w}_planks`, planks(WOOD[w].planks));
  registerTexture(`${w}_leaves`, leavesPainter(LEAVES[w]));
}

// Built blocks --------------------------------------------------------------------------------

registerTexture('cobblestone', (t, rng) => {
  const { cell, edge } = voronoi(rng, 10);
  const p = pal('#6e6e6e', '#7d7d7d', '#8a8a8a', '#959595');
  const tones = Array.from({ length: 10 }, () => p[Math.floor(rng() * p.length)]);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const i = y * 16 + x;
      if (edge[i] < 0.9) t.set(x, y, hex('#4f4f4f'));
      else t.set(x, y, shade(tones[cell[i]], 0.92 + rng() * 0.16 + (edge[i] > 3 ? 0.08 : 0)));
    }
});

registerTexture('mossy_cobblestone', (t, rng) => {
  getTextureDef('cobblestone').painter(t, mulberry32(hashString('cobblestone')), 0, 1);
  const n = tileNoise(rng, 4);
  const moss = pal('#4d6e30', '#5a7d3a', '#678c44');
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (n(x, y) > 0.55 && rng() < 0.85) t.set(x, y, pick(moss, rng()));
});

registerTexture('bricks', (t, rng) => {
  const p = pal('#8e4230', '#9b4a36', '#a85540', '#b3604a');
  const mortar = pal('#a59c94', '#b5aca4');
  for (let row = 0; row < 4; row++) {
    const off = (row % 2) * 4;
    const tones = [p[Math.floor(rng() * 4)], p[Math.floor(rng() * 4)], p[Math.floor(rng() * 4)]];
    for (let yy = 0; yy < 4; yy++)
      for (let x = 0; x < 16; x++) {
        const y = row * 4 + yy;
        const bx = mod(x + off, 16);
        if (yy === 3 || bx % 8 === 7) t.set(x, y, pick(mortar, rng()));
        else {
          const tone = tones[Math.floor(bx / 8)];
          t.set(x, y, shade(tone, (yy === 0 ? 1.08 : 1) * (0.94 + rng() * 0.12)));
        }
      }
  }
});

registerTexture('stone_bricks', (t, rng) => {
  const p = pal('#7a7a7a', '#828282', '#8a8a8a');
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const row = y >> 3;
      const bx = mod(x + (row % 2) * 4, 8);
      const by = y % 8;
      let c = pick(p, rng());
      if (by === 7 || bx === 7) c = hex('#555555');
      else if (by === 0 || bx === 0) c = hex('#9a9a9a');
      else if (by === 6 || bx === 6) c = hex('#6a6a6a');
      t.set(x, y, c);
    }
  speckle(t, rng, pal('#6e6e6e'), 6);
});

function metalBlock(p: readonly RGB[]): Painter {
  return (t, rng) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        let c = shade(p[0], 0.97 + rng() * 0.06);
        if (y % 4 === 1 && x > 1 && x < 14) c = shade(p[0], 0.93);
        if (x === 0 || y === 0) c = p[2];
        if (x === 15 || y === 15) c = p[3];
        if ((x === 1 && y > 0 && y < 15) || (y === 1 && x > 0 && x < 15)) c = mix(p[2], p[0], 0.5);
        t.set(x, y, c);
      }
    for (const [x, y] of [[2, 2], [13, 2], [2, 13], [13, 13]]) t.set(x, y, p[3]);
  };
}
registerTexture('iron_block', metalBlock(pal('#d4d4d4', '#c6c6c6', '#f0f0f0', '#9a9a9a')));
registerTexture('gold_block', metalBlock(pal('#f5d33a', '#e6b820', '#fff09a', '#b8860b')));
registerTexture('diamond_block', metalBlock(pal('#5fe0e8', '#43c9d2', '#c4fbff', '#238a92')));

registerTexture('glass', (t) => {
  const frame = hex('#dbeefe');
  for (let i = 0; i < 16; i++) {
    t.set(i, 0, frame, 235);
    t.set(i, 15, hex('#a9c9e3'), 235);
    t.set(0, i, frame, 235);
    t.set(15, i, hex('#a9c9e3'), 235);
  }
  for (const [x, y] of [[3, 7], [4, 6], [5, 5], [6, 4], [4, 9], [5, 8], [10, 12], [11, 11]]) t.set(x, y, hex('#ffffff'), 200);
});

// Furniture -----------------------------------------------------------------------------------

const oakPlanks = planks(WOOD.oak.planks);

registerTexture('crafting_table_top', (t, rng) => {
  oakPlanks(t, rng, 0, 1);
  const dark = hex('#5a3f20');
  for (let i = 0; i < 16; i++) {
    t.set(i, 0, dark);
    t.set(i, 15, dark);
    t.set(0, i, dark);
    t.set(15, i, dark);
    if (i > 1 && i < 14) {
      t.set(i, 5, shade(dark, 1.3));
      t.set(i, 10, shade(dark, 1.3));
      t.set(5, i, shade(dark, 1.3));
      t.set(10, i, shade(dark, 1.3));
    }
  }
});

function tableSide(tools: (t: Tile) => void): Painter {
  return (t, rng) => {
    oakPlanks(t, rng, 0, 1);
    for (let x = 0; x < 16; x++) {
      t.set(x, 0, hex('#7a5a32'));
      t.set(x, 1, hex('#5a3f20'));
      t.set(x, 15, hex('#4a3318'));
    }
    for (let y = 2; y < 15; y++) {
      t.set(0, y, hex('#5a3f20'));
      t.set(15, y, hex('#5a3f20'));
    }
    tools(t);
  };
}
registerTexture(
  'crafting_table_side',
  tableSide((t) => {
    // saw
    t.rect(2, 5, 6, 2, hex('#b8b8b8'));
    for (let x = 2; x < 8; x += 2) t.set(x, 7, hex('#8a8a8a'));
    t.rect(8, 4, 2, 4, hex('#6b4520'));
    // hammer
    line(t, 12, 12, 12, 6, hex('#6b4520'));
    t.rect(10, 4, 5, 2, hex('#9a9a9a'));
    t.set(10, 5, hex('#6a6a6a'));
  }),
);
registerTexture(
  'crafting_table_front',
  tableSide((t) => {
    // tongs and a chisel
    line(t, 3, 12, 6, 5, hex('#8a8a8a'));
    line(t, 5, 12, 6, 5, hex('#6a6a6a'));
    line(t, 11, 12, 11, 7, hex('#6b4520'));
    t.rect(10, 4, 3, 3, hex('#b8b8b8'));
    t.set(11, 4, hex('#e0e0e0'));
  }),
);

function smoothStone(t: Tile, rng: () => number, light = 1): void {
  noiseFill(t, rng, pal('#6f6f6f', '#787878', '#808080').map((c) => shade(c, light)), 4, 0.4);
  for (let i = 0; i < 16; i++) {
    t.set(i, 0, hex('#909090'));
    t.set(0, i, hex('#8a8a8a'));
    t.set(i, 15, hex('#555555'));
    t.set(15, i, hex('#5a5a5a'));
  }
}
registerTexture('furnace_side', (t, rng) => smoothStone(t, rng));
registerTexture('furnace_top', (t, rng) => smoothStone(t, rng, 1.08));
registerTexture('furnace_front', (t, rng) => {
  smoothStone(t, rng);
  t.rect(3, 8, 10, 6, hex('#1b1b1b'));
  for (let x = 4; x < 12; x += 2) t.set(x, 12, hex('#3a3a3a'));
  t.rect(3, 8, 10, 1, hex('#4a4a4a'));
  t.rect(4, 3, 8, 2, hex('#3a3a3a'));
  t.rect(4, 3, 8, 1, hex('#2a2a2a'));
});

const CHEST = pal('#8a5c26', '#9c6a2e', '#a8753a');
function chestBase(t: Tile, rng: () => number): void {
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) t.set(x, y, shade(pick(CHEST, rng()), y % 4 === 3 ? 0.9 : 1));
  const edge = hex('#4a2f12');
  for (let i = 0; i < 16; i++) {
    t.set(i, 0, edge);
    t.set(i, 15, edge);
    t.set(0, i, edge);
    t.set(15, i, edge);
  }
}
registerTexture('chest_top', chestBase);
registerTexture('chest_side', (t, rng) => {
  chestBase(t, rng);
  for (let x = 0; x < 16; x++) t.set(x, 5, hex('#4a2f12'));
});
registerTexture('chest_front', (t, rng) => {
  chestBase(t, rng);
  for (let x = 0; x < 16; x++) t.set(x, 5, hex('#4a2f12'));
  t.rect(7, 4, 2, 4, hex('#d6d6d6'));
  t.set(7, 7, hex('#8a8a8a'));
  t.set(8, 7, hex('#8a8a8a'));
  t.set(7, 4, hex('#f4f4f4'));
});

registerTexture(
  'torch',
  (t) => {
    for (let y = 9; y < 16; y++) {
      t.set(7, y, hex('#8a6438'));
      t.set(8, y, hex('#5e4426'));
    }
    t.set(7, 6, hex('#fff2a8'));
    t.set(8, 6, hex('#ffe066'));
    t.set(7, 7, hex('#ffd23a'));
    t.set(8, 7, hex('#ffb52e'));
    t.set(7, 8, hex('#ff9a1e'));
    t.set(8, 8, hex('#e67a12'));
  },
  { pad: 'clamp' },
);

const WOOL: Record<string, string> = {
  white: '#e9ecec', red: '#a12722', blue: '#35399d', yellow: '#f8c527', green: '#546d1b', black: '#1d1d21',
};
for (const [name, c] of Object.entries(WOOL)) {
  registerTexture(`${name}_wool`, (t, rng) => {
    const base = hex(c);
    const n = tileNoise(rng, 4);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const knit = (x + (y % 2)) % 2 === 0 ? 1.04 : 0.96;
        t.set(x, y, shade(base, knit * (0.92 + n(x, y) * 0.12)));
      }
  });
}

registerTexture('bookshelf', (t, rng) => {
  oakPlanks(t, rng, 0, 1);
  const books = pal('#8a2b2b', '#2b4f8a', '#2f7a3a', '#b08a2a', '#6a2b7a', '#8a5a2b', '#3a6a7a');
  for (const top of [2, 9]) {
    let x = 1;
    while (x < 15) {
      const w = rng() < 0.6 ? 1 : 2;
      const gap = rng() < 0.12;
      const c = books[Math.floor(rng() * books.length)];
      const h = 5 - (rng() < 0.3 ? 1 : 0);
      for (let i = 0; i < w && x < 15; i++, x++)
        for (let y = top; y < top + 5; y++) {
          if (gap || y < top + 5 - h) t.set(x, y, hex('#3a2a18'));
          else t.set(x, y, y === top + 5 - h ? shade(c, 1.3) : shade(c, i === 0 ? 1 : 0.85));
        }
    }
  }
});

registerTexture('cactus_side', (t, rng) => {
  noiseFill(t, rng, pal('#4f8226', '#5a8f2c', '#669c34'), 2, 0.3);
  for (let y = 0; y < 16; y++) {
    for (const x of [2, 7, 12]) t.set(x, y, hex('#3e6b1d'));
    t.set(0, y, hex('#365e19'));
    t.set(15, y, hex('#365e19'));
  }
  for (let i = 0; i < 8; i++) t.set([2, 7, 12][i % 3] + (i % 2 ? 1 : -1), Math.floor(rng() * 16), hex('#e6efc4'));
});
registerTexture('cactus_top', (t, rng) => {
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      t.set(x, y, d > 6.5 ? hex('#365e19') : shade(hex('#6aa336'), 0.9 + (Math.floor(d) % 2) * 0.12 + rng() * 0.05));
    }
  speckle(t, rng, pal('#e6efc4'), 4);
});

registerTexture('pumpkin_side', (t, rng) => {
  const p = pal('#d27b14', '#e38a1d', '#ee9a2e');
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      let c = pick(p, rng());
      if (x === 3 || x === 8 || x === 12) c = hex('#b05e0c');
      else if (x === 5 || x === 10) c = shade(c, 1.08);
      if (y === 0 || y === 15) c = shade(c, 0.85);
      t.set(x, y, c);
    }
});
registerTexture('pumpkin_top', (t, rng) => {
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      t.set(x, y, shade(hex('#e38a1d'), 0.85 + (Math.floor(d) % 3 === 0 ? 0 : 0.12) + rng() * 0.06));
    }
  t.rect(7, 6, 2, 4, hex('#6b4a1f'));
  t.set(8, 6, hex('#4f7a2a'));
});

registerTexture('hay_side', (t, rng) => {
  const p = pal('#b8932f', '#c9a43a', '#d6b246', '#e2c058');
  for (let x = 0; x < 16; x++) {
    const base = Math.floor(rng() * p.length);
    for (let y = 0; y < 16; y++) t.set(x, y, p[Math.max(0, Math.min(3, base + (rng() < 0.3 ? -1 : 0)))]);
  }
  for (let x = 0; x < 16; x++) {
    for (const y of [3, 4, 11, 12]) t.set(x, y, shade(hex('#8a3a1e'), y === 3 || y === 11 ? 1.15 : 1));
  }
});
registerTexture('hay_top', (t, rng) => {
  noiseFill(t, rng, pal('#b8932f', '#c9a43a', '#d6b246', '#e2c058'), 8, 0.7);
  for (let i = 0; i < 10; i++) {
    const x = Math.floor(rng() * 16);
    const y = Math.floor(rng() * 16);
    line(t, x, y, x + 3, y + (rng() < 0.5 ? 1 : -1), hex('#e8cc6a'));
  }
});

registerTexture('tnt_side', (t, rng) => {
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      let c = shade(hex('#c4321f'), 0.92 + rng() * 0.12);
      if (x % 4 === 3) c = hex('#8a2012');
      t.set(x, y, c);
    }
  for (let x = 0; x < 16; x++)
    for (let y = 6; y < 10; y++) t.set(x, y, (y === 7 || y === 8) && x % 3 === 1 ? hex('#2a2a2a') : hex('#e8e4dc'));
});
registerTexture('tnt_top', (t, rng) => {
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) t.set(x, y, x % 4 === 3 || y % 4 === 3 ? hex('#8a2012') : shade(hex('#c4321f'), 0.9 + rng() * 0.1));
  t.rect(7, 7, 2, 2, hex('#4a4a4a'));
  t.set(7, 7, hex('#d0d0d0'));
});
registerTexture('tnt_bottom', (t, rng) => {
  noiseFill(t, rng, pal('#8a2012', '#9c2818'), 4, 0.3);
});

registerTexture(
  'door_lower',
  (t, rng) => {
    doorFrame(t, rng);
    t.rect(4, 2, 8, 11, shade(WOOD.oak.planks[1], 0.85));
    t.rect(4, 2, 8, 1, shade(WOOD.oak.planks[0], 0.7));
    t.set(12, 1, hex('#3a3a3a'));
    t.set(12, 2, hex('#2a2a2a'));
  },
  { pad: 'clamp' },
);
registerTexture(
  'door_upper',
  (t, rng) => {
    doorFrame(t, rng);
    t.rect(3, 3, 4, 7, hex('#000000'), 0);
    t.rect(9, 3, 4, 7, hex('#000000'), 0);
    t.rect(4, 12, 8, 3, shade(WOOD.oak.planks[1], 0.85));
  },
  { pad: 'clamp' },
);
function doorFrame(t: Tile, rng: () => number): void {
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      let c = pick(WOOD.oak.planks, rng() * 0.5 + 0.4);
      if (x % 5 === 0) c = shade(WOOD.oak.planks[0], 0.85);
      if (x === 0 || x === 15) c = shade(WOOD.oak.planks[0], 0.7);
      t.set(x, y, c);
    }
}

registerTexture(
  'ladder',
  (t) => {
    const rail = hex('#7a5a32');
    const dark = hex('#4f3a1f');
    for (let y = 0; y < 16; y++) {
      t.set(2, y, rail);
      t.set(3, y, dark);
      t.set(12, y, rail);
      t.set(13, y, dark);
    }
    for (const y of [2, 7, 12]) {
      for (let x = 4; x < 12; x++) {
        t.set(x, y, hex('#8a6a3e'));
        t.set(x, y + 1, dark);
      }
    }
  },
  { pad: 'clamp' },
);

registerTexture('farmland', (t, rng) => {
  noiseFill(t, rng, pal('#3f2a1a', '#4a3220', '#55392a'), 4, 0.5);
  for (let y = 0; y < 16; y++) if (y % 4 === 0) for (let x = 0; x < 16; x++) t.set(x, y, hex('#33220f'));
  speckle(t, rng, pal('#6b4d36'), 6);
});

registerTexture('dirt_path_top', (t, rng) => {
  noiseFill(t, rng, pal('#8a703a', '#94793f', '#9e8448', '#a58c52'), 4, 0.4);
  speckle(t, rng, pal('#7a6232', '#b39a62'), 10);
});
registerTexture('dirt_path_side', (t, rng) => {
  dirt(t, rng);
  for (let x = 0; x < 16; x++) {
    t.set(x, 0, hex('#9e8448'));
    t.set(x, 1, hex('#94793f'));
    if (rng() < 0.4) t.set(x, 2, hex('#8a703a'));
  }
});

registerTexture('glow_lamp', (t, rng) => {
  const { cell, edge } = voronoi(rng, 7);
  const p = pal('#e8b04a', '#f2c25e', '#f9d47a', '#ffe7a8');
  const tones = Array.from({ length: 7 }, () => p[Math.floor(rng() * p.length)]);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const i = y * 16 + x;
      t.set(x, y, edge[i] < 0.8 ? hex('#a8702a') : edge[i] > 2.4 ? hex('#fff4d2') : tones[cell[i]]);
    }
});

// Plants (sprites, clamp padding) -------------------------------------------------------------

function cropPainter(height: number, ripe: boolean): Painter {
  return (t, rng) => {
    const stalk = ripe ? pal('#a88a2c', '#c4a33a', '#d9b64a') : pal('#3f7a26', '#4f8f2f', '#62a63a');
    for (const x0 of [1, 4, 6, 9, 11, 14]) {
      const h = height - Math.floor(rng() * 3);
      for (let k = 0; k < h; k++) {
        const x = x0 + (k > h / 2 && x0 % 2 ? 1 : 0);
        t.set(x, 15 - k, pick(stalk, rng()));
      }
      if (ripe) {
        const x = x0 + (x0 % 2 ? 1 : 0);
        for (let k = 0; k < 4; k++) t.set(x + (k % 2), 15 - h + k, hex(k % 2 ? '#b8902a' : '#e8c65a'));
      }
    }
  };
}
registerTexture('wheat_0', cropPainter(4, false), { pad: 'clamp' });
registerTexture('wheat_1', cropPainter(8, false), { pad: 'clamp' });
registerTexture('wheat_2', cropPainter(12, false), { pad: 'clamp' });
registerTexture('wheat_3', cropPainter(14, true), { pad: 'clamp' });

registerTexture(
  'tall_grass',
  (t, rng) => {
    for (let i = 0; i < 11; i++) {
      const x0 = 1 + Math.floor(rng() * 14);
      const h = 5 + Math.floor(rng() * 9);
      const lean = rng() < 0.5 ? -1 : 1;
      const c = pick(GRASS, rng());
      for (let k = 0; k < h; k++) t.put(x0 + (k > h * 0.6 ? lean : 0), 15 - k, k === h - 1 ? shade(c, 1.15) : c);
    }
  },
  { pad: 'clamp' },
);

function flower(petal: RGB, center: RGB): Painter {
  return (t) => {
    const stem = hex('#3f7a26');
    for (let y = 8; y < 16; y++) t.set(7, y, stem);
    t.set(6, 12, hex('#4f8f2f'));
    t.set(5, 11, hex('#4f8f2f'));
    t.set(8, 13, hex('#4f8f2f'));
    t.set(9, 12, hex('#4f8f2f'));
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [1, -1], [-1, 1]]) t.set(7 + dx, 6 + dy, shade(petal, dx && dy ? 0.85 : 1));
    t.set(7, 4, shade(petal, 1.1));
    t.set(5, 6, petal);
    t.set(9, 6, petal);
    t.set(7, 6, center);
  };
}
registerTexture('red_flower', flower(hex('#d12c2c'), hex('#5a1010')), { pad: 'clamp' });
registerTexture('yellow_flower', flower(hex('#f5d327'), hex('#c98a12')), { pad: 'clamp' });

function sapling(leaf: readonly RGB[], trunk: RGB): Painter {
  return (t, rng) => {
    for (let y = 10; y < 16; y++) t.set(7, y, trunk);
    t.set(8, 13, trunk);
    for (let y = 2; y < 11; y++)
      for (let x = 3; x < 13; x++) {
        const d = Math.hypot(x - 7.5, (y - 6.5) * 1.1);
        if (d < 4.2 && rng() < 0.85) t.set(x, y, pick(leaf, rng()));
      }
  };
}
registerTexture('oak_sapling', sapling(LEAVES.oak, WOOD.oak.bark[2]), { pad: 'clamp' });
registerTexture('birch_sapling', sapling(LEAVES.birch, WOOD.birch.bark[1]), { pad: 'clamp' });
registerTexture('spruce_sapling', sapling(LEAVES.spruce, WOOD.spruce.bark[2]), { pad: 'clamp' });

registerTexture(
  'dead_bush',
  (t) => {
    const c = hex('#7a5a2e');
    line(t, 7, 15, 7, 9, c);
    line(t, 7, 11, 3, 6, c);
    line(t, 7, 10, 12, 5, c);
    line(t, 5, 8, 5, 4, c);
    line(t, 10, 7, 13, 8, c);
    line(t, 7, 9, 8, 3, shade(c, 0.85));
  },
  { pad: 'clamp' },
);

// ---------------------------------------------------------------------------------------------
// Item icons (sprites)
// ---------------------------------------------------------------------------------------------

const ITEM = { pad: 'clamp' as const };

function handle(t: Tile, x0: number, y0: number, len: number): void {
  for (let i = 0; i < len; i++) {
    t.set(x0 + i, y0 - i, HANDLE[1]);
    t.put(x0 + i, y0 - i + 1, HANDLE[0]);
  }
}

const TOOL_COLORS: Record<string, [RGB, RGB]> = {
  wooden: [hex('#b48f58'), hex('#6b4f2f')],
  stone: [hex('#a0a0a0'), hex('#5a5a5a')],
  iron: [hex('#ececec'), hex('#8a8a8a')],
  golden: [hex('#fde74a'), hex('#c8961a')],
  diamond: [hex('#7af2f8'), hex('#1fa3ad')],
};

function toolPainter(kind: string, [hi, lo]: [RGB, RGB]): Painter {
  return (t) => {
    switch (kind) {
      case 'pickaxe': {
        handle(t, 2, 13, 10);
        for (let k = -5; k <= 5; k++) {
          const b = Math.round((25 - k * k) / 10);
          const x = 9 + k + b;
          const y = 4 + k - b;
          t.put(x, y, hi);
          t.put(x, y + 1, lo);
        }
        break;
      }
      case 'axe': {
        handle(t, 2, 13, 10);
        for (let y = 1; y < 9; y++)
          for (let x = 6; x < 13; x++) {
            if (x - y < 3 && Math.hypot(x - 8, y - 4) < 3.8) t.put(x, y, x - y < 0 ? lo : hi);
          }
        break;
      }
      case 'shovel': {
        handle(t, 2, 13, 8);
        for (let y = 0; y < 7; y++)
          for (let x = 9; x < 16; x++) {
            const d = Math.hypot(x - 12, y - 3);
            if (d < 2.9) t.put(x, y, d > 2 ? lo : hi);
          }
        break;
      }
      case 'hoe': {
        handle(t, 2, 13, 10);
        for (let x = 8; x < 14; x++) t.put(x, 2, hi);
        t.put(8, 3, lo);
        t.put(13, 3, lo);
        break;
      }
      case 'sword': {
        for (let i = 0; i < 10; i++) {
          t.put(4 + i, 11 - i, hi);
          t.put(5 + i, 11 - i, lo);
        }
        t.put(14, 1, hi);
        line(t, 2, 9, 6, 13, HANDLE[0]);
        t.put(3, 12, HANDLE[1]);
        t.put(2, 13, HANDLE[1]);
        t.put(1, 14, lo);
        break;
      }
    }
  };
}
for (const mat of Object.keys(TOOL_COLORS))
  for (const kind of ['pickaxe', 'axe', 'shovel', 'hoe', 'sword'])
    registerTexture(`${mat}_${kind}`, toolPainter(kind, TOOL_COLORS[mat]), ITEM);

registerTexture(
  'shears',
  (t) => {
    line(t, 3, 12, 11, 4, hex('#d0d0d0'));
    line(t, 4, 4, 12, 12, hex('#a8a8a8'));
    t.rect(2, 12, 2, 2, hex('#8a2b2b'));
    t.rect(12, 12, 2, 2, hex('#8a2b2b'));
  },
  ITEM,
);
registerTexture('stick', (t) => handle(t, 3, 12, 10), ITEM);

function blobIcon(p: readonly RGB[], r = 4.5): Painter {
  return (t, rng) => {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const d = Math.hypot(x - 7.5, y - 8);
        if (d < r + rng() * 0.8) t.set(x, y, d < r * 0.4 && x < 8 && y < 8 ? p[2] : pick(p.slice(0, 2), rng()));
      }
  };
}
registerTexture('coal', blobIcon(pal('#1a1a1a', '#2e2e2e', '#5a5a5a')), ITEM);
registerTexture('flint', blobIcon(pal('#2a2a30', '#3e3e46', '#7a7a86'), 3.5), ITEM);

function ingot(c: readonly RGB[]): Painter {
  return (t) => {
    for (let y = 6; y < 11; y++) {
      const inset = 10 - y;
      for (let x = 3 + Math.max(0, inset); x < 13 - Math.max(0, inset - 2); x++) t.set(x, y, y === 6 ? c[2] : y === 10 ? c[1] : c[0]);
    }
    t.set(5, 7, c[2]);
    t.set(6, 7, c[2]);
  };
}
registerTexture('iron_ingot', ingot(pal('#d8d8d8', '#8a8a8a', '#ffffff')), ITEM);
registerTexture('gold_ingot', ingot(pal('#f5d33a', '#b8860b', '#fff4a8')), ITEM);
registerTexture(
  'diamond',
  (t) => {
    for (let y = 3; y < 14; y++)
      for (let x = 2; x < 14; x++) {
        const d = Math.abs(x - 7.5) + Math.abs(y - 7.5) * 1.1;
        if (d < 6) t.set(x, y, d < 2.5 ? hex('#c4fbff') : x < 8 ? hex('#5fe0e8') : hex('#2cb9c4'));
      }
  },
  ITEM,
);
registerTexture(
  'redstone',
  (t, rng) => {
    for (let i = 0; i < 30; i++) {
      const a = rng() * Math.PI * 2;
      const r = rng() * 5;
      t.put(Math.round(7.5 + Math.cos(a) * r), Math.round(9 + Math.sin(a) * r * 0.6), rng() < 0.3 ? hex('#ff6a6a') : hex('#c01010'));
    }
  },
  ITEM,
);
registerTexture('wheat', cropPainter(14, true), ITEM);
registerTexture(
  'wheat_seeds',
  (t, rng) => {
    for (let i = 0; i < 7; i++) {
      const x = 4 + Math.floor(rng() * 8);
      const y = 5 + Math.floor(rng() * 7);
      t.set(x, y, hex('#5f9a35'));
      t.set(x + 1, y, hex('#3f7a26'));
    }
  },
  ITEM,
);
registerTexture(
  'apple',
  (t) => {
    for (let y = 4; y < 15; y++)
      for (let x = 2; x < 14; x++) {
        const d = Math.hypot(x - 7.5, y - 9);
        if (d < 5.2) t.set(x, y, d < 2 && x < 7 ? hex('#ff7a6a') : x > 9 ? hex('#a81818') : hex('#d82a22'));
      }
    t.set(8, 3, hex('#5a3e1e'));
    t.set(8, 2, hex('#5a3e1e'));
    t.set(9, 2, hex('#3f7a26'));
    t.set(10, 1, hex('#3f7a26'));
  },
  ITEM,
);
registerTexture(
  'bread',
  (t) => {
    for (let y = 5; y < 13; y++)
      for (let x = 1; x < 15; x++) {
        const d = Math.hypot((x - 7.5) / 6.5, (y - 9) / 3.6);
        if (d < 1) t.set(x, y, y < 8 ? hex('#c98a3a') : hex('#a86a26'));
      }
    for (const x of [4, 7, 10]) t.set(x, 7, hex('#e8b86a'));
  },
  ITEM,
);
registerTexture(
  'book',
  (t) => {
    t.rect(3, 3, 10, 11, hex('#7a3a1a'));
    t.rect(4, 4, 8, 9, hex('#8a4a2a'));
    t.rect(12, 4, 1, 10, hex('#f0ead6'));
    t.rect(6, 6, 4, 1, hex('#c9a43a'));
  },
  ITEM,
);
registerTexture('string', (t) => {
  for (let x = 2; x < 14; x++) t.set(x, Math.round(8 + Math.sin(x * 0.9) * 2), hex('#f0f0f0'));
}, ITEM);
registerTexture('feather', (t) => {
  line(t, 3, 13, 12, 3, hex('#cfcfcf'));
  for (let i = 0; i < 7; i++) {
    t.put(5 + i, 9 - i, hex('#ffffff'));
    t.put(6 + i, 11 - i, hex('#e8e8e8'));
  }
}, ITEM);
registerTexture(
  'door_item',
  (t, rng) => {
    for (let y = 1; y < 15; y++)
      for (let x = 4; x < 12; x++) t.set(x, y, x === 4 || x === 11 || y === 1 || y === 14 ? shade(WOOD.oak.planks[0], 0.7) : pick(WOOD.oak.planks, rng()));
    t.rect(5, 3, 2, 3, hex('#000000'), 0);
    t.rect(9, 3, 2, 3, hex('#000000'), 0);
    t.set(10, 9, hex('#2a2a2a'));
  },
  ITEM,
);

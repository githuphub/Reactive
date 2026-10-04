/**
 * Tiny pixel faces for Brain View group headers and the chat header: villagers use their real look colours,
 * the village mind, director, forge and builder get a glyph tile.
 */
import { village } from '../../village';

const cache = new Map<string, HTMLCanvasElement>();

const GLYPHS: Record<string, { bg: string; fg: string; glyph: string }> = {
  oakhollow: { bg: '#5a3b8c', fg: '#ffd98a', glyph: 'castle' },
  factions: { bg: '#5a3b8c', fg: '#ffd98a', glyph: 'castle' },
  director: { bg: '#8c2b3b', fg: '#ffe', glyph: 'target' },
  forge: { bg: '#3b2b6a', fg: '#ffe066', glyph: 'bolt' },
  builder: { bg: '#6a4a2a', fg: '#ffd98a', glyph: 'brick' },
  reactions: { bg: '#225a5a', fg: '#bff', glyph: 'spark' },
  player: { bg: '#2f8f86', fg: '#fff', glyph: 'face' },
};

/** A 16×16 canvas face/glyph for an actor id (npc id, faction id, "director", "forge" ...). Cached. */
export function faceIcon(actor: string): HTMLCanvasElement {
  const key = actor.toLowerCase();
  const hit = cache.get(key);
  if (hit) return copy(hit);
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const g = c.getContext('2d')!;
  const npc = village.npc(key === 'captain_rowan' ? 'rowan' : key);
  if (npc) {
    const look = npc.def.look as { skin: string; hair: string; robe: string; beard?: boolean; glasses?: boolean };
    g.fillStyle = look.skin;
    g.fillRect(0, 0, 8, 8);
    g.fillStyle = look.hair;
    g.fillRect(0, 0, 8, 2);
    g.fillRect(0, 2, 1, 2);
    g.fillRect(7, 2, 1, 2);
    g.fillStyle = npc.isGolem ? '#c0392b' : '#ffffff';
    g.fillRect(1, 3, 2, 1);
    g.fillRect(5, 3, 2, 1);
    g.fillStyle = '#2a2a3a';
    g.fillRect(2, 3, 1, 1);
    g.fillRect(5, 3, 1, 1);
    g.fillStyle = shade(look.skin, 0.8);
    g.fillRect(3, 4, 2, 2);
    if (look.beard) {
      g.fillStyle = look.hair;
      g.fillRect(1, 6, 6, 2);
    } else {
      g.fillStyle = '#7a3a2a';
      g.fillRect(3, 6, 2, 1);
    }
    if (look.glasses) {
      g.fillStyle = '#333';
      g.fillRect(1, 2, 6, 1);
    }
  } else {
    const s = GLYPHS[key] ?? { bg: '#3a4058', fg: '#dfe3ff', glyph: 'dot' };
    g.fillStyle = s.bg;
    g.fillRect(0, 0, 8, 8);
    g.fillStyle = s.fg;
    const px = (pts: number[][]) => pts.forEach(([x, y]) => g.fillRect(x, y, 1, 1));
    if (s.glyph === 'castle') px([[1, 1], [3, 1], [5, 1], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [1, 3], [6, 3], [1, 4], [6, 4], [1, 5], [3, 5], [4, 5], [6, 5], [1, 6], [3, 6], [4, 6], [6, 6], [2, 3], [5, 3], [2, 4], [5, 4]]);
    else if (s.glyph === 'target') px([[3, 1], [4, 1], [1, 3], [1, 4], [6, 3], [6, 4], [3, 6], [4, 6], [2, 2], [5, 2], [2, 5], [5, 5], [3, 3], [4, 4], [3, 4], [4, 3]]);
    else if (s.glyph === 'bolt') px([[4, 0], [3, 1], [3, 2], [2, 3], [3, 3], [4, 3], [5, 3], [4, 4], [4, 5], [3, 6], [3, 7]]);
    else if (s.glyph === 'brick') px([[0, 2], [1, 2], [2, 2], [4, 2], [5, 2], [6, 2], [7, 2], [1, 5], [2, 5], [3, 5], [4, 5], [6, 5], [7, 5]]);
    else if (s.glyph === 'spark') px([[3, 0], [3, 1], [3, 2], [0, 3], [1, 3], [2, 3], [4, 3], [5, 3], [6, 3], [3, 4], [3, 5], [3, 6], [1, 1], [5, 5]]);
    else if (s.glyph === 'face') px([[2, 2], [5, 2], [2, 5], [3, 5], [4, 5], [5, 5]]);
    else px([[3, 3], [4, 3], [3, 4], [4, 4]]);
  }
  cache.set(key, c);
  return copy(c);
}

function copy(c: HTMLCanvasElement): HTMLCanvasElement {
  const d = document.createElement('canvas');
  d.width = c.width;
  d.height = c.height;
  d.getContext('2d')!.drawImage(c, 0, 0);
  return d;
}

function shade(hex: string, f: number): string {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16);
  const r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
  return `rgb(${r},${g},${b})`;
}

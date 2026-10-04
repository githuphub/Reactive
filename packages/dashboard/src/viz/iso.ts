// Isometric voxel preview on a 2D canvas (Builds panel): each block is a small cube with three shaded faces,
// coloured by a hash of its block name (a few well-known blocks get recognisable colours). Painter's order.
import type { VoxelBlock } from "@liveforge/protocol";

const KNOWN: Record<string, string> = {
  glass: "#a8d8f0", water: "#3a78c8", lava: "#ff6a1a", grass: "#5fa83a", dirt: "#8a5a35", stone: "#8d8f94", cobblestone: "#7b7d80",
  oak_planks: "#b88a4e", spruce_planks: "#7a5432", birch_planks: "#d8c690", oak_log: "#6e5230", spruce_log: "#4a3520", birch_log: "#e0dcc8",
  bricks: "#a4513f", stone_bricks: "#8a8a8e", sandstone: "#dccb8c", sand: "#e3d49a", white_wool: "#eeeeee", red_wool: "#c23a2f", green_wool: "#4f9a3a", black_wool: "#222228",
  blue_wool: "#3550b8", yellow_wool: "#e8c53a", hay_bale: "#d8b23a", glow_lamp: "#ffe27a", mossy_cobblestone: "#6f7d62", door: "#8a5a2b", torch: "#ffcf4a", leaves: "#3f8a2e", oak_leaves: "#3f8a2e",
  gold_block: "#f2c94a", iron_block: "#d8d8d8", diamond_block: "#6ee0e0", obsidian: "#2a1f3a", bookshelf: "#9c6b3c", pumpkin: "#e08a1e",
};

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Base colour for a block id. */
export function blockColor(block: string): string {
  if (/^#[0-9a-f]{6}$/i.test(block)) return block; // forge.thing voxel models carry colours
  if (KNOWN[block]) return KNOWN[block];
  const h = hash(block);
  return `hsl(${h % 360}, ${40 + (h >> 9) % 25}%, ${48 + (h >> 17) % 14}%)`;
}

/**
 * Draw `blocks` (air skipped) into `canvas`, fitted and centred. `upto` limits how many blocks (build order) are
 * shown, so a slider can replay the build.
 */
export function drawIso(canvas: HTMLCanvasElement, blocks: VoxelBlock[], opts: { upto?: number; background?: string } = {}): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = canvas.clientWidth || 480;
  const ch = canvas.clientHeight || 320;
  canvas.width = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cw, ch);
  if (opts.background) {
    g.fillStyle = opts.background;
    g.fillRect(0, 0, cw, ch);
  }
  const shown = blocks.slice(0, opts.upto ?? blocks.length).filter((b) => b.block !== "air");
  if (!shown.length) return;
  // projected extents at unit size
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const b of blocks) {
    if (b.block === "air") continue;
    const sx = b.x - b.z;
    const sy = (b.x + b.z) / 2 - b.y;
    minX = Math.min(minX, sx - 1); maxX = Math.max(maxX, sx + 1);
    minY = Math.min(minY, sy - 1); maxY = Math.max(maxY, sy + 1.5);
  }
  const unit = Math.max(2, Math.min(28, Math.min((cw - 24) / (maxX - minX), (ch - 24) / (maxY - minY))));
  const ox = cw / 2 - ((minX + maxX) / 2) * unit;
  const oy = ch / 2 - ((minY + maxY) / 2) * unit;
  const w = unit; // half width of a cube's top diamond
  const hh = unit / 2; // half height of the diamond
  const order = [...shown].sort((a, b) => a.x + a.z - (b.x + b.z) || a.y - b.y || a.x - b.x);
  for (const b of order) {
    const cx = ox + (b.x - b.z) * unit;
    const cy = oy + ((b.x + b.z) / 2 - b.y) * unit;
    const col = blockColor(b.block);
    const glass = b.block === "glass" || b.block.endsWith("_glass");
    g.globalAlpha = glass ? 0.45 : 1;
    // top
    g.beginPath();
    g.moveTo(cx, cy - hh);
    g.lineTo(cx + w, cy);
    g.lineTo(cx, cy + hh);
    g.lineTo(cx - w, cy);
    g.closePath();
    g.fillStyle = col;
    g.fill();
    // left face
    g.beginPath();
    g.moveTo(cx - w, cy);
    g.lineTo(cx, cy + hh);
    g.lineTo(cx, cy + hh + unit);
    g.lineTo(cx - w, cy + unit);
    g.closePath();
    g.fillStyle = col;
    g.fill();
    g.fillStyle = "rgba(0,0,0,0.22)";
    g.fill();
    // right face
    g.beginPath();
    g.moveTo(cx + w, cy);
    g.lineTo(cx, cy + hh);
    g.lineTo(cx, cy + hh + unit);
    g.lineTo(cx + w, cy + unit);
    g.closePath();
    g.fillStyle = col;
    g.fill();
    g.fillStyle = "rgba(0,0,0,0.4)";
    g.fill();
    if (unit >= 6) {
      g.globalAlpha = glass ? 0.3 : 0.18;
      g.strokeStyle = "#000";
      g.lineWidth = 0.6;
      g.stroke();
    }
  }
  g.globalAlpha = 1;
}

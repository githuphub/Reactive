/**
 * Item icons for the UI: isometric cubes for block items (rendered once from atlas tiles) and
 * upscaled sprites for flat items. Returns cached 32×32 canvases; draw them with drawImage.
 */
import { blockById } from '../engine/blocks';
import { findItem } from '../engine/items';
import type { TextureAtlas } from '../engine/atlas';

const SIZE = 32;

/**
 * Extra icon painters tried before the atlas (WC forge: isometric voxel snapshots). Return a 32×32 canvas or null to
 * fall through. Call {@link IconRenderer.invalidate} when an item's look changes.
 */
export const iconProviders: ((item: string) => HTMLCanvasElement | null)[] = [];

export class IconRenderer {
  private readonly cache = new Map<string, HTMLCanvasElement>();
  /** Canvases last drawn by drawInto, so invalidate() can repaint them in place. */
  private readonly drawn = new Map<HTMLCanvasElement, string>();

  constructor(private readonly atlas: TextureAtlas) {}

  /** Icon for an item name (cached). Unknown items get an empty canvas. */
  icon(item: string): HTMLCanvasElement {
    let c = this.cache.get(item);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = c.height = SIZE;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const def = findItem(item);
    const custom = iconProviders.reduce<HTMLCanvasElement | null>((m, f) => m ?? f(item), null);
    if (custom) ctx.drawImage(custom, 0, 0, SIZE, SIZE);
    else if (def) {
      if (def.icon === null && def.block !== null) this.drawCube(ctx, def.block);
      else ctx.drawImage(this.atlas.tileCanvas(def.icon ?? item), 0, 0, SIZE, SIZE);
    }
    this.cache.set(item, c);
    return c;
  }

  /** Draws an icon into a target canvas (clears it first). */
  drawInto(target: HTMLCanvasElement, item: string | null): void {
    const ctx = target.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, target.width, target.height);
    if (item) ctx.drawImage(this.icon(item), 0, 0, target.width, target.height);
    if (item) this.drawn.set(target, item);
    else this.drawn.delete(target);
  }

  /** Forgets the cached icon of `item` and repaints every slot canvas currently showing it. */
  invalidate(item: string): void {
    this.cache.delete(item);
    for (const [c, it] of this.drawn) if (it === item) this.drawInto(c, item);
  }

  private drawCube(ctx: CanvasRenderingContext2D, blockId: number): void {
    const def = blockById(blockId);
    const S = SIZE;
    const top = this.shaded(def.faces[2], 1);
    const left = this.shaded(def.faces[5], 0.82);
    const right = this.shaded(def.faces[0], 0.62);
    const u = 1 / 16;
    // Top: origin at the top corner, u → right-down, v → left-down.
    ctx.setTransform((S / 2) * u, (S / 4) * u, -(S / 2) * u, (S / 4) * u, S / 2, 0);
    ctx.drawImage(top, 0, 0);
    // Left face.
    ctx.setTransform((S / 2) * u, (S / 4) * u, 0, (S / 2) * u, 0, S / 4);
    ctx.drawImage(left, 0, 0);
    // Right face.
    ctx.setTransform((S / 2) * u, -(S / 4) * u, 0, (S / 2) * u, S / 2, S / 2);
    ctx.drawImage(right, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private shaded(key: string, f: number): HTMLCanvasElement {
    const src = this.atlas.tileCanvas(key);
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(src, 0, 0);
    if (f < 1) {
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = `rgba(0,0,0,${1 - f})`;
      ctx.fillRect(0, 0, 16, 16);
    }
    return c;
  }
}

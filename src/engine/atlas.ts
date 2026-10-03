/**
 * Procedural texture atlas (main thread). Each 16×16 texture lives in a 32×32 slot with 8 px
 * of wrapped (or clamped) padding, which keeps mipmaps and nearest sampling free of bleeding.
 * Animated textures occupy consecutive slots in one row.
 */
import * as THREE from 'three';
import { allBlocks, onBlockRegistered } from './blocks';
import { allItems, onItemRegistered } from './items';
import { getTextureDef, paintTexture } from './textures';
import type { Tile } from './paint';

import { ATLAS_SIZE, SLOTS_PER_ROW, SLOT_PAD, SLOT_SIZE } from './constants';

export { ATLAS_SIZE, SLOTS_PER_ROW, SLOT_PAD, SLOT_SIZE };
const MAX_SLOTS = SLOTS_PER_ROW * SLOTS_PER_ROW;

interface SlotInfo {
  slot: number;
  frames: number;
}

/** The game's texture atlas. Use {@link TextureAtlas.slot} to look up (and lazily paint) textures. */
export class TextureAtlas {
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly slots = new Map<string, SlotInfo>();
  private readonly tiles = new Map<string, Tile>();
  private readonly tileCanvases = new Map<string, HTMLCanvasElement>();
  private next = 0;
  private dirty = false;
  /** Increments whenever a texture is added. */
  version = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = ATLAS_SIZE;
    this.canvas.height = ATLAS_SIZE;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    if (!ctx) throw new Error('2D canvas not available for the texture atlas');
    this.ctx = ctx;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestMipmapLinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.flipY = false;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;

    for (const b of allBlocks()) {
      for (const f of b.faces) this.slot(f);
      for (const s of b.stages) this.slot(s);
    }
    for (const i of allItems()) if (i.icon) this.slot(i.icon);
    this.slot('missing');
    onBlockRegistered((b) => {
      for (const f of b.faces) this.slot(f);
      for (const s of b.stages) this.slot(s);
      this.flush();
    });
    onItemRegistered((i) => {
      if (i.icon) this.slot(i.icon);
      this.flush();
    });
    this.flush();
  }

  /** Slot index of the first frame of `key`, painting it on first use. */
  slot(key: string): number {
    return this.info(key).slot;
  }

  /** Number of animation frames of `key`. */
  frames(key: string): number {
    return this.info(key).frames;
  }

  /** Uploads any newly painted textures to the GPU. Called automatically after registration. */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.texture.needsUpdate = true;
    this.version++;
  }

  /** A 16×16 canvas of one texture frame (cached), e.g. for UI icons. */
  tileCanvas(key: string, frame = 0): HTMLCanvasElement {
    const ck = `${key}#${frame}`;
    let c = this.tileCanvases.get(ck);
    if (!c) {
      const tile = frame === 0 ? (this.tiles.get(key) ?? paintTexture(key)) : paintTexture(key, frame);
      c = document.createElement('canvas');
      c.width = c.height = 16;
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(16, 16);
      img.data.set(tile.data);
      ctx.putImageData(img, 0, 0);
      this.tileCanvases.set(ck, c);
    }
    return c;
  }

  private info(key: string): SlotInfo {
    let info = this.slots.get(key);
    if (info) return info;
    const def = getTextureDef(key);
    const frames = Math.max(1, Math.min(def.frames, SLOTS_PER_ROW));
    let slot = this.next;
    if ((slot % SLOTS_PER_ROW) + frames > SLOTS_PER_ROW) slot = Math.ceil(slot / SLOTS_PER_ROW) * SLOTS_PER_ROW;
    if (slot + frames > MAX_SLOTS) {
      console.warn(`[atlas] out of slots; "${key}" uses the missing texture`);
      return this.slots.get('missing') ?? { slot: 0, frames: 1 };
    }
    this.next = slot + frames;
    info = { slot, frames };
    this.slots.set(key, info);
    for (let f = 0; f < frames; f++) {
      const tile = paintTexture(key, f);
      if (f === 0) this.tiles.set(key, tile);
      this.blit(tile, slot + f, def.pad);
    }
    this.dirty = true;
    return info;
  }

  private blit(tile: Tile, slot: number, pad: 'wrap' | 'clamp'): void {
    const src = tile.data;
    // Give fully transparent pixels the tile's mean colour so mipmaps don't get dark halos.
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < 256; i++)
      if (src[i * 4 + 3] > 0) {
        r += src[i * 4];
        g += src[i * 4 + 1];
        b += src[i * 4 + 2];
        n++;
      }
    if (n > 0 && n < 256) {
      r /= n;
      g /= n;
      b /= n;
      for (let i = 0; i < 256; i++)
        if (src[i * 4 + 3] === 0) {
          src[i * 4] = r;
          src[i * 4 + 1] = g;
          src[i * 4 + 2] = b;
        }
    }
    const img = this.ctx.createImageData(SLOT_SIZE, SLOT_SIZE);
    const d = img.data;
    for (let y = 0; y < SLOT_SIZE; y++)
      for (let x = 0; x < SLOT_SIZE; x++) {
        let sx = x - SLOT_PAD;
        let sy = y - SLOT_PAD;
        if (pad === 'wrap') {
          sx = ((sx % 16) + 16) % 16;
          sy = ((sy % 16) + 16) % 16;
        } else {
          sx = Math.max(0, Math.min(15, sx));
          sy = Math.max(0, Math.min(15, sy));
        }
        const si = (sy * 16 + sx) * 4;
        const di = (y * SLOT_SIZE + x) * 4;
        d[di] = src[si];
        d[di + 1] = src[si + 1];
        d[di + 2] = src[si + 2];
        d[di + 3] = src[si + 3];
      }
    const sx = (slot % SLOTS_PER_ROW) * SLOT_SIZE;
    const sy = Math.floor(slot / SLOTS_PER_ROW) * SLOT_SIZE;
    this.ctx.putImageData(img, sx, sy);
  }
}

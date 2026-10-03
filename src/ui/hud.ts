/**
 * Built-in HUD widgets: crosshair, hotbar (with icons, counts and tool wear), selected item
 * name, and the F3 debug overlay.
 */
import { findItem } from '../engine/items';
import type { Game } from '../game/game';
import { HOTBAR_SIZE } from '../player/inventory';
import { el } from './ui';
import type { IconRenderer } from './icons';

export class Hotbar {
  readonly el: HTMLElement;
  private readonly slots: { root: HTMLElement; canvas: HTMLCanvasElement; count: HTMLElement; wear: HTMLElement; wearBar: HTMLElement; item: string | null }[] = [];
  private readonly name: HTMLElement;
  private nameTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly game: Game, private readonly icons: IconRenderer) {
    this.el = el('div');
    this.el.style.display = 'flex';
    this.el.style.flexDirection = 'column';
    this.el.style.alignItems = 'center';
    this.el.style.gap = '4px';
    this.name = el('div', 'lc-item-name');
    const bar = el('div', 'lc-hotbar');
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const root = el('div', 'lc-slot');
      const canvas = el('canvas');
      canvas.width = canvas.height = 32;
      const count = el('div', 'lc-slot-count');
      const wear = el('div', 'lc-slot-wear');
      const wearBar = el('div');
      wear.appendChild(wearBar);
      wear.style.display = 'none';
      root.append(canvas, count, wear);
      bar.appendChild(root);
      this.slots.push({ root, canvas, count, wear, wearBar, item: null });
    }
    this.el.append(this.name, bar);
    game.events.on('hotbarChanged', () => this.refresh(true));
    game.events.on('inventoryChanged', () => this.refresh(false));
    this.refresh(false);
  }

  refresh(showName: boolean): void {
    const inv = this.game.inventory;
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const s = this.slots[i];
      const stack = inv.get(i);
      const item = stack?.item ?? null;
      if (item !== s.item) {
        s.item = item;
        this.icons.drawInto(s.canvas, item);
      }
      s.count.textContent = stack && stack.count > 1 && !inv.infinite ? String(stack.count) : '';
      const tool = stack ? findItem(stack.item)?.tool : null;
      if (tool && stack?.damage) {
        s.wear.style.display = '';
        const f = 1 - stack.damage / tool.durability;
        s.wearBar.style.width = `${Math.max(0, f) * 100}%`;
        s.wearBar.style.background = f > 0.5 ? '#7fd36b' : f > 0.2 ? '#e8c44a' : '#e0503a';
      } else s.wear.style.display = 'none';
      s.root.classList.toggle('lc-selected', i === inv.selected);
    }
    if (showName) {
      const st = inv.selectedStack;
      this.name.textContent = st ? findItem(st.item)?.displayName ?? st.item : '';
      this.name.style.opacity = '1';
      if (this.nameTimer) clearTimeout(this.nameTimer);
      this.nameTimer = setTimeout(() => (this.name.style.opacity = '0'), 1800);
    }
  }
}

export class DebugOverlay {
  readonly el: HTMLElement;
  visible = false;
  private timer = 0;
  private frames = 0;
  private fps = 0;
  private frameMs = 0;

  constructor(private readonly game: Game) {
    this.el = el('div', 'lc-debug');
    this.el.style.display = 'none';
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? '' : 'none';
  }

  update(dt: number): void {
    this.frames++;
    this.timer += dt;
    this.frameMs = this.frameMs * 0.9 + dt * 1000 * 0.1;
    if (this.timer < 0.25) return;
    this.fps = Math.round(this.frames / this.timer);
    this.frames = 0;
    this.timer = 0;
    if (!this.visible) return;
    const g = this.game;
    const p = g.player.position;
    const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
    const st = g.chunks.stats();
    const info = g.renderer.info;
    const facing = ['north (-Z)', 'east (+X)', 'south (+Z)', 'west (-X)'][g.player.facing];
    const t = g.interaction.target;
    const site = g.villageSite;
    const hh = Math.floor(g.time.hours);
    const mm = Math.floor((g.time.hours % 1) * 60);
    this.el.textContent = [
      `Livecraft  ${this.fps} fps  (${this.frameMs.toFixed(1)} ms)`,
      `XYZ: ${p.x.toFixed(2)} / ${p.y.toFixed(2)} / ${p.z.toFixed(2)}`,
      `Block: ${bx} ${by} ${bz}   Chunk: ${bx >> 4} ${bz >> 4}  [${bx & 15} ${bz & 15}]`,
      `Facing: ${facing}  yaw ${((g.player.yaw * 180) / Math.PI).toFixed(1)}  pitch ${((g.player.pitch * 180) / Math.PI).toFixed(1)}`,
      `Biome: ${g.world.biomeAt(bx, bz)}`,
      `Light: sky ${g.world.getSkyLight(bx, by + 1, bz)}  block ${g.world.getBlockLight(bx, by + 1, bz)}`,
      `Time: day ${g.time.day} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} (${g.time.phase})  weather ${g.weather.current}`,
      `Mode: ${g.player.mode}${g.player.flying ? ' (flying)' : ''}  ${g.player.inWater ? 'swimming' : g.player.onGround ? 'ground' : 'air'}`,
      `Chunks: ${st.loaded} loaded, ${st.meshes} meshes, gen ${st.pendingGen}, mesh ${st.pendingMesh}, dirty ${st.dirty}`,
      `Render: ${info.render.calls} calls, ${(info.render.triangles / 1000).toFixed(0)}k tris, rd ${g.chunks.distance}`,
      `Entities: ${g.entities.count}`,
      t ? `Target: ${g.world.getBlockName(t.x, t.y, t.z)} @ ${t.x} ${t.y} ${t.z} (meta ${t.meta})` : 'Target: -',
      `Seed: ${g.seedText}${site ? `   Village: ${site.x} ${site.y} ${site.z}` : ''}`,
    ].join('\n');
  }
}

/** Creates the crosshair element. */
export function createCrosshair(): HTMLElement {
  return el('div', 'lc-crosshair');
}

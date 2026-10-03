/**
 * Base class for slot-based screens (inventory, crafting table, furnace, chest, creative).
 *
 * Mouse:
 * - Left click: pick up / place / merge / swap. Right click: pick up half / place one.
 * - Drag with a held stack: left = split evenly over the slots, right = one per slot.
 * - Shift+click: quick-move to the other section (or craft as many as fit from an output).
 * - Click outside the panel: drop the held stack (right click: one item).
 * Keys while hovering a slot: 1–9 swap with that hotbar slot, Q drops one (Ctrl+Q the stack).
 */
import { findItem, type ItemStack } from '../../engine/items';
import type { Game } from '../../game/game';
import { HOTBAR_SIZE, INVENTORY_SIZE } from '../../player/inventory';
import { el, type Screen } from '../../ui/ui';
import { throwFromPlayer } from '../inventory-api';

/** One slot's backing store. */
export interface SlotSource {
  get(): ItemStack | null;
  set(stack: ItemStack | null): void;
  /** May this stack be placed here? Default true. */
  canPlace?(stack: ItemStack): boolean;
  /** Take-only result slot (crafting / furnace output). */
  output?: boolean;
  /** For outputs: removes and returns the result (consuming ingredients). */
  take?(): ItemStack | null;
  /** Creative palette: taking gives a copy, placing deletes the held stack. */
  infinite?: boolean;
  /** Max stack size in this slot (default: the item's). */
  maxStack?: number;
}

export interface SlotView {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  count: HTMLElement;
  wear: HTMLElement;
  wearBar: HTMLElement;
  source: SlotSource;
  group: string;
  drawn: string;
}

/** Player inventory slot `i` (0–8 hotbar, 9–35 main). */
export function playerSlot(game: Game, i: number): SlotSource {
  return {
    get: () => game.inventory.get(i),
    set: (s) => game.inventory.set(i, s ? { ...s } : null),
  };
}

export function maxOf(stack: ItemStack, source?: SlotSource): number {
  const def = findItem(stack.item);
  return Math.min(source?.maxStack ?? 64, def?.maxStack ?? 64);
}

export function stackable(a: ItemStack, b: ItemStack): boolean {
  return a.item === b.item && !a.data && !b.data && !a.damage && !b.damage && maxOf(a) > 1;
}

export abstract class ContainerScreen implements Screen {
  readonly el: HTMLElement;
  readonly pausesGame = false;
  readonly dim = true;
  /** The stack held on the mouse cursor. */
  cursor: ItemStack | null = null;
  protected readonly panel: HTMLElement;
  protected readonly views: SlotView[] = [];
  private readonly groups = new Map<string, SlotView[]>();
  private readonly cursorEl: HTMLElement;
  private readonly cursorCanvas: HTMLCanvasElement;
  private readonly cursorCount: HTMLElement;
  private readonly tooltip: HTMLElement;
  private hovered: SlotView | null = null;
  private drag: { button: number; views: SlotView[] } | null = null;
  private unsub: (() => void)[] = [];
  private mouseX = 0;
  private mouseY = 0;

  constructor(protected readonly game: Game, readonly id: string, title: string) {
    this.el = el('div', 'lcs-screen');
    this.panel = el('div', 'lcs-panel');
    if (title) this.panel.appendChild(el('div', 'lcs-title', title));
    this.el.appendChild(this.panel);
    this.cursorEl = el('div', 'lcs-cursor');
    this.cursorCanvas = el('canvas');
    this.cursorCanvas.width = this.cursorCanvas.height = 32;
    this.cursorCount = el('div', 'lc-slot-count');
    this.cursorEl.append(this.cursorCanvas, this.cursorCount);
    this.tooltip = el('div', 'lcs-tooltip');
    this.el.append(this.cursorEl, this.tooltip);

    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.el.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      this.placeFloating();
    });
    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el && this.cursor) {
        // Clicked outside the panel: throw.
        const n = e.button === 2 ? 1 : this.cursor.count;
        throwFromPlayer(this.game, { ...this.cursor, count: n });
        this.cursor.count -= n;
        if (this.cursor.count <= 0) this.cursor = null;
        this.refresh();
      }
    });
    window.addEventListener('mouseup', (e) => this.endDrag(e));
  }

  // -- building ----------------------------------------------------------------------------------

  /** Creates slot views for sources inside `parent` (a CSS grid with `cols` columns). */
  protected addSlots(parent: HTMLElement, group: string, sources: SlotSource[], cols: number): SlotView[] {
    parent.classList.add('lcs-grid');
    parent.style.gridTemplateColumns = `repeat(${cols}, 44px)`;
    const list = this.groups.get(group) ?? [];
    const created: SlotView[] = [];
    for (const source of sources) {
      const root = el('div', 'lc-slot lcs-slot');
      if (source.output) root.classList.add('lcs-output');
      const canvas = el('canvas');
      canvas.width = canvas.height = 32;
      const count = el('div', 'lc-slot-count');
      const wear = el('div', 'lc-slot-wear');
      const wearBar = el('div');
      wear.appendChild(wearBar);
      root.append(canvas, count, wear);
      const view: SlotView = { root, canvas, count, wear, wearBar, source, group, drawn: '\u0000' };
      root.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.mouseDown(view, e);
      });
      root.addEventListener('mouseenter', () => {
        this.hovered = view;
        if (this.drag && !this.drag.views.includes(view) && this.canDragInto(view)) {
          this.drag.views.push(view);
          view.root.classList.add('lcs-drag');
        }
        this.showTooltip();
      });
      root.addEventListener('mouseleave', () => {
        if (this.hovered === view) this.hovered = null;
        this.showTooltip();
      });
      parent.appendChild(root);
      this.views.push(view);
      list.push(view);
      created.push(view);
    }
    this.groups.set(group, list);
    return created;
  }

  /** Standard player inventory block: main (27) above hotbar (9). */
  protected playerInventory(): HTMLElement {
    const wrap = el('div', 'lcs-player');
    const main = el('div');
    const hot = el('div', 'lcs-hotbar-row');
    const mainSources: SlotSource[] = [];
    for (let i = HOTBAR_SIZE; i < INVENTORY_SIZE; i++) mainSources.push(playerSlot(this.game, i));
    const hotSources: SlotSource[] = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) hotSources.push(playerSlot(this.game, i));
    this.addSlots(main, 'main', mainSources, 9);
    this.addSlots(hot, 'hotbar', hotSources, 9);
    wrap.append(main, hot);
    return wrap;
  }

  /** Slot lists a shift-click from `group` moves into, in priority order. Override per screen. */
  protected quickTargets(group: string, _stack: ItemStack): string[] {
    if (group === 'hotbar') return ['main'];
    if (group === 'main') return ['hotbar'];
    return ['hotbar', 'main'];
  }

  protected sources(group: string): SlotSource[] {
    return (this.groups.get(group) ?? []).map((v) => v.source);
  }

  // -- screen lifecycle --------------------------------------------------------------------------

  onOpen(): void {
    this.unsub.push(this.game.events.on('inventoryChanged', () => this.refresh()));
    this.refresh();
  }

  onClose(): void {
    for (const u of this.unsub) u();
    this.unsub = [];
    this.drag = null;
    if (this.cursor) {
      const left = this.game.inventory.add(this.cursor);
      if (left > 0) throwFromPlayer(this.game, { ...this.cursor, count: left });
      this.cursor = null;
    }
    this.hovered = null;
    this.tooltip.style.display = 'none';
  }

  onKey(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    if (t && t.tagName === 'INPUT') return false;
    if (e.code === 'KeyE') {
      this.game.ui.screens.close(this);
      return true;
    }
    const h = this.hovered;
    if (h && /^Digit[1-9]$/.test(e.code)) {
      const i = Number(e.code.slice(5)) - 1;
      this.swapWithHotbar(h, i);
      return true;
    }
    if (h && e.code === 'KeyQ' && !h.source.output && !h.source.infinite) {
      const st = h.source.get();
      if (st) {
        const n = e.ctrlKey ? st.count : 1;
        throwFromPlayer(this.game, { ...st, count: n });
        h.source.set(st.count - n > 0 ? { ...st, count: st.count - n } : null);
        this.changed();
      }
      return true;
    }
    return false;
  }

  // -- interaction -------------------------------------------------------------------------------

  private canDragInto(v: SlotView): boolean {
    const c = this.cursor;
    if (!c || v.source.output || v.source.infinite) return false;
    if (v.source.canPlace && !v.source.canPlace(c)) return false;
    const st = v.source.get();
    return !st || (stackable(st, c) && st.count < maxOf(st, v.source));
  }

  private mouseDown(view: SlotView, e: MouseEvent): void {
    if (e.button !== 0 && e.button !== 2) return;
    if (this.cursor && !e.shiftKey && !view.source.output && !view.source.infinite) {
      this.drag = { button: e.button, views: [view] };
      view.root.classList.add('lcs-drag');
      return;
    }
    this.click(view, e.button, e.shiftKey);
  }

  private endDrag(e: MouseEvent): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    for (const v of d.views) v.root.classList.remove('lcs-drag');
    if (e.button !== d.button) return;
    if (d.views.length <= 1) {
      this.click(d.views[0], d.button, false);
      return;
    }
    const c = this.cursor;
    if (!c) return;
    const targets = d.views.filter((v) => this.canDragInto(v));
    if (!targets.length) return;
    const per = d.button === 2 ? 1 : Math.max(1, Math.floor(c.count / targets.length));
    for (const v of targets) {
      if (!this.cursor || this.cursor.count <= 0) break;
      const st = v.source.get();
      const room = st ? maxOf(st, v.source) - st.count : maxOf(c, v.source);
      const n = Math.min(per, room, this.cursor.count);
      if (n <= 0) continue;
      v.source.set(st ? { ...st, count: st.count + n } : { ...c, count: n });
      this.cursor.count -= n;
    }
    if (this.cursor && this.cursor.count <= 0) this.cursor = null;
    this.changed();
  }

  /** Applies a click to a slot (button 0 left, 2 right). */
  protected click(view: SlotView, button: number, shift: boolean): void {
    const s = view.source;
    const st = s.get();
    if (s.infinite) {
      if (this.cursor) this.cursor = null;
      else if (st) {
        if (shift) this.game.inventory.add({ ...st, count: maxOf(st) });
        else this.cursor = { ...st, count: button === 2 ? 1 : maxOf(st) };
      }
      this.changed();
      return;
    }
    if (s.output) {
      if (!st) return;
      if (shift) {
        for (let i = 0; i < 64; i++) {
          const out = s.get();
          if (!out || !this.fits(out, this.quickTargets(view.group, out))) break;
          const taken = s.take ? s.take() : (s.set(null), out);
          if (!taken) break;
          this.moveInto({ ...taken }, this.quickTargets(view.group, taken));
        }
      } else if (!this.cursor || (stackable(this.cursor, st) && this.cursor.count + st.count <= maxOf(st))) {
        const taken = s.take ? s.take() : (s.set(null), st);
        if (taken) this.cursor = this.cursor ? { ...this.cursor, count: this.cursor.count + taken.count } : { ...taken };
      }
      this.changed();
      return;
    }
    if (shift) {
      if (!st) return;
      const left = this.moveInto({ ...st }, this.quickTargets(view.group, st));
      s.set(left > 0 ? { ...st, count: left } : null);
      this.changed();
      return;
    }
    const c = this.cursor;
    const can = (x: ItemStack) => !s.canPlace || s.canPlace(x);
    if (button === 0) {
      if (!c) {
        if (st) {
          this.cursor = { ...st };
          s.set(null);
        }
      } else if (!st) {
        if (can(c)) {
          const n = Math.min(c.count, maxOf(c, s));
          s.set({ ...c, count: n });
          c.count -= n;
          if (c.count <= 0) this.cursor = null;
        }
      } else if (stackable(st, c)) {
        const n = Math.min(c.count, maxOf(st, s) - st.count);
        if (n > 0) {
          s.set({ ...st, count: st.count + n });
          c.count -= n;
          if (c.count <= 0) this.cursor = null;
        }
      } else if (can(c) && c.count <= maxOf(c, s)) {
        s.set({ ...c });
        this.cursor = { ...st };
      }
    } else {
      if (!c) {
        if (st) {
          const take = Math.ceil(st.count / 2);
          this.cursor = { ...st, count: take };
          s.set(st.count - take > 0 ? { ...st, count: st.count - take } : null);
        }
      } else if (!st) {
        if (can(c)) {
          s.set({ ...c, count: 1 });
          c.count--;
          if (c.count <= 0) this.cursor = null;
        }
      } else if (stackable(st, c)) {
        if (st.count < maxOf(st, s)) {
          s.set({ ...st, count: st.count + 1 });
          c.count--;
          if (c.count <= 0) this.cursor = null;
        }
      } else if (can(c) && c.count <= maxOf(c, s)) {
        s.set({ ...c });
        this.cursor = { ...st };
      }
    }
    this.changed();
  }

  private swapWithHotbar(view: SlotView, i: number): void {
    const s = view.source;
    if (s.output || s.infinite) {
      const st = s.get();
      if (!st || this.game.inventory.get(i)) return;
      const taken = s.infinite ? { ...st, count: maxOf(st) } : s.take ? s.take() : (s.set(null), st);
      if (taken) this.game.inventory.set(i, { ...taken });
      this.changed();
      return;
    }
    const hot = playerSlot(this.game, i);
    if (hot === s) return;
    const a = s.get(), b = hot.get();
    if (b && s.canPlace && !s.canPlace(b)) return;
    s.set(b ? { ...b } : null);
    hot.set(a ? { ...a } : null);
    this.changed();
  }

  /** True if `stack` fits entirely into the target groups. */
  private fits(stack: ItemStack, groups: string[]): boolean {
    let room = 0;
    for (const g of groups)
      for (const s of this.sources(g)) {
        if (s.output || s.infinite || (s.canPlace && !s.canPlace(stack))) continue;
        const st = s.get();
        if (!st) room += maxOf(stack, s);
        else if (stackable(st, stack)) room += maxOf(st, s) - st.count;
        if (room >= stack.count) return true;
      }
    return room >= stack.count;
  }

  /** Moves a stack into target groups (merging first). Returns the count that didn't fit. */
  protected moveInto(stack: ItemStack, groups: string[]): number {
    let left = stack.count;
    for (const pass of [0, 1])
      for (const g of groups)
        for (const s of this.sources(g)) {
          if (left <= 0) return 0;
          if (s.output || s.infinite || (s.canPlace && !s.canPlace(stack))) continue;
          const st = s.get();
          if (pass === 0 && st && stackable(st, stack)) {
            const n = Math.min(left, maxOf(st, s) - st.count);
            if (n > 0) {
              s.set({ ...st, count: st.count + n });
              left -= n;
            }
          } else if (pass === 1 && !st) {
            const n = Math.min(left, maxOf(stack, s));
            s.set({ ...stack, count: n });
            left -= n;
          }
        }
    return left;
  }

  // -- drawing -----------------------------------------------------------------------------------

  /** Called after any slot change: subclasses recompute outputs, then everything redraws. */
  protected changed(): void {
    this.refresh();
  }

  /** Redraws all slots, the cursor and the tooltip. */
  refresh(): void {
    for (const v of this.views) this.drawSlot(v);
    const c = this.cursor;
    this.cursorEl.style.display = c ? 'block' : 'none';
    if (c) {
      this.game.icons.drawInto(this.cursorCanvas, c.item);
      this.cursorCount.textContent = c.count > 1 ? String(c.count) : '';
    }
    this.placeFloating();
    this.showTooltip();
  }

  private drawSlot(v: SlotView): void {
    const st = v.source.get();
    const key = st ? `${st.item}|${st.count}|${st.damage ?? 0}` : '';
    if (key === v.drawn) return;
    v.drawn = key;
    this.game.icons.drawInto(v.canvas, st?.item ?? null);
    v.count.textContent = st && st.count > 1 ? String(st.count) : '';
    const tool = st ? findItem(st.item)?.tool : null;
    if (tool && st?.damage) {
      v.wear.style.display = '';
      const f = 1 - st.damage / tool.durability;
      v.wearBar.style.width = `${Math.max(0, f) * 100}%`;
      v.wearBar.style.background = f > 0.5 ? '#7fd36b' : f > 0.2 ? '#e8c44a' : '#e0503a';
    } else v.wear.style.display = 'none';
  }

  private placeFloating(): void {
    this.cursorEl.style.left = `${this.mouseX - 16}px`;
    this.cursorEl.style.top = `${this.mouseY - 16}px`;
    this.tooltip.style.left = `${this.mouseX + 14}px`;
    this.tooltip.style.top = `${this.mouseY - 28}px`;
  }

  private showTooltip(): void {
    const st = this.hovered?.source.get();
    if (!st || this.cursor) {
      this.tooltip.style.display = 'none';
      return;
    }
    const def = findItem(st.item);
    const lines = [def?.displayName ?? st.item];
    if (def?.tool && def.tool.durability) lines.push(`Durability ${def.tool.durability - (st.damage ?? 0)} / ${def.tool.durability}`);
    if (def?.tool && def.tool.kind !== 'none') lines.push(`${def.tool.damage} attack damage`);
    if (def?.food) lines.push(`Restores ${def.food.hunger / 2} hunger`);
    this.tooltip.textContent = lines.join('\n');
    this.tooltip.style.display = 'block';
  }
}

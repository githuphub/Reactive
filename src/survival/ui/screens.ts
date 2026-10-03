/**
 * The survival screens: player inventory (2×2 crafting, creative palette tab), crafting table
 * (3×3), furnace and chest.
 */
import { allItems, type ItemStack } from '../../engine/items';
import type { Game } from '../../game/game';
import { el } from '../../ui/ui';
import { CHEST_SIZE, getContainers, type ChestState, type FurnaceState } from '../containers';
import { fuelTime, matchRecipe, onRecipeRegistered, smeltingFor, type Recipe } from '../recipes';
import { throwFromPlayer } from '../inventory-api';
import { ContainerScreen, type SlotSource } from './container-screen';

// -- crafting grid -------------------------------------------------------------------------------

export class CraftingGrid {
  readonly cells: (ItemStack | null)[];
  recipe: Recipe | null = null;

  constructor(private readonly game: Game, readonly size: number, private readonly station: 'inventory' | 'crafting_table') {
    this.cells = new Array(size * size).fill(null);
  }

  recompute(): void {
    this.recipe = matchRecipe(this.cells, this.size);
  }

  sources(onChange: () => void): SlotSource[] {
    return this.cells.map((_, i) => ({
      get: () => this.cells[i],
      set: (s: ItemStack | null) => {
        this.cells[i] = s && s.count > 0 ? { ...s } : null;
        this.recompute();
        onChange();
      },
    }));
  }

  output(onChange: () => void): SlotSource {
    return {
      output: true,
      get: () => (this.recipe ? { item: this.recipe.result.item, count: this.recipe.result.count, ...(this.recipe.result.data ? { data: { ...this.recipe.result.data } } : {}) } : null),
      set: () => {},
      take: () => {
        const r = this.recipe;
        if (!r) return null;
        for (let i = 0; i < this.cells.length; i++) {
          const c = this.cells[i];
          if (!c) continue;
          c.count--;
          if (c.count <= 0) this.cells[i] = null;
        }
        const out: ItemStack = { item: r.result.item, count: r.result.count };
        if (r.result.data) out.data = { ...r.result.data };
        this.game.events.emit('itemCrafted', { item: out.item, count: out.count, recipe: r.id, station: this.station });
        this.recompute();
        onChange();
        return out;
      },
    };
  }

  /** Returns everything on the grid to the inventory (overflow is dropped). */
  returnAll(drop: (s: ItemStack) => void): void {
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i];
      if (!c) continue;
      const left = this.game.inventory.add(c);
      if (left > 0) drop({ ...c, count: left });
      this.cells[i] = null;
    }
    this.recipe = null;
  }
}

function craftingSection(parent: HTMLElement): { gridEl: HTMLElement; outEl: HTMLElement } {
  const row = el('div', 'lcs-craft');
  const gridEl = el('div');
  const arrow = el('div', 'lcs-arrow', '➜');
  const outEl = el('div');
  row.append(gridEl, arrow, outEl);
  parent.appendChild(row);
  return { gridEl, outEl };
}

// -- inventory (+ creative palette) --------------------------------------------------------------

export class InventoryScreen extends ContainerScreen {
  readonly grid: CraftingGrid;
  private readonly survivalPart: HTMLElement;
  private readonly creativePart: HTMLElement;
  private readonly tabs: HTMLElement;
  private readonly search: HTMLInputElement;
  private palette: string[] = [];
  private offset = 0;
  private tab: 'inventory' | 'creative' = 'inventory';
  private readonly paletteRows = 5;

  constructor(game: Game) {
    super(game, 'inventory', '');
    this.grid = new CraftingGrid(game, 2, 'inventory');
    this.tabs = el('div', 'lcs-tabs');
    const tInv = el('button', 'lcs-tab', 'Inventory');
    const tCre = el('button', 'lcs-tab', 'Creative');
    tInv.addEventListener('click', () => this.setTab('inventory'));
    tCre.addEventListener('click', () => this.setTab('creative'));
    this.tabs.append(tInv, tCre);
    this.panel.appendChild(this.tabs);

    // Survival part: crafting 2×2.
    this.survivalPart = el('div');
    this.survivalPart.appendChild(el('div', 'lcs-subtitle', 'Crafting'));
    const { gridEl, outEl } = craftingSection(this.survivalPart);
    this.addSlots(gridEl, 'craft', this.grid.sources(() => this.changed()), 2);
    this.addSlots(outEl, 'output', [this.grid.output(() => this.changed())], 1);
    this.panel.appendChild(this.survivalPart);

    // Creative part: searchable palette of every item.
    this.creativePart = el('div', 'lcs-creative');
    this.search = el('input', 'lcs-search');
    this.search.placeholder = 'Search items…';
    this.search.addEventListener('input', () => {
      this.offset = 0;
      this.buildPalette();
    });
    const pal = el('div');
    const sources: SlotSource[] = [];
    for (let i = 0; i < 9 * this.paletteRows; i++) {
      sources.push({ infinite: true, get: () => (this.palette[this.offset + i] ? { item: this.palette[this.offset + i], count: 1 } : null), set: () => {} });
    }
    this.addSlots(pal, 'palette', sources, 9);
    pal.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.scroll(Math.sign(e.deltaY));
    });
    const nav = el('div', 'lcs-nav');
    const up = el('button', 'lcs-tab', '▲');
    const down = el('button', 'lcs-tab', '▼');
    up.addEventListener('click', () => this.scroll(-1));
    down.addEventListener('click', () => this.scroll(1));
    nav.append(up, down);
    this.creativePart.append(this.search, pal, nav);
    this.panel.appendChild(this.creativePart);

    this.panel.appendChild(el('div', 'lcs-subtitle', 'Inventory'));
    this.panel.appendChild(this.playerInventory());
  }

  private scroll(dir: number): void {
    const maxOff = Math.max(0, Math.ceil(this.palette.length / 9) * 9 - 9 * this.paletteRows);
    this.offset = Math.max(0, Math.min(maxOff, this.offset + dir * 9));
    this.refresh();
  }

  private buildPalette(): void {
    const q = this.search.value.trim().toLowerCase().replace(/\s+/g, '_');
    this.palette = allItems()
      .filter((d) => d.name !== 'air' && (!q || d.name.includes(q) || d.displayName.toLowerCase().includes(this.search.value.trim().toLowerCase())))
      .map((d) => d.name);
    this.refresh();
  }

  private setTab(tab: 'inventory' | 'creative'): void {
    this.tab = tab === 'creative' && this.game.player.mode !== 'creative' ? 'inventory' : tab;
    this.survivalPart.style.display = this.tab === 'inventory' ? '' : 'none';
    this.creativePart.style.display = this.tab === 'creative' ? '' : 'none';
    this.tabs.style.display = this.game.player.mode === 'creative' ? '' : 'none';
    [...this.tabs.children].forEach((c, i) => c.classList.toggle('lcs-tab-on', (i === 0) === (this.tab === 'inventory')));
    if (this.tab === 'creative') this.buildPalette();
  }

  protected quickTargets(group: string, stack: ItemStack): string[] {
    if (group === 'craft' || group === 'output') return ['main', 'hotbar'];
    return super.quickTargets(group, stack);
  }

  onOpen(): void {
    this.setTab(this.game.player.mode === 'creative' ? 'creative' : 'inventory');
    super.onOpen();
  }

  onClose(): void {
    this.grid.returnAll((s) => throwFromPlayer(this.game, s));
    super.onClose();
  }
}

// -- crafting table ------------------------------------------------------------------------------

export class CraftingTableScreen extends ContainerScreen {
  readonly grid: CraftingGrid;
  private off: (() => void) | null = null;

  constructor(game: Game) {
    super(game, 'crafting_table', 'Crafting Table');
    this.grid = new CraftingGrid(game, 3, 'crafting_table');
    const { gridEl, outEl } = craftingSection(this.panel);
    this.addSlots(gridEl, 'craft', this.grid.sources(() => this.changed()), 3);
    this.addSlots(outEl, 'output', [this.grid.output(() => this.changed())], 1);
    this.panel.appendChild(el('div', 'lcs-subtitle', 'Inventory'));
    this.panel.appendChild(this.playerInventory());
  }

  protected quickTargets(group: string, stack: ItemStack): string[] {
    if (group === 'craft' || group === 'output') return ['main', 'hotbar'];
    if (group === 'main' || group === 'hotbar') return ['craft'];
    return super.quickTargets(group, stack);
  }

  onOpen(): void {
    this.off = onRecipeRegistered(() => {
      this.grid.recompute();
      this.refresh();
    });
    super.onOpen();
  }

  onClose(): void {
    this.off?.();
    this.grid.returnAll((s) => throwFromPlayer(this.game, s));
    super.onClose();
  }
}

// -- furnace -------------------------------------------------------------------------------------

export class FurnaceScreen extends ContainerScreen {
  private state: FurnaceState | null = null;
  private readonly flame: HTMLElement;
  private readonly arrow: HTMLElement;
  private off: (() => void) | null = null;

  constructor(game: Game) {
    super(game, 'furnace', 'Furnace');
    const row = el('div', 'lcs-furnace');
    const left = el('div', 'lcs-furnace-left');
    const inEl = el('div');
    this.flame = el('div', 'lcs-flame');
    const fuelEl = el('div');
    left.append(inEl, this.flame, fuelEl);
    this.arrow = el('div', 'lcs-progress');
    this.arrow.appendChild(el('div'));
    const outEl = el('div');
    row.append(left, this.arrow, outEl);
    this.panel.appendChild(row);
    const changed = () => getContainers(game).changed();
    const slot = (k: 'input' | 'fuel' | 'output', extra: Partial<SlotSource> = {}): SlotSource => ({
      get: () => this.state?.[k] ?? null,
      set: (s) => {
        if (!this.state) return;
        this.state[k] = s && s.count > 0 ? { ...s } : null;
        changed();
      },
      ...extra,
    });
    this.addSlots(inEl, 'input', [slot('input')], 1);
    this.addSlots(fuelEl, 'fuel', [slot('fuel', { canPlace: (s) => fuelTime(s) > 0 })], 1);
    this.addSlots(outEl, 'output', [
      slot('output', {
        output: true,
        take: () => {
          const st = this.state?.output ?? null;
          if (this.state) this.state.output = null;
          changed();
          return st;
        },
      }),
    ], 1);
    this.panel.appendChild(el('div', 'lcs-subtitle', 'Inventory'));
    this.panel.appendChild(this.playerInventory());
  }

  private pos: [number, number, number] = [0, 0, 0];

  /** Binds the screen to a furnace block. */
  bind(x: number, y: number, z: number): this {
    this.pos = [x, y, z];
    this.state = getContainers(this.game).furnace(x, y, z);
    return this;
  }

  protected quickTargets(group: string, stack: ItemStack): string[] {
    if (group === 'main' || group === 'hotbar') {
      if (smeltingFor(stack)) return ['input'];
      if (fuelTime(stack) > 0) return ['fuel'];
    }
    if (group === 'input' || group === 'fuel' || group === 'output') return ['main', 'hotbar'];
    return super.quickTargets(group, stack);
  }

  refresh(): void {
    super.refresh();
    const s = this.state;
    if (!s) return;
    const burn = s.burnMax > 0 ? s.burn / s.burnMax : 0;
    this.flame.style.setProperty('--burn', String(burn));
    this.flame.classList.toggle('lcs-lit', s.burn > 0);
    (this.arrow.firstChild as HTMLElement).style.width = `${Math.round(s.progress * 100)}%`;
  }

  onOpen(): void {
    this.off = getContainers(this.game).onChange(() => {
      if (getContainers(this.game).get(...this.pos) !== this.state) this.game.ui.screens.close(this);
      else this.refresh();
    });
    super.onOpen();
  }

  onClose(): void {
    this.off?.();
    super.onClose();
  }
}

// -- chest ---------------------------------------------------------------------------------------

export class ChestScreen extends ContainerScreen {
  private state: ChestState | null = null;
  private off: (() => void) | null = null;

  constructor(game: Game) {
    super(game, 'chest', 'Chest');
    const grid = el('div');
    const sources: SlotSource[] = [];
    for (let i = 0; i < CHEST_SIZE; i++) {
      sources.push({
        get: () => this.state?.slots[i] ?? null,
        set: (s) => {
          if (!this.state) return;
          this.state.slots[i] = s && s.count > 0 ? { ...s } : null;
          getContainers(game).changed();
        },
      });
    }
    this.addSlots(grid, 'chest', sources, 9);
    this.panel.appendChild(grid);
    this.panel.appendChild(el('div', 'lcs-subtitle', 'Inventory'));
    this.panel.appendChild(this.playerInventory());
  }

  private pos: [number, number, number] = [0, 0, 0];

  /** Binds the screen to a chest block. */
  bind(x: number, y: number, z: number): this {
    this.pos = [x, y, z];
    this.state = getContainers(this.game).chest(x, y, z);
    return this;
  }

  protected quickTargets(group: string, stack: ItemStack): string[] {
    if (group === 'main' || group === 'hotbar') return ['chest'];
    if (group === 'chest') return ['main', 'hotbar'];
    return super.quickTargets(group, stack);
  }

  onOpen(): void {
    this.off = getContainers(this.game).onChange(() => {
      if (getContainers(this.game).get(...this.pos) !== this.state) this.game.ui.screens.close(this);
      else this.refresh();
    });
    super.onOpen();
  }

  onClose(): void {
    this.off?.();
    super.onClose();
  }
}

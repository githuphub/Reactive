/**
 * Player inventory: 36 slots, the first 9 are the hotbar. V0 ships a simple model with
 * creative-ish defaults (`infinite`); V1 builds the full inventory/crafting UI on top.
 */
import { findItem, type ItemStack } from '../engine/items';
import type { EventBus, GameEvents } from '../game/events';

export const HOTBAR_SIZE = 9;
export const INVENTORY_SIZE = 36;

export interface InventoryData {
  slots: (ItemStack | null)[];
  selected: number;
  infinite: boolean;
}

export class Inventory {
  readonly slots: (ItemStack | null)[] = new Array(INVENTORY_SIZE).fill(null);
  /** Hotbar index 0..8. */
  selected = 0;
  /** Placing doesn't consume items and tools don't wear (creative-ish). */
  infinite = true;

  constructor(private readonly events: EventBus<GameEvents>) {}

  /** The stack in the selected hotbar slot. */
  get selectedStack(): ItemStack | null {
    return this.slots[this.selected];
  }

  select(i: number): void {
    const n = ((i % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    if (n === this.selected) return;
    this.selected = n;
    this.events.emit('hotbarChanged', { slot: n, stack: this.slots[n] });
  }

  get(i: number): ItemStack | null {
    return this.slots[i] ?? null;
  }

  /** Replaces a slot. */
  set(i: number, stack: ItemStack | null): void {
    this.slots[i] = stack && stack.count > 0 ? stack : null;
    this.changed(i);
  }

  /** Adds items, merging into existing stacks first. Returns the count that didn't fit. */
  add(stack: ItemStack): number {
    const def = findItem(stack.item);
    if (!def) return stack.count;
    let left = stack.count;
    for (let i = 0; i < INVENTORY_SIZE && left > 0; i++) {
      const s = this.slots[i];
      if (s && s.item === stack.item && !s.data && !stack.data && s.count < def.maxStack) {
        const n = Math.min(left, def.maxStack - s.count);
        s.count += n;
        left -= n;
        this.changed(i);
      }
    }
    for (let i = 0; i < INVENTORY_SIZE && left > 0; i++) {
      if (!this.slots[i]) {
        const n = Math.min(left, def.maxStack);
        this.slots[i] = { ...stack, count: n };
        left -= n;
        this.changed(i);
      }
    }
    return left;
  }

  /** Total count of an item. */
  count(item: string): number {
    let n = 0;
    for (const s of this.slots) if (s?.item === item) n += s.count;
    return n;
  }

  /** Removes up to `count` of an item; returns true if all were removed. */
  remove(item: string, count = 1): boolean {
    let left = count;
    for (let i = INVENTORY_SIZE - 1; i >= 0 && left > 0; i--) {
      const s = this.slots[i];
      if (s?.item !== item) continue;
      const n = Math.min(left, s.count);
      s.count -= n;
      left -= n;
      if (s.count <= 0) this.slots[i] = null;
      this.changed(i);
    }
    return left === 0;
  }

  /** Uses one of the selected item (no-op when infinite). */
  consumeSelected(n = 1): void {
    if (this.infinite) return;
    const s = this.slots[this.selected];
    if (!s) return;
    s.count -= n;
    if (s.count <= 0) this.slots[this.selected] = null;
    this.changed(this.selected);
  }

  /** Wears the selected tool; breaks it at its durability. Returns true if it broke. */
  damageSelected(amount = 1): boolean {
    if (this.infinite) return false;
    const s = this.slots[this.selected];
    const tool = s ? findItem(s.item)?.tool : null;
    if (!s || !tool) return false;
    s.damage = (s.damage ?? 0) + amount;
    if (s.damage >= tool.durability) {
      this.slots[this.selected] = null;
      this.changed(this.selected);
      return true;
    }
    this.changed(this.selected);
    return false;
  }

  serialize(): InventoryData {
    return { slots: this.slots.map((s) => (s ? { ...s } : null)), selected: this.selected, infinite: this.infinite };
  }

  deserialize(d: InventoryData): void {
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const s = d.slots?.[i];
      this.slots[i] = s && findItem(s.item) ? { ...s } : null;
    }
    this.selected = Math.max(0, Math.min(HOTBAR_SIZE - 1, d.selected ?? 0));
    this.infinite = d.infinite ?? this.infinite;
    this.events.emit('inventoryChanged', {});
    this.events.emit('hotbarChanged', { slot: this.selected, stack: this.selectedStack });
  }

  /** Fills the default creative-ish loadout. */
  fillDefaults(): void {
    const hotbar = ['diamond_pickaxe', 'grass', 'cobblestone', 'oak_planks', 'oak_log', 'glass', 'torch', 'bricks', 'door'];
    const rest = [
      'dirt', 'stone', 'sand', 'gravel', 'oak_leaves', 'birch_planks', 'spruce_planks', 'birch_log', 'spruce_log',
      'stone_bricks', 'sandstone', 'white_wool', 'red_wool', 'blue_wool', 'yellow_wool', 'bookshelf', 'crafting_table',
      'furnace', 'chest', 'ladder', 'glow_lamp', 'pumpkin', 'hay_bale', 'iron_block', 'gold_block', 'diamond_axe', 'diamond_shovel',
    ];
    hotbar.forEach((it, i) => (this.slots[i] = { item: it, count: findItem(it)?.maxStack === 1 ? 1 : 64 }));
    rest.forEach((it, i) => (this.slots[HOTBAR_SIZE + i] = { item: it, count: findItem(it)?.maxStack === 1 ? 1 : 64 }));
    this.events.emit('inventoryChanged', {});
  }

  private changed(i: number): void {
    this.events.emit('inventoryChanged', {});
    if (i < HOTBAR_SIZE) this.events.emit('hotbarChanged', { slot: i, stack: this.slots[i] });
  }
}

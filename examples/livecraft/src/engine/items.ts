/**
 * Item registry: tools, materials, food and block items. Items are identified by string id.
 * Every block automatically has a block item with the same name (see {@link itemByName}).
 */
import { allBlocks, blockById, findBlock, type BlockDef, type DropSpec, type ToolKind } from './blocks';

export interface ToolSpec {
  kind: ToolKind;
  /** 1 wood, 2 stone, 3 iron, 4 diamond (gold is tier 1 but fast). */
  tier: number;
  /** Break speed multiplier when the tool matches the block's preferred tool. */
  speed: number;
  /** Uses before it breaks. */
  durability: number;
  /** Melee damage in half-hearts. */
  damage: number;
}

export interface FoodSpec {
  hunger: number;
  saturation: number;
}

export interface ItemSpec {
  /** Unique snake_case id. */
  name: string;
  displayName?: string;
  /** Default 64, tools 1. */
  maxStack?: number;
  /** Block to place when used on a block face (block name). */
  places?: string;
  tool?: ToolSpec;
  food?: FoodSpec;
  /** Atlas texture key for a flat icon. Block items render an isometric cube instead. */
  icon?: string;
  tags?: string[];
}

export interface ItemDef {
  readonly name: string;
  readonly displayName: string;
  readonly maxStack: number;
  /** Numeric block id this item places, if any. */
  readonly block: number | null;
  readonly tool: ToolSpec | null;
  readonly food: FoodSpec | null;
  /** Texture key of a flat icon, or null for an isometric block icon. */
  readonly icon: string | null;
  readonly tags: readonly string[];
}

/** A stack of items in an inventory slot. */
export interface ItemStack {
  item: string;
  count: number;
  /** Tool wear (uses so far). */
  damage?: number;
  /** Free-form per-stack data (forge stats, names, ...). */
  data?: Record<string, unknown>;
}

const items = new Map<string, ItemDef>();
const listeners = new Set<(def: ItemDef) => void>();

/** Registers an item. Throws if the name is taken by another explicit item. */
export function registerItem(spec: ItemSpec): ItemDef {
  if (items.has(spec.name)) throw new Error(`Item "${spec.name}" is already registered`);
  const placesBlock = spec.places ? findBlock(spec.places) : undefined;
  if (spec.places && !placesBlock) throw new Error(`Item "${spec.name}" places unknown block "${spec.places}"`);
  const def: ItemDef = {
    name: spec.name,
    displayName: spec.displayName ?? titleCase(spec.name),
    maxStack: spec.maxStack ?? (spec.tool ? 1 : 64),
    block: placesBlock ? placesBlock.id : null,
    tool: spec.tool ?? null,
    food: spec.food ?? null,
    icon: spec.icon ?? spec.name,
    tags: spec.tags ?? [],
  };
  items.set(def.name, def);
  for (const cb of listeners) cb(def);
  return def;
}

/**
 * Item definition by name. Block names resolve to an implicit block item.
 * Throws a clear error for unknown names.
 */
export function itemByName(name: string): ItemDef {
  const found = findItem(name);
  if (!found) throw new Error(`Unknown item "${name}"`);
  return found;
}

/** Item definition by name, or undefined. */
export function findItem(name: string): ItemDef | undefined {
  const def = items.get(name);
  if (def) return def;
  const block = findBlock(name);
  if (!block || block.id === 0) return undefined;
  const flat = block.renderType === 'cross' || block.renderType === 'torch' || block.renderType === 'ladder';
  const implicit: ItemDef = {
    name,
    displayName: block.displayName,
    maxStack: 64,
    block: block.id,
    tool: null,
    food: null,
    icon: flat ? block.faces[0] : null,
    tags: ['block', ...block.tags],
  };
  items.set(name, implicit);
  return implicit;
}

/** All explicitly registered items plus block items for every block. */
export function allItems(): ItemDef[] {
  for (const b of allBlocks()) if (b.id !== 0 && !b.liquid) findItem(b.name);
  return [...items.values()];
}

export function onItemRegistered(cb: (def: ItemDef) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Convenience constructor for a stack. */
export function stack(item: string, count = 1): ItemStack {
  return { item, count };
}

/** True if the given tool may harvest drops from the block. */
export function canHarvest(block: BlockDef, tool: ItemStack | null | undefined): boolean {
  if (block.harvestTier <= 0) return true;
  const t = tool ? findItem(tool.item)?.tool : null;
  return !!t && t.kind === block.tool && t.tier >= block.harvestTier;
}

/** Seconds needed to break `block` with `tool` (Infinity for unbreakable). */
export function breakTime(block: BlockDef, tool: ItemStack | null | undefined): number {
  if (block.hardness < 0) return Infinity;
  if (block.hardness === 0) return 0;
  const t = tool ? findItem(tool.item)?.tool : null;
  const speed = t && t.kind === block.tool ? t.speed : 1;
  const base = canHarvest(block, tool) ? 1.5 : 5;
  return (block.hardness * base) / speed;
}

/** Rolls the drops for breaking a block (empty if the tool can't harvest it). */
export function computeDrops(
  blockOrId: BlockDef | number,
  meta: number,
  tool: ItemStack | null | undefined,
  rng: () => number = Math.random,
): ItemStack[] {
  const block = typeof blockOrId === 'number' ? blockById(blockOrId) : blockOrId;
  if (!canHarvest(block, tool)) return [];
  const specs: DropSpec[] = block.dropsByMeta?.(meta) ?? block.drops;
  const out: ItemStack[] = [];
  for (const d of specs) {
    if (d.chance !== undefined && rng() >= d.chance) continue;
    let count = 1;
    if (typeof d.count === 'number') count = d.count;
    else if (d.count) count = d.count[0] + Math.floor(rng() * (d.count[1] - d.count[0] + 1));
    if (count > 0) out.push({ item: d.item, count });
  }
  return out;
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------------------------
// Built-in items
// ---------------------------------------------------------------------------------------------

/** Tool tiers: [name, tier, speed, durability, damageBonus]. */
export const TOOL_MATERIALS = [
  ['wooden', 1, 2, 59, 0],
  ['stone', 2, 4, 131, 1],
  ['iron', 3, 6, 250, 2],
  ['golden', 1, 12, 32, 0],
  ['diamond', 4, 8, 1561, 3],
] as const;

const TOOL_BASE_DAMAGE: Record<string, number> = { pickaxe: 2, axe: 3, shovel: 1, hoe: 1, sword: 4 };

for (const [mat, tier, speed, durability, bonus] of TOOL_MATERIALS) {
  for (const kind of ['pickaxe', 'axe', 'shovel', 'hoe', 'sword'] as const) {
    registerItem({
      name: `${mat}_${kind}`,
      tool: { kind, tier, speed: kind === 'sword' ? 1.5 : speed, durability, damage: TOOL_BASE_DAMAGE[kind] + bonus },
      icon: `${mat}_${kind}`,
      tags: ['tool', kind],
    });
  }
}

registerItem({ name: 'shears', tool: { kind: 'shears', tier: 1, speed: 5, durability: 238, damage: 1 }, tags: ['tool'] });
for (const name of ['stick', 'coal', 'iron_ingot', 'gold_ingot', 'diamond', 'redstone', 'wheat', 'book', 'string', 'feather', 'flint']) {
  registerItem({ name });
}
registerItem({ name: 'wheat_seeds', places: 'wheat' });
registerItem({ name: 'door', displayName: 'Wooden Door', places: 'door', icon: 'door_item' });
registerItem({ name: 'apple', food: { hunger: 4, saturation: 2.4 } });
registerItem({ name: 'bread', food: { hunger: 5, saturation: 6 } });

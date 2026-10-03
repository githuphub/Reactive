/**
 * Crafting recipes (shaped + shapeless) and smelting recipes + fuels.
 *
 * Ingredients are item names, `#tag` (any item whose definition has the tag, e.g. `#planks`,
 * `#log`), or a list of alternatives. Shaped recipes also match mirrored left-right.
 *
 * ```ts
 * registerRecipe({ id: 'lightning_pick', pattern: ['GDG', ' S ', ' S '], key: { G: 'gold_ingot', D: 'diamond', S: 'stick' },
 *                  result: { item: 'lightning_pickaxe' } });
 * registerRecipe({ ingredients: ['bone', 'bone'], result: { item: 'white_wool' } }); // shapeless
 * registerSmelting({ input: 'raw_beef', output: 'cooked_beef' });
 * registerFuel('#planks', 7.5);
 * ```
 */
import { findItem, type ItemStack } from '../engine/items';

export type Ingredient = string | string[];

export interface RecipeResult {
  item: string;
  /** Default 1. */
  count?: number;
  data?: Record<string, unknown>;
}

export interface ShapedRecipeSpec {
  /** Unique id. Default: derived from the result. */
  id?: string;
  /** Rows of single-character keys; space = empty. Up to 3×3 (2×2 fits the inventory grid). */
  pattern: string[];
  key: Record<string, Ingredient>;
  result: RecipeResult;
}

export interface ShapelessRecipeSpec {
  id?: string;
  /** Each entry consumes one slot. */
  ingredients: Ingredient[];
  result: RecipeResult;
}

export type RecipeSpec = ShapedRecipeSpec | ShapelessRecipeSpec;

export interface Recipe {
  readonly id: string;
  readonly type: 'shaped' | 'shapeless';
  readonly width: number;
  readonly height: number;
  /** Shaped: row-major cells (null = empty). */
  readonly cells: (Ingredient | null)[];
  /** Shapeless ingredients. */
  readonly ingredients: Ingredient[];
  readonly result: Required<Omit<RecipeResult, 'data'>> & { data?: Record<string, unknown> };
}

const recipes: Recipe[] = [];
const byId = new Map<string, Recipe>();
const listeners = new Set<(r: Recipe) => void>();

/** Registers a crafting recipe (runtime-safe; open crafting screens pick it up). Returns it. */
export function registerRecipe(spec: RecipeSpec): Recipe {
  if (!findItem(spec.result.item)) throw new Error(`Recipe result "${spec.result.item}" is not a known item`);
  const base = spec.id ?? spec.result.item;
  let id = base;
  for (let n = 2; byId.has(id); n++) id = `${base}_${n}`;
  let r: Recipe;
  if ('pattern' in spec) {
    const rows = spec.pattern;
    const height = rows.length;
    const width = Math.max(...rows.map((row) => row.length));
    if (height < 1 || height > 3 || width < 1 || width > 3) throw new Error(`Recipe "${id}": pattern must be 1–3 rows of 1–3 characters`);
    const cells: (Ingredient | null)[] = [];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const ch = rows[y][x] ?? ' ';
        if (ch === ' ') cells.push(null);
        else {
          const ing = spec.key[ch];
          if (ing === undefined) throw new Error(`Recipe "${id}": pattern key "${ch}" is not in key`);
          cells.push(ing);
        }
      }
    r = { id, type: 'shaped', width, height, cells, ingredients: [], result: { count: 1, ...spec.result } };
  } else {
    if (!spec.ingredients.length || spec.ingredients.length > 9) throw new Error(`Recipe "${id}": 1–9 ingredients`);
    r = { id, type: 'shapeless', width: 0, height: 0, cells: [], ingredients: [...spec.ingredients], result: { count: 1, ...spec.result } };
  }
  recipes.push(r);
  byId.set(id, r);
  for (const l of listeners) l(r);
  return r;
}

/** Removes a recipe by id. */
export function unregisterRecipe(id: string): boolean {
  const r = byId.get(id);
  if (!r) return false;
  byId.delete(id);
  recipes.splice(recipes.indexOf(r), 1);
  return true;
}

export function allRecipes(): readonly Recipe[] {
  return recipes;
}

export function getRecipe(id: string): Recipe | undefined {
  return byId.get(id);
}

/** Recipes producing an item. */
export function recipesFor(item: string): Recipe[] {
  return recipes.filter((r) => r.result.item === item);
}

export function onRecipeRegistered(cb: (r: Recipe) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** True if a stack satisfies an ingredient. */
export function matchesIngredient(stack: ItemStack | null, ing: Ingredient): boolean {
  if (!stack) return false;
  if (Array.isArray(ing)) return ing.some((i) => matchesIngredient(stack, i));
  if (ing.startsWith('#')) return findItem(stack.item)?.tags.includes(ing.slice(1)) ?? false;
  return stack.item === ing;
}

/**
 * Finds the recipe matching a crafting grid (`grid` is row-major, `size` × `size`).
 * Returns null when nothing matches.
 */
export function matchRecipe(grid: readonly (ItemStack | null)[], size: number): Recipe | null {
  let minX = size, minY = size, maxX = -1, maxY = -1;
  const filled: ItemStack[] = [];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const s = grid[y * size + x];
      if (!s) continue;
      filled.push(s);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  if (!filled.length) return null;
  const w = maxX - minX + 1, h = maxY - minY + 1;
  for (let i = recipes.length - 1; i >= 0; i--) {
    const r = recipes[i];
    if (r.type === 'shaped') {
      if (r.width !== w || r.height !== h) continue;
      if (shapedMatch(r, grid, size, minX, minY, false) || shapedMatch(r, grid, size, minX, minY, true)) return r;
    } else if (shapelessMatch(r, filled)) return r;
  }
  return null;
}

function shapedMatch(r: Recipe, grid: readonly (ItemStack | null)[], size: number, ox: number, oy: number, mirror: boolean): boolean {
  for (let y = 0; y < r.height; y++)
    for (let x = 0; x < r.width; x++) {
      const ing = r.cells[y * r.width + (mirror ? r.width - 1 - x : x)];
      const s = grid[(oy + y) * size + ox + x];
      if (ing === null) {
        if (s) return false;
      } else if (!matchesIngredient(s, ing)) return false;
    }
  return true;
}

function shapelessMatch(r: Recipe, filled: ItemStack[]): boolean {
  if (filled.length !== r.ingredients.length) return false;
  const used = new Array(filled.length).fill(false);
  // Match specific ingredients before tags/alternatives.
  const order = [...r.ingredients].sort((a, b) => specificity(b) - specificity(a));
  for (const ing of order) {
    let found = -1;
    for (let i = 0; i < filled.length; i++) {
      if (!used[i] && matchesIngredient(filled[i], ing)) {
        found = i;
        break;
      }
    }
    if (found < 0) return false;
    used[found] = true;
  }
  return true;
}

function specificity(i: Ingredient): number {
  if (Array.isArray(i)) return 0;
  return i.startsWith('#') ? 1 : 2;
}

// -- smelting ------------------------------------------------------------------------------------

export interface SmeltingRecipe {
  input: Ingredient;
  output: string;
  /** Output per input item. Default 1. */
  count?: number;
  /** Seconds per item. Default 4. */
  time?: number;
}

const smelting: SmeltingRecipe[] = [];
const fuels: { item: Ingredient; seconds: number }[] = [];

/** Registers a furnace recipe. */
export function registerSmelting(r: SmeltingRecipe): void {
  if (!findItem(r.output)) throw new Error(`Smelting output "${r.output}" is not a known item`);
  smelting.push(r);
}

/** Registers a fuel and its burn time in seconds (items or #tags). */
export function registerFuel(item: Ingredient, seconds: number): void {
  fuels.push({ item, seconds });
}

/** The smelting recipe for an input stack, or null. */
export function smeltingFor(stack: ItemStack | null): SmeltingRecipe | null {
  if (!stack) return null;
  for (let i = smelting.length - 1; i >= 0; i--) if (matchesIngredient(stack, smelting[i].input)) return smelting[i];
  return null;
}

/** Burn time of a fuel stack in seconds (0 if not a fuel). */
export function fuelTime(stack: ItemStack | null): number {
  if (!stack) return 0;
  for (let i = fuels.length - 1; i >= 0; i--) if (matchesIngredient(stack, fuels[i].item)) return fuels[i].seconds;
  return 0;
}

export function allSmelting(): readonly SmeltingRecipe[] {
  return smelting;
}

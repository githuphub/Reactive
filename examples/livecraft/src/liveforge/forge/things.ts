/**
 * Forged things (`forge.thing`, spells, armour pieces, loot) as Livecraft items. One record per item id holds the
 * ForgedThing (with its voxel model); registration makes the item (tool / food / stack size by category), an
 * isometric icon (hotbar + atlas tile for dropped sprites), the held and dropped voxel models and the recipe.
 *
 * An AI upgrade replaces the record **in place** (same item id): `updateThing` swaps the model and stats, repaints
 * the icon everywhere it is shown, rebuilds the held model and re-registers the recipe.
 */
import * as THREE from 'three';
import { rulesForgedThing, type ForgedThing, type ThingEffect, type VfxRecipe } from '@liveforge/sdk';
import type { Game } from '../../game/game';
import { findItem, registerItem, type FoodSpec, type ItemDef, type ToolSpec } from '../../engine/items';
import type { ToolKind } from '../../engine/blocks';
import { registerTexture } from '../../engine/textures';
import { heldMeshFactories, refreshHeldItem } from '../../player/held-item';
import { iconProviders } from '../../ui/icons';
import { dropMeshFactories } from '../../survival/item-drops';
import { registerRecipe, unregisterRecipe } from '../../survival';
import { cubeModel, eggModel, expand, isoCanvas, isoPixels, mainColors, voxelGeometry, wandModel } from './voxel-model';

/** What the item does when used: the forged category, or a spell / an armour piece. */
export type ThingUse = ForgedThing['category'] | 'spell';

/** Spell data (forge.vfx): the recipe, its element and how it is cast. */
export interface SpellData {
  recipe: VfxRecipe;
  element: 'fire' | 'frost' | 'lightning' | 'heal' | 'wind' | 'arcane';
  shape: 'projectile' | 'burst';
  colors: string[];
}

/** Armour set membership (forge.armour_set). */
export interface SetData {
  id: string;
  name: string;
  /** Item ids of every piece. */
  pieces: string[];
  bonus: string;
  /** What the full set grants. */
  effect: ThingEffect | 'fire_resist';
}

/** A forged thing as the game stores it (saved in `lf_forge`; re-registered on load in save order). */
export interface LcThing {
  /** Livecraft item id. */
  id: string;
  kind: 'thing' | 'spell' | 'armour' | 'auto';
  thing: ForgedThing;
  prompt: string;
  /** rules | ai | cache | bake | local. */
  source: string;
  /** Times the record was replaced (AI refinement). */
  version: number;
  spell?: SpellData;
  set?: SetData;
}

const things = new Map<string, LcThing>();
const caches = new Map<string, { display?: THREE.BufferGeometry; icon?: HTMLCanvasElement; card?: HTMLCanvasElement; model?: ForgedThing['model'] }>();
const listeners = new Set<(t: LcThing, replaced: boolean) => void>();
let game: Game | null = null;

/** The record behind an item id. */
export function thingSpec(item: string | null | undefined): LcThing | undefined {
  return item ? things.get(item) : undefined;
}

/** Every record (registration order). */
export function allThings(): LcThing[] {
  return [...things.values()];
}

/** Called after a thing is registered or replaced. */
export function onThingChanged(cb: (t: LcThing, replaced: boolean) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** How the item is used (unknown future categories behave like decorations). */
export function useOf(t: LcThing): ThingUse | 'decoration' {
  if (t.kind === 'spell') return 'spell';
  const c = t.thing.category as string;
  return (['weapon', 'tool', 'food', 'creature', 'wearable', 'decoration', 'material', 'block', 'vehicle'] as string[]).includes(c) ? (c as ThingUse) : 'decoration';
}

/** The model the item shows as (egg for creatures, wand for spells, a cube for blocks, else the thing's model). */
export function displayModel(t: LcThing): ForgedThing['model'] {
  const c = cacheOf(t);
  if (c.model) return c.model;
  const use = useOf(t);
  const colors = mainColors(t.thing.model);
  c.model = use === 'creature' ? eggModel(colors) : use === 'spell' ? wandModel(t.spell?.colors ?? colors) : use === 'block' ? blockModel(t.thing.model) : t.thing.model;
  return c.model;
}

/** World model of a block thing: the model itself when it is a near-full cube, else its colours on a cube. */
export function blockModel(model: ForgedThing['model']): ForgedThing['model'] {
  const e = expand(model);
  const [x, y, z] = e.size;
  return x === y && y === z && e.voxels.length >= x * y * z * 0.6 ? model : cubeModel(mainColors(model));
}

/** A 32×32 isometric icon (cached per version). */
export function thingIcon(t: LcThing): HTMLCanvasElement {
  const c = cacheOf(t);
  return (c.icon ??= isoCanvas(displayModel(t), { size: 32 }));
}

/** A big preview canvas for cards (the thing's own model, also for creatures). */
export function thingPreview(t: LcThing, size = 128): HTMLCanvasElement {
  const c = cacheOf(t);
  if (c.card && c.card.width === size) return c.card;
  return (c.card = isoCanvas(t.kind === 'spell' ? displayModel(t) : t.thing.model, { size, outline: true }));
}

function cacheOf(t: LcThing) {
  const k = `${t.id}:${t.version}`;
  let c = caches.get(k);
  if (!c) caches.set(k, (c = {}));
  return c;
}

/** The brightest palette colour (glow / light colour). */
export function glowColor(t: LcThing): string {
  const cols = Object.values(t.thing.model.palette ?? {});
  let best = cols[0] ?? '#ffe27a', bl = -1;
  for (const c of cols) {
    const n = parseInt(c.slice(1), 16);
    const l = ((n >> 16) & 255) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11;
    if (l > bl) {
      bl = l;
      best = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------- item definition

const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function toolKind(t: ForgedThing): ToolKind {
  const words = `${t.tags.join(' ')} ${t.name}`.toLowerCase();
  if (t.category === 'weapon') return 'sword';
  if (/pick|hammer|drill|mattock/.test(words)) return 'pickaxe';
  if (/\baxe|hatchet|-axe/.test(words)) return 'axe';
  if (/shovel|spade|trowel/.test(words)) return 'shovel';
  if (/\bhoe|scythe|sickle|rake/.test(words)) return 'hoe';
  if (/shears|scissors|clippers/.test(words)) return 'shears';
  return 'pickaxe';
}

function defFields(t: LcThing): { displayName: string; maxStack: number; tool: ToolSpec | null; food: FoodSpec | null; tags: string[] } {
  const th = t.thing;
  const s = th.stats;
  const use = useOf(t);
  let tool: ToolSpec | null = null;
  let food: FoodSpec | null = null;
  let maxStack = Math.max(1, Math.min(64, Math.round(s.stackSize || 1)));
  if (use === 'weapon' || use === 'tool') {
    const kind = toolKind(th);
    const mining = Math.max(1, s.miningSpeed || (use === 'tool' ? 6 : 1));
    tool = {
      kind,
      tier: use === 'weapon' ? 3 : mining >= 10 ? 4 : mining >= 6 ? 3 : 2,
      speed: kind === 'sword' ? 1.6 : Math.max(2, Math.min(16, mining)),
      durability: Math.round(Math.max(40, Math.min(3000, s.durability || 400))),
      damage: Math.round(Math.max(1, Math.min(20, s.damage || (use === 'weapon' ? 6 : 3)))),
    };
    maxStack = 1;
  } else if (use === 'food') {
    food = { hunger: Math.max(1, Math.min(20, Math.round(s.food || 4))), saturation: Math.max(0, Math.min(20, s.saturation || 2)) };
  } else if (use === 'creature') maxStack = 16;
  else if (use === 'wearable' || use === 'spell' || use === 'vehicle') maxStack = 1;
  const tags = ['forged', 'thing', `thing_${use}`, ...th.tags.filter((x) => /^[a-z_-]+$/.test(x))];
  if (use === 'food') tags.push('food');
  return { displayName: use === 'creature' ? `${th.name} Spawn Egg` : th.name, maxStack, tool, food, tags };
}

function textureKey(t: LcThing): string {
  return `thing/${t.id}/${t.version}`;
}

function paintTexture(t: LcThing): void {
  const key = textureKey(t);
  const px = isoPixels(displayModel(t));
  registerTexture(key, (tile) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4;
      if (px[i + 3] > 40) tile.set(x, y, [px[i], px[i + 1], px[i + 2]], 255);
    }
  }, { pad: 'clamp' });
}

/** Item names a thing refers to (drops, lays, tame food) are made real items when unknown. */
function ensureRefs(t: LcThing): void {
  const c = t.thing.creature;
  if (!c) return;
  for (const n of [...c.drops, ...(c.lays ? [c.lays] : []), ...(c.tameWith ? [c.tameWith] : [])]) ensureItem(n);
}

/** Item id for a free-form item name ("golden egg" → `golden_egg`). */
export function itemIdOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'thing';
}

/**
 * Makes sure an item named `name` exists: known items are used as they are, unknown ones become a forged material
 * or food with a rules voxel model (deterministic, so the same name always gives the same item). Returns the id.
 */
export function ensureItem(name: string): string {
  const id = itemIdOf(name);
  if (findItem(id)) return id;
  const thing = rulesForgedThing({ prompt: id.replace(/_/g, ' '), categories: ['material', 'food'] });
  thing.name = titleCase(id);
  registerThing({ id, kind: 'auto', thing, prompt: id, source: 'rules', version: 0 });
  return id;
}

function trimPattern(shape: readonly string[]): string[] {
  let rows = shape.map((r) => r.padEnd(3, ' ').slice(0, 3));
  while (rows.length && !rows[0].trim()) rows.shift();
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  if (!rows.length) return [];
  let l = 0, r = 3;
  while (l < 3 && rows.every((x) => x[l] === ' ')) l++;
  while (r > l && rows.every((x) => x[r - 1] === ' ')) r--;
  rows = rows.map((x) => x.slice(l, r));
  return rows;
}

function registerThingRecipe(t: LcThing): void {
  unregisterRecipe(`thing_${t.id}`);
  const rc = t.thing.recipe;
  if (!rc) return;
  const pattern = trimPattern(rc.shape);
  const key: Record<string, string> = {};
  for (const [k, v] of Object.entries(rc.key)) if (pattern.some((r) => r.includes(k))) key[k] = itemIdOf(v);
  if (!pattern.length || !Object.values(key).every((v) => findItem(v))) return;
  try {
    registerRecipe({ id: `thing_${t.id}`, pattern, key, result: { item: t.id } });
  } catch (err) {
    console.warn('[forge] thing recipe not registered', err);
  }
}

/** True when the thing's recipe could be registered (all ingredients are known items). */
export function recipeKnown(t: LcThing): boolean {
  const rc = t.thing.recipe;
  return !!rc && Object.values(rc.key).every((v) => !!findItem(itemIdOf(v)));
}

/** Registers a thing (item, icon, models, recipe). A known id is replaced in place (see {@link updateThing}). */
export function registerThing(t: LcThing): void {
  if (things.has(t.id)) return updateThing(t);
  const existing = findItem(t.id);
  if (existing && !things.has(t.id)) {
    // an id clash with a built-in item: keep the built-in, never shadow it
    if (t.kind === 'auto') return;
    t.id = `${t.id}_lf`;
    if (things.has(t.id)) return updateThing(t);
  }
  things.set(t.id, t);
  ensureRefs(t);
  paintTexture(t);
  const f = defFields(t);
  registerItem({ name: t.id, displayName: f.displayName, maxStack: f.maxStack, icon: textureKey(t), ...(f.tool ? { tool: f.tool } : {}), ...(f.food ? { food: f.food } : {}), tags: f.tags });
  registerThingRecipe(t);
  for (const l of listeners) l(t, false);
}

/** Replaces a registered thing in place: same item id, new model / stats / icon / recipe; repaints everywhere. */
export function updateThing(t: LcThing): void {
  const prev = things.get(t.id);
  if (!prev) return registerThing(t);
  t.version = Math.max(t.version, prev.version + 1);
  things.set(t.id, t);
  ensureRefs(t);
  paintTexture(t);
  const def = findItem(t.id) as ItemDef | undefined;
  if (def) {
    const f = defFields(t);
    Object.assign(def as unknown as Record<string, unknown>, { displayName: f.displayName, maxStack: f.maxStack, tool: f.tool, food: f.food, tags: f.tags, icon: textureKey(t) });
  }
  if (game) {
    game.atlas.slot(textureKey(t));
    game.atlas.flush();
    game.icons.invalidate(t.id);
    for (const s of game.inventory.slots) if (s?.item === t.id && s.data) s.data.name = t.thing.name;
    game.events.emit('inventoryChanged', {});
  }
  refreshHeldItem();
  registerThingRecipe(t);
  for (const l of listeners) l(t, true);
}

// ---------------------------------------------------------------- held + dropped models

function heldMesh(t: LcThing): THREE.Mesh {
  const model = displayModel(t);
  const e = expand(model);
  const longest = Math.max(...e.size);
  const unit = (useOf(t) === 'creature' ? 0.3 : 0.62) / longest;
  const pivot = model.pivot ?? [e.size[0] / 2, 0, e.size[2] / 2];
  const geo = voxelGeometry(model, { unit, origin: pivot, faceShade: true });
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true }));
  mesh.rotation.set(0.15, -0.7, 0.3);
  const h = (e.size[1] / longest) * 0.62;
  mesh.position.set(0.04, -0.12 - h * 0.15, 0);
  return mesh;
}

function dropMesh(t: LcThing): THREE.Mesh {
  const model = displayModel(t);
  const e = expand(model);
  const unit = 0.42 / Math.max(...e.size);
  return new THREE.Mesh(voxelGeometry(model, { unit, faceShade: true }), new THREE.MeshBasicMaterial({ vertexColors: true }));
}

/** @internal wires the hooks (held model, dropped model, hotbar icon). Call once at forge init. */
export function initThings(g: Game): void {
  game = g;
  heldMeshFactories.unshift((name) => {
    const t = things.get(name);
    return t ? heldMesh(t) : null;
  });
  dropMeshFactories.push((name) => {
    const t = things.get(name);
    return t ? dropMesh(t) : null;
  });
  iconProviders.push((name) => {
    const t = things.get(name);
    return t ? thingIcon(t) : null;
  });
}

/** Effect + colour of an item if it is a forged thing. */
export function thingEffect(item: string | null | undefined): { effect: ThingEffect; color: string } | null {
  const t = thingSpec(item);
  if (!t || t.thing.effect === 'none') return null;
  return { effect: t.thing.effect, color: glowColor(t) };
}

/** Clean item-id slug of a forged thing id (prefixed so it never shadows built-ins). */
export function thingItemId(thing: ForgedThing): string {
  return `lf_${itemIdOf(thing.id)}`.slice(0, 48);
}

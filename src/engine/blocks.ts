/**
 * Block registry. Built-in blocks are registered at module load in a fixed order, so their
 * numeric ids are identical on the main thread and in every worker. More blocks can be
 * registered at runtime with {@link registerBlock} (the mesh workers receive the updated table).
 */
import { MAX_BLOCK_TYPES } from './constants';

export type RenderType = 'none' | 'cube' | 'cross' | 'liquid' | 'door' | 'ladder' | 'torch';
export type RenderPass = 'opaque' | 'cutout' | 'transparent';
export type ToolKind = 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'sword' | 'shears' | 'none';
export type BlockMaterial =
  | 'air' | 'stone' | 'earth' | 'sand' | 'wood' | 'plant' | 'glass' | 'metal' | 'wool' | 'liquid' | 'snow';

/** One possible drop of a broken block. */
export interface DropSpec {
  item: string;
  /** Fixed count or inclusive [min, max]. Default 1. */
  count?: number | [number, number];
  /** 0..1, default 1. */
  chance?: number;
}

/** Texture keys per face. `all` < `side` < specific faces in priority. */
export interface BlockTextureSpec {
  all?: string;
  side?: string;
  top?: string;
  bottom?: string;
  /** Front face for orientable blocks (furnace, chest, pumpkin). Defaults to side. */
  front?: string;
  /** Textures selected by metadata (crop stages, door halves). */
  stages?: string[];
}

/** Input for {@link registerBlock}. Only `name` is required; everything else has sensible defaults. */
export interface BlockSpec {
  /** Unique string id, snake_case (e.g. `oak_planks`). */
  name: string;
  displayName?: string;
  textures?: BlockTextureSpec;
  /** Default `cube`. */
  renderType?: RenderType;
  /** Defaults: cube → opaque, cross/door/ladder/torch → cutout, liquid → transparent. */
  pass?: RenderPass;
  /** Has collision. Default true for cube/door, false otherwise. */
  solid?: boolean;
  /** Full opaque cube: hides neighbour faces, blocks light, casts AO. Default: cube in the opaque pass. */
  opaque?: boolean;
  liquid?: boolean;
  /** Emitted block light 0..15. */
  light?: number;
  /** Extra sky/block light lost when passing through (0..15). Opaque blocks always block fully. */
  lightFilter?: number;
  /** Seconds-ish base break time. 0 = instant, -1 = unbreakable. Default 1. */
  hardness?: number;
  tool?: ToolKind;
  /** Minimum tool tier needed to get drops (0 = hand works). 1 wood, 2 stone, 3 iron, 4 diamond. */
  harvestTier?: number;
  /** Default: drops itself. Use [] for no drops. */
  drops?: DropSpec[];
  /** Metadata-dependent drops (e.g. ripe crops). Overrides `drops` when it returns an array. */
  dropsByMeta?: (meta: number) => DropSpec[] | undefined;
  material?: BlockMaterial;
  /** Can be replaced by placing a block into it (air, water, tall grass). */
  replaceable?: boolean;
  climbable?: boolean;
  /** Placement sets a horizontal facing in the metadata; the `front` texture faces the player. */
  orientable?: boolean;
  /** Breaks when the block below is removed (plants, torches on the floor). */
  needsSupport?: boolean;
  /** Free-form tags for other systems (`log`, `leaves`, `ore`, `flower`, `crop`, ...). */
  tags?: string[];
}

/** A resolved, registered block type. */
export interface BlockDef {
  readonly id: number;
  readonly name: string;
  readonly displayName: string;
  readonly renderType: RenderType;
  readonly pass: RenderPass;
  readonly solid: boolean;
  readonly opaque: boolean;
  readonly liquid: boolean;
  readonly light: number;
  readonly lightFilter: number;
  readonly hardness: number;
  readonly tool: ToolKind;
  readonly harvestTier: number;
  readonly drops: DropSpec[];
  readonly dropsByMeta?: (meta: number) => DropSpec[] | undefined;
  readonly material: BlockMaterial;
  readonly replaceable: boolean;
  readonly climbable: boolean;
  readonly orientable: boolean;
  readonly needsSupport: boolean;
  readonly tags: readonly string[];
  /** Texture key per face in mesh order: +X, -X, +Y, -Y, +Z, -Z (front stored on -Z). */
  readonly faces: readonly [string, string, string, string, string, string];
  readonly stages: readonly string[];
}

/** Bit flags in {@link BLOCK_FLAGS}, for hot loops. */
export const F_OPAQUE = 1;
export const F_SOLID = 2;
export const F_LIQUID = 4;
export const F_REPLACEABLE = 8;
export const F_CLIMBABLE = 16;
export const F_RENDER = 32;

/** Per-id flag bits (see F_*). Indexed by block type id. */
export const BLOCK_FLAGS = new Uint8Array(MAX_BLOCK_TYPES);
/** Per-id emitted light 0..15. */
export const BLOCK_EMISSION = new Uint8Array(MAX_BLOCK_TYPES);
/** Per-id light attenuation 0..15 (15 for opaque). */
export const BLOCK_FILTER = new Uint8Array(MAX_BLOCK_TYPES);

const defs: BlockDef[] = [];
const byName = new Map<string, BlockDef>();
const listeners = new Set<(def: BlockDef) => void>();
let version = 0;

/** All registered block names in id order (live array). */
export const BLOCK_IDS: string[] = [];

/**
 * Registers a block type and returns its definition. Throws if the name is taken.
 * Safe to call at runtime: the atlas paints missing textures and mesh workers get the new table.
 */
export function registerBlock(spec: BlockSpec): BlockDef {
  if (byName.has(spec.name)) throw new Error(`Block "${spec.name}" is already registered`);
  if (defs.length >= MAX_BLOCK_TYPES) throw new Error('Block registry is full (4096 types)');
  const renderType = spec.renderType ?? 'cube';
  const pass: RenderPass =
    spec.pass ?? (renderType === 'cube' ? 'opaque' : renderType === 'liquid' ? 'transparent' : 'cutout');
  const solid = spec.solid ?? (renderType === 'cube' || renderType === 'door');
  const opaque = spec.opaque ?? (renderType === 'cube' && pass === 'opaque');
  const t = spec.textures ?? {};
  const fallback = t.all ?? t.side ?? t.top ?? spec.name;
  const side = t.side ?? t.all ?? fallback;
  const top = t.top ?? t.all ?? fallback;
  const bottom = t.bottom ?? t.top ?? t.all ?? fallback;
  const front = t.front ?? side;
  const def: BlockDef = {
    id: defs.length,
    name: spec.name,
    displayName: spec.displayName ?? titleCase(spec.name),
    renderType,
    pass,
    solid,
    opaque,
    liquid: spec.liquid ?? renderType === 'liquid',
    light: clamp15(spec.light ?? 0),
    lightFilter: opaque ? 15 : clamp15(spec.lightFilter ?? 0),
    hardness: spec.hardness ?? 1,
    tool: spec.tool ?? 'none',
    harvestTier: spec.harvestTier ?? 0,
    drops: spec.drops ?? [{ item: spec.name }],
    dropsByMeta: spec.dropsByMeta,
    material: spec.material ?? 'stone',
    replaceable: spec.replaceable ?? false,
    climbable: spec.climbable ?? false,
    orientable: spec.orientable ?? false,
    needsSupport: spec.needsSupport ?? false,
    tags: spec.tags ?? [],
    faces: [side, side, top, bottom, side, front],
    stages: t.stages ?? [],
  };
  defs.push(def);
  byName.set(def.name, def);
  BLOCK_IDS.push(def.name);
  let f = 0;
  if (def.opaque) f |= F_OPAQUE;
  if (def.solid) f |= F_SOLID;
  if (def.liquid) f |= F_LIQUID;
  if (def.replaceable) f |= F_REPLACEABLE;
  if (def.climbable) f |= F_CLIMBABLE;
  if (def.renderType !== 'none') f |= F_RENDER;
  BLOCK_FLAGS[def.id] = f;
  BLOCK_EMISSION[def.id] = def.light;
  BLOCK_FILTER[def.id] = def.lightFilter;
  version++;
  for (const cb of listeners) cb(def);
  return def;
}

/** Block definition by numeric id (falls back to air for unknown ids). */
export function blockById(id: number): BlockDef {
  return defs[id] ?? defs[0];
}

/** Block definition by string id. Throws a clear error for unknown names. */
export function blockByName(name: string): BlockDef {
  const def = byName.get(name);
  if (!def) throw new Error(`Unknown block "${name}". Known: ${BLOCK_IDS.join(', ')}`);
  return def;
}

/** Block definition by string id, or undefined. */
export function findBlock(name: string): BlockDef | undefined {
  return byName.get(name);
}

/** Numeric id for a block name (throws if unknown). */
export function blockId(name: string): number {
  return blockByName(name).id;
}

export function allBlocks(): readonly BlockDef[] {
  return defs;
}

/** Increments on every registration; lets caches know when to rebuild. */
export function blockRegistryVersion(): number {
  return version;
}

/** Called after each runtime registration. Returns an unsubscribe function. */
export function onBlockRegistered(cb: (def: BlockDef) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function hasTag(id: number, tag: string): boolean {
  return blockById(id).tags.includes(tag);
}

function clamp15(n: number): number {
  return Math.max(0, Math.min(15, Math.round(n)));
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------------------------
// Built-in blocks. Order defines ids: append only.
// ---------------------------------------------------------------------------------------------

const reg = (spec: BlockSpec): number => registerBlock(spec).id;
const ore = (name: string, tier: number, drops: DropSpec[] = [{ item: name }]): BlockSpec => ({
  name,
  hardness: 3,
  tool: 'pickaxe',
  harvestTier: tier,
  drops,
  tags: ['ore'],
});
const log = (wood: string): BlockSpec => ({
  name: `${wood}_log`,
  textures: { side: `${wood}_log`, top: `${wood}_log_top` },
  hardness: 2,
  tool: 'axe',
  material: 'wood',
  tags: ['log', 'wood'],
});
const planks = (wood: string): BlockSpec => ({
  name: `${wood}_planks`,
  hardness: 2,
  tool: 'axe',
  material: 'wood',
  tags: ['planks', 'wood'],
});
const leaves = (wood: string, extra: DropSpec[] = []): BlockSpec => ({
  name: `${wood}_leaves`,
  pass: 'cutout',
  opaque: false,
  lightFilter: 1,
  hardness: 0.2,
  tool: 'shears',
  material: 'plant',
  drops: [{ item: `${wood}_sapling`, chance: 0.05 }, ...extra],
  tags: ['leaves'],
});
const wool = (color: string): BlockSpec => ({
  name: `${color}_wool`,
  hardness: 0.8,
  material: 'wool',
  tags: ['wool'],
});
const plant = (name: string, drops?: DropSpec[], tags: string[] = []): BlockSpec => ({
  name,
  renderType: 'cross',
  hardness: 0,
  material: 'plant',
  needsSupport: true,
  replaceable: tags.includes('grass'),
  drops,
  tags,
});

/** Numeric ids of the built-in blocks, for hot code and readable generation code. */
export const BLOCK = {
  air: reg({ name: 'air', renderType: 'none', solid: false, replaceable: true, hardness: 0, drops: [], material: 'air' }),
  stone: reg({ name: 'stone', hardness: 1.5, tool: 'pickaxe', harvestTier: 1, drops: [{ item: 'cobblestone' }] }),
  grass: reg({
    name: 'grass',
    displayName: 'Grass Block',
    textures: { side: 'grass_side', top: 'grass_top', bottom: 'dirt' },
    hardness: 0.6,
    tool: 'shovel',
    material: 'earth',
    drops: [{ item: 'dirt' }],
  }),
  dirt: reg({ name: 'dirt', hardness: 0.5, tool: 'shovel', material: 'earth' }),
  cobblestone: reg({ name: 'cobblestone', hardness: 2, tool: 'pickaxe', harvestTier: 1 }),
  sand: reg({ name: 'sand', hardness: 0.5, tool: 'shovel', material: 'sand' }),
  gravel: reg({ name: 'gravel', hardness: 0.6, tool: 'shovel', material: 'sand' }),
  clay: reg({ name: 'clay', hardness: 0.6, tool: 'shovel', material: 'earth' }),
  snow: reg({ name: 'snow', displayName: 'Snow Block', hardness: 0.2, tool: 'shovel', material: 'snow' }),
  ice: reg({
    name: 'ice',
    pass: 'transparent',
    opaque: false,
    lightFilter: 2,
    hardness: 0.5,
    tool: 'pickaxe',
    material: 'glass',
    drops: [],
  }),
  water: reg({
    name: 'water',
    renderType: 'liquid',
    textures: { all: 'water' },
    lightFilter: 2,
    hardness: -1,
    replaceable: true,
    drops: [],
    material: 'liquid',
  }),
  lava: reg({
    name: 'lava',
    renderType: 'liquid',
    pass: 'opaque',
    textures: { all: 'lava' },
    light: 15,
    lightFilter: 15,
    hardness: -1,
    replaceable: true,
    drops: [],
    material: 'liquid',
  }),
  oak_log: reg(log('oak')),
  oak_planks: reg(planks('oak')),
  oak_leaves: reg(leaves('oak', [{ item: 'apple', chance: 0.02 }])),
  birch_log: reg(log('birch')),
  birch_planks: reg(planks('birch')),
  birch_leaves: reg(leaves('birch')),
  spruce_log: reg(log('spruce')),
  spruce_planks: reg(planks('spruce')),
  spruce_leaves: reg(leaves('spruce')),
  glass: reg({ name: 'glass', pass: 'cutout', opaque: false, hardness: 0.3, material: 'glass', drops: [] }),
  bricks: reg({ name: 'bricks', hardness: 2, tool: 'pickaxe', harvestTier: 1 }),
  stone_bricks: reg({ name: 'stone_bricks', hardness: 1.5, tool: 'pickaxe', harvestTier: 1 }),
  coal_ore: reg(ore('coal_ore', 1, [{ item: 'coal' }])),
  iron_ore: reg(ore('iron_ore', 2)),
  gold_ore: reg(ore('gold_ore', 3)),
  diamond_ore: reg(ore('diamond_ore', 3, [{ item: 'diamond' }])),
  redstone_ore: reg(ore('redstone_ore', 3, [{ item: 'redstone', count: [4, 5] }])),
  iron_block: reg({ name: 'iron_block', hardness: 5, tool: 'pickaxe', harvestTier: 2, material: 'metal' }),
  gold_block: reg({ name: 'gold_block', hardness: 3, tool: 'pickaxe', harvestTier: 3, material: 'metal' }),
  diamond_block: reg({ name: 'diamond_block', hardness: 5, tool: 'pickaxe', harvestTier: 3, material: 'metal' }),
  crafting_table: reg({
    name: 'crafting_table',
    textures: { top: 'crafting_table_top', side: 'crafting_table_side', front: 'crafting_table_front', bottom: 'oak_planks' },
    orientable: true,
    hardness: 2.5,
    tool: 'axe',
    material: 'wood',
    tags: ['interactive'],
  }),
  furnace: reg({
    name: 'furnace',
    textures: { top: 'furnace_top', side: 'furnace_side', front: 'furnace_front' },
    orientable: true,
    hardness: 3.5,
    tool: 'pickaxe',
    harvestTier: 1,
    tags: ['interactive'],
  }),
  chest: reg({
    name: 'chest',
    textures: { top: 'chest_top', side: 'chest_side', front: 'chest_front' },
    orientable: true,
    hardness: 2.5,
    tool: 'axe',
    material: 'wood',
    tags: ['interactive'],
  }),
  torch: reg({
    name: 'torch',
    renderType: 'torch',
    light: 14,
    hardness: 0,
    material: 'wood',
    needsSupport: true,
  }),
  white_wool: reg(wool('white')),
  red_wool: reg(wool('red')),
  blue_wool: reg(wool('blue')),
  yellow_wool: reg(wool('yellow')),
  bookshelf: reg({
    name: 'bookshelf',
    textures: { side: 'bookshelf', top: 'oak_planks' },
    hardness: 1.5,
    tool: 'axe',
    material: 'wood',
    drops: [{ item: 'book', count: 3 }],
  }),
  cactus: reg({
    name: 'cactus',
    textures: { side: 'cactus_side', top: 'cactus_top' },
    hardness: 0.4,
    material: 'plant',
    needsSupport: true,
  }),
  pumpkin: reg({
    name: 'pumpkin',
    textures: { side: 'pumpkin_side', top: 'pumpkin_top', front: 'pumpkin_side' },
    orientable: true,
    hardness: 1,
    tool: 'axe',
    material: 'plant',
  }),
  hay_bale: reg({ name: 'hay_bale', textures: { side: 'hay_side', top: 'hay_top' }, hardness: 0.5, material: 'plant' }),
  tnt: reg({ name: 'tnt', displayName: 'TNT', textures: { side: 'tnt_side', top: 'tnt_top', bottom: 'tnt_bottom' }, hardness: 0, material: 'plant' }),
  bedrock: reg({ name: 'bedrock', hardness: -1, drops: [] }),
  obsidian: reg({ name: 'obsidian', hardness: 25, tool: 'pickaxe', harvestTier: 4 }),
  door: reg({
    name: 'door',
    displayName: 'Wooden Door',
    renderType: 'door',
    textures: { all: 'door_lower', stages: ['door_lower', 'door_upper'] },
    hardness: 3,
    tool: 'axe',
    material: 'wood',
    drops: [{ item: 'door' }],
    tags: ['door'],
  }),
  ladder: reg({ name: 'ladder', renderType: 'ladder', climbable: true, hardness: 0.4, tool: 'axe', material: 'wood' }),
  farmland: reg({
    name: 'farmland',
    textures: { side: 'dirt', top: 'farmland', bottom: 'dirt' },
    hardness: 0.6,
    tool: 'shovel',
    material: 'earth',
    drops: [{ item: 'dirt' }],
  }),
  wheat: reg({
    ...plant('wheat', [{ item: 'wheat_seeds' }], ['crop']),
    textures: { all: 'wheat_3', stages: ['wheat_0', 'wheat_0', 'wheat_1', 'wheat_1', 'wheat_2', 'wheat_2', 'wheat_2', 'wheat_3'] },
    dropsByMeta: (meta) =>
      meta >= 7 ? [{ item: 'wheat' }, { item: 'wheat_seeds', count: [1, 3] }] : undefined,
  }),
  tall_grass: reg(plant('tall_grass', [{ item: 'wheat_seeds', chance: 0.12 }], ['grass'])),
  red_flower: reg(plant('red_flower', undefined, ['flower'])),
  yellow_flower: reg(plant('yellow_flower', undefined, ['flower'])),
  oak_sapling: reg(plant('oak_sapling', undefined, ['sapling'])),
  birch_sapling: reg(plant('birch_sapling', undefined, ['sapling'])),
  spruce_sapling: reg(plant('spruce_sapling', undefined, ['sapling'])),
  dead_bush: reg(plant('dead_bush', [{ item: 'stick', count: [0, 2] }], ['grass'])),
  snowy_grass: reg({
    name: 'snowy_grass',
    displayName: 'Snowy Grass Block',
    textures: { side: 'snowy_grass_side', top: 'snow', bottom: 'dirt' },
    hardness: 0.6,
    tool: 'shovel',
    material: 'earth',
    drops: [{ item: 'dirt' }],
  }),
  sandstone: reg({
    name: 'sandstone',
    textures: { side: 'sandstone', top: 'sandstone_top', bottom: 'sandstone_top' },
    hardness: 0.8,
    tool: 'pickaxe',
    harvestTier: 1,
  }),
  dirt_path: reg({
    name: 'dirt_path',
    textures: { side: 'dirt_path_side', top: 'dirt_path_top', bottom: 'dirt' },
    hardness: 0.6,
    tool: 'shovel',
    material: 'earth',
    drops: [{ item: 'dirt' }],
  }),
  glow_lamp: reg({ name: 'glow_lamp', light: 15, hardness: 0.3, material: 'glass' }),
  green_wool: reg(wool('green')),
  black_wool: reg(wool('black')),
  mossy_cobblestone: reg({ name: 'mossy_cobblestone', hardness: 2, tool: 'pickaxe', harvestTier: 1 }),
} as const;

export type BuiltinBlockName = keyof typeof BLOCK;

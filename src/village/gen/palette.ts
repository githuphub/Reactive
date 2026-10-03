/**
 * Material palettes for Oakhollow. Plains villages are timber and brick; desert villages swap to
 * sandstone. Only built-in blocks are used, so gen workers and the main thread agree on ids.
 */
import { BLOCK } from '../../engine/blocks';

export interface Palette {
  /** Ground cover outside paths (grass or sand). */
  ground: number;
  /** Dirt-like fill under foundations. */
  fill: number;
  foundation: number;
  wall: number;
  /** Corner posts and beams. */
  frame: number;
  beam: number;
  roof: number;
  ridge: number;
  floor: number;
  path: number;
  pathEdge: number;
  plaza: number;
  plazaAccent: number;
  stone: number;
  tower: number;
  towerAccent: number;
}

export const PLAINS: Palette = {
  ground: BLOCK.grass,
  fill: BLOCK.dirt,
  foundation: BLOCK.cobblestone,
  wall: BLOCK.oak_planks,
  frame: BLOCK.oak_log,
  beam: BLOCK.spruce_log,
  roof: BLOCK.bricks,
  ridge: BLOCK.spruce_planks,
  floor: BLOCK.spruce_planks,
  path: BLOCK.dirt_path,
  pathEdge: BLOCK.gravel,
  plaza: BLOCK.cobblestone,
  plazaAccent: BLOCK.stone_bricks,
  stone: BLOCK.stone_bricks,
  tower: BLOCK.stone_bricks,
  towerAccent: BLOCK.mossy_cobblestone,
};

export const DESERT: Palette = {
  ground: BLOCK.sand,
  fill: BLOCK.sandstone,
  foundation: BLOCK.sandstone,
  wall: BLOCK.sandstone,
  frame: BLOCK.birch_log,
  beam: BLOCK.spruce_log,
  roof: BLOCK.birch_planks,
  ridge: BLOCK.spruce_planks,
  floor: BLOCK.birch_planks,
  path: BLOCK.gravel,
  pathEdge: BLOCK.sandstone,
  plaza: BLOCK.sandstone,
  plazaAccent: BLOCK.stone_bricks,
  stone: BLOCK.sandstone,
  tower: BLOCK.sandstone,
  towerAccent: BLOCK.stone_bricks,
};

/** Variation knobs a layout rolls per building (deterministic from the seed). */
export interface BuildingStyle extends Palette {
  /** 0..1 roll for small cosmetic choices. */
  variant: number;
}

/** Derives a building style from the village palette and a roll. */
export function styleFor(base: Palette, roll: number, desert: boolean): BuildingStyle {
  const s: BuildingStyle = { ...base, variant: roll };
  if (desert) return s;
  if (roll < 0.33) s.roof = BLOCK.bricks;
  else if (roll < 0.66) {
    s.roof = BLOCK.spruce_planks;
    s.ridge = BLOCK.spruce_log;
  } else {
    s.roof = BLOCK.bricks;
    s.wall = BLOCK.birch_planks;
    s.ridge = BLOCK.oak_planks;
  }
  return s;
}

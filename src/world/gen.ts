/**
 * Chunk generation (runs inside the gen worker). Pipeline per chunk:
 * terrain columns → caves → ores → trees → plants → extra passes (villages) → saved diffs → light.
 *
 * Extra passes are discovered automatically: any `src/<folder>/gen-pass.ts` whose default export
 * is a {@link GenPass} runs after the built-in passes, ordered by `order` (V2: `village/gen-pass.ts`).
 */
import { BLOCK } from '../engine/blocks';
import { CHUNK_HEIGHT, CHUNK_VOLUME, ID_MASK, SEA_LEVEL, chunkIndex, packBlock } from '../engine/constants';
import { lightChunkLocal } from '../engine/light';
import { hash01, hash4, mulberry32 } from '../engine/random';
import { BIOME, type BiomeId } from './biomes';
import { terrainFor, trilerp, type ColumnSample, type Terrain, type VillageSite } from './terrain';
import { TREE_CELL, drawTree, treeInCell, type BlockWriter } from './trees';

/** Everything a generation pass may use. Coordinates are world coordinates. */
export interface GenContext {
  readonly seed: number;
  readonly cx: number;
  readonly cz: number;
  /** World x/z of the chunk's (0, 0) column. */
  readonly x0: number;
  readonly z0: number;
  readonly terrain: Terrain;
  /** The reserved village site for this seed (null if none was found). */
  readonly site: VillageSite | null;
  /** Raw packed block array of this chunk (index with `chunkIndex(lx, y, lz)`). */
  readonly blocks: Uint16Array;
  /** Per-column biome ids of this chunk (index `lx + lz * 16`). */
  readonly biomes: Uint8Array;
  /** True if world column (x, z) lies in this chunk. */
  inChunk(x: number, z: number): boolean;
  /** Block type id at a world position (air outside this chunk). */
  get(x: number, y: number, z: number): number;
  /** Writes a block if it lies in this chunk (ignored otherwise, so structures can be drawn whole). */
  set(x: number, y: number, z: number, id: number, meta?: number): void;
  /** Highest non-air y in a column of this chunk (or -1). Out-of-chunk: terrain height. */
  surfaceY(x: number, z: number): number;
  /** Deterministic RNG for this chunk and a salt. */
  rng(salt: number): () => number;
}

/** A generation pass contributed by another module (see file header). */
export interface GenPass {
  name: string;
  /** Lower runs first. Default 100. */
  order?: number;
  run(ctx: GenContext): void;
}

const discovered = import.meta.glob<{ default?: GenPass }>('../*/gen-pass.ts', { eager: true });
const extraPasses: GenPass[] = Object.values(discovered)
  .map((m) => m.default)
  .filter((p): p is GenPass => !!p && typeof p.run === 'function')
  .sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

/** Registers a pass at runtime (inside the worker). Prefer the `gen-pass.ts` convention. */
export function addGenPass(pass: GenPass): void {
  extraPasses.push(pass);
  extraPasses.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

export interface GeneratedChunk {
  blocks: Uint16Array;
  light: Uint8Array;
  biomes: Uint8Array;
}

/**
 * Generates one chunk. `diffs` holds saved edits as [index, raw, index, raw, ...] and is
 * applied before lighting.
 */
export function generateChunk(seed: number, cx: number, cz: number, diffs?: Uint32Array): GeneratedChunk {
  const terrain = terrainFor(seed);
  const blocks = new Uint16Array(CHUNK_VOLUME);
  const light = new Uint8Array(CHUNK_VOLUME);
  const biomes = new Uint8Array(256);
  const x0 = cx * 16;
  const z0 = cz * 16;

  // 1. Column samples with a 1-block border for slopes.
  const cols: ColumnSample[] = new Array(18 * 18);
  for (let z = -1; z <= 16; z++) for (let x = -1; x <= 16; x++) cols[(z + 1) * 18 + (x + 1)] = terrain.column(x0 + x, z0 + z);
  const col = (x: number, z: number) => cols[(z + 1) * 18 + (x + 1)];

  // 2. Cave lattice (every 4 blocks).
  const LX = 5, LY = CHUNK_HEIGHT / 4 + 1;
  const lattice = new Float32Array(LX * LY * LX);
  for (let ly = 0; ly < LY; ly++)
    for (let lz = 0; lz < LX; lz++)
      for (let lx = 0; lx < LX; lx++) lattice[(ly * LX + lz) * LX + lx] = terrain.caveLattice(x0 + lx * 4, ly * 4, z0 + lz * 4);
  const caveAt = (x: number, y: number, z: number): number => {
    const lx = x >> 2, ly = y >> 2, lz = z >> 2;
    const tx = (x & 3) / 4, ty = (y & 3) / 4, tz = (z & 3) / 4;
    const i = (ly * LX + lz) * LX + lx;
    const s = LX, sl = LX * LX;
    return trilerp(
      lattice[i], lattice[i + 1], lattice[i + sl], lattice[i + sl + 1],
      lattice[i + s], lattice[i + s + 1], lattice[i + sl + s], lattice[i + sl + s + 1],
      tx, ty, tz,
    );
  };

  // 3. Terrain fill + caves.
  for (let z = 0; z < 16; z++)
    for (let x = 0; x < 16; x++) {
      const c = col(x, z);
      const h = c.height;
      const wx = x0 + x, wz = z0 + z;
      biomes[x + z * 16] = c.biome;
      const slope = Math.max(
        Math.abs(h - col(x - 1, z).height), Math.abs(h - col(x + 1, z).height),
        Math.abs(h - col(x, z - 1).height), Math.abs(h - col(x, z + 1).height),
      );
      const top = Math.max(h, SEA_LEVEL);
      const opening = terrain.surfaceOpening(wx, wz);
      for (let y = 0; y <= top; y++) {
        let id: number;
        if (y === 0) id = BLOCK.bedrock;
        else if (y <= 3 && hash01(seed ^ 0xbed, wx, wz, y) < 0.6 - y * 0.15) id = BLOCK.bedrock;
        else if (y > h) id = y === SEA_LEVEL && c.biome === BIOME.snowy_taiga ? BLOCK.ice : BLOCK.water;
        else id = surfaceBlock(terrain, c.biome, h, y, slope, wx, wz);
        if (id !== BLOCK.bedrock && id !== BLOCK.water && id !== BLOCK.ice && terrain.caveAllowed(wx, y, wz, h)) {
          if ((y < h - 3 || opening) && caveAt(x, y, z) > 0) id = y <= 10 ? BLOCK.lava : BLOCK.air;
        }
        blocks[chunkIndex(x, y, z)] = id;
      }
    }

  // 4. Ores and underground pockets.
  placeOres(blocks, mulberry32(hash4(seed, cx, cz, 0x0e5)));

  const writer: BlockWriter = {
    get: (x, y, z) => (inChunk(x, z) && y >= 0 && y < CHUNK_HEIGHT ? blocks[chunkIndex(x - x0, y, z - z0)] & ID_MASK : 0),
    set: (x, y, z, id) => {
      if (inChunk(x, z) && y >= 0 && y < CHUNK_HEIGHT) blocks[chunkIndex(x - x0, y, z - z0)] = id;
    },
  };
  function inChunk(x: number, z: number): boolean {
    return x >= x0 && x < x0 + 16 && z >= z0 && z < z0 + 16;
  }

  // 5. Trees from every grid cell whose tree could reach into this chunk.
  const reach = 3;
  const gx0 = Math.floor((x0 - reach) / TREE_CELL), gx1 = Math.floor((x0 + 15 + reach) / TREE_CELL);
  const gz0 = Math.floor((z0 - reach) / TREE_CELL), gz1 = Math.floor((z0 + 15 + reach) / TREE_CELL);
  for (let gz = gz0; gz <= gz1; gz++)
    for (let gx = gx0; gx <= gx1; gx++) {
      const tree = treeInCell(terrain, gx, gz);
      if (tree) drawTree(writer, tree);
    }

  // 6. Ground plants.
  for (let z = 0; z < 16; z++)
    for (let x = 0; x < 16; x++) {
      const c = col(x, z);
      const h = c.height;
      if (h + 1 >= CHUNK_HEIGHT || h < SEA_LEVEL) continue;
      const below = blocks[chunkIndex(x, h, z)] & ID_MASK;
      if ((blocks[chunkIndex(x, h + 1, z)] & ID_MASK) !== BLOCK.air) continue;
      const wx = x0 + x, wz = z0 + z;
      const r = hash01(seed ^ 0xf10a, wx, wz);
      let plant = 0;
      if (below === BLOCK.grass) {
        const grassP = c.biome === BIOME.plains ? 0.16 : c.biome === BIOME.forest ? 0.07 : 0.05;
        const flowerP = c.biome === BIOME.plains ? 0.018 : 0.008;
        if (r < flowerP) plant = terrain.patchNoise(wx, wz, 40) > 0 ? BLOCK.red_flower : BLOCK.yellow_flower;
        else if (r < flowerP + 0.0015) plant = BLOCK.pumpkin;
        else if (r < flowerP + 0.0015 + grassP) plant = BLOCK.tall_grass;
      } else if (below === BLOCK.sand && c.biome === BIOME.desert && r < 0.008) plant = BLOCK.dead_bush;
      if (plant) blocks[chunkIndex(x, h + 1, z)] = plant === BLOCK.pumpkin ? packBlock(plant, Math.floor(r * 4000) & 3) : plant;
    }

  // 7. Extra passes (villages, ...).
  if (extraPasses.length) {
    const ctx: GenContext = {
      seed, cx, cz, x0, z0, terrain, site: terrain.villageSite(), blocks, biomes,
      inChunk,
      get: writer.get,
      set: (x, y, z, id, meta = 0) => {
        if (inChunk(x, z) && y >= 0 && y < CHUNK_HEIGHT) blocks[chunkIndex(x - x0, y, z - z0)] = packBlock(id, meta);
      },
      surfaceY: (x, z) => {
        if (!inChunk(x, z)) return terrain.heightAt(x, z);
        for (let y = CHUNK_HEIGHT - 1; y >= 0; y--) if ((blocks[chunkIndex(x - x0, y, z - z0)] & ID_MASK) !== 0) return y;
        return -1;
      },
      rng: (salt) => mulberry32(hash4(seed, cx, cz, salt)),
    };
    for (const pass of extraPasses) {
      try {
        pass.run(ctx);
      } catch (err) {
        console.error(`[gen] pass "${pass.name}" failed for chunk ${cx},${cz}`, err);
      }
    }
  }

  // 8. Saved edits.
  if (diffs) for (let i = 0; i + 1 < diffs.length; i += 2) blocks[diffs[i]] = diffs[i + 1];

  // 9. Light.
  lightChunkLocal(blocks, light);
  return { blocks, light, biomes };
}

function surfaceBlock(t: Terrain, biome: BiomeId, h: number, y: number, slope: number, x: number, z: number): number {
  const d = h - y;
  if (h < SEA_LEVEL) {
    if (d > 2) return BLOCK.stone;
    const p = t.patchNoise(x, z, 18);
    if (p > 0.45) return BLOCK.clay;
    return h < SEA_LEVEL - 5 && p < -0.2 ? BLOCK.gravel : BLOCK.sand;
  }
  switch (biome) {
    case BIOME.desert:
      return d <= 3 ? BLOCK.sand : d <= 6 ? BLOCK.sandstone : BLOCK.stone;
    case BIOME.beach:
      return d <= 3 ? BLOCK.sand : d <= 5 ? BLOCK.sandstone : BLOCK.stone;
    case BIOME.snowy_taiga:
      return d === 0 ? BLOCK.snowy_grass : d <= 3 ? BLOCK.dirt : BLOCK.stone;
    case BIOME.mountains:
      if (h > 98 + (slope > 2 ? 4 : 0)) return d === 0 ? BLOCK.snow : BLOCK.stone;
      if (slope >= 3 || h > 92) return d === 0 && t.patchNoise(x, z, 8) > 0.5 ? BLOCK.gravel : BLOCK.stone;
      return d === 0 ? BLOCK.grass : d <= 2 ? BLOCK.dirt : BLOCK.stone;
    default:
      return d === 0 ? BLOCK.grass : d <= 3 ? BLOCK.dirt : BLOCK.stone;
  }
}

/** [block, veins per chunk, min y, max y, vein size]. */
const ORES: [number, number, number, number, number][] = [
  [BLOCK.coal_ore, 18, 5, 110, 10],
  [BLOCK.iron_ore, 12, 5, 64, 7],
  [BLOCK.gold_ore, 2.5, 5, 32, 6],
  [BLOCK.redstone_ore, 5, 5, 16, 6],
  [BLOCK.diamond_ore, 1.2, 5, 15, 5],
  [BLOCK.gravel, 5, 5, 90, 18],
  [BLOCK.dirt, 6, 5, 90, 18],
];

function placeOres(blocks: Uint16Array, rng: () => number): void {
  for (const [ore, veins, minY, maxY, size] of ORES) {
    let count = Math.floor(veins) + (rng() < veins % 1 ? 1 : 0);
    while (count-- > 0) {
      let x = 1 + Math.floor(rng() * 14);
      let y = minY + Math.floor(rng() * (maxY - minY));
      let z = 1 + Math.floor(rng() * 14);
      for (let s = 0; s < size; s++) {
        if (x >= 0 && x < 16 && z >= 0 && z < 16 && y > 0 && y < CHUNK_HEIGHT) {
          const i = chunkIndex(x, y, z);
          if ((blocks[i] & ID_MASK) === BLOCK.stone) blocks[i] = ore;
        }
        const dir = Math.floor(rng() * 6);
        if (dir === 0) x++;
        else if (dir === 1) x--;
        else if (dir === 2) y++;
        else if (dir === 3) y--;
        else if (dir === 4) z++;
        else z--;
      }
    }
  }
}


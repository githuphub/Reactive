/**
 * Pure, deterministic terrain functions for one seed. Shared by the gen worker (to build chunks)
 * and the main thread (spawn, village site, queries about unloaded terrain).
 */
import { SEA_LEVEL } from '../engine/constants';
import { hash01 } from '../engine/random';
import { BIOME, type BiomeId } from './biomes';
import { Simplex, fbm2, smoothstep } from './noise';

/** A reserved, flattened area for a village (see V2's `village/gen-pass.ts`). */
export interface VillageSite {
  /** Centre column. */
  x: number;
  z: number;
  /** Ground level: the top solid block is at y - 1, players stand at y. */
  y: number;
  /** Flattened radius in blocks (fully flat inside radius - 10). */
  radius: number;
  /** BIOME id of the site (plains or desert). */
  biome: BiomeId;
  /** Suggested player spawn column, just inside the site's edge. */
  spawn: { x: number; z: number };
}

export interface ColumnSample {
  /** y of the top solid terrain block (before caves and structures). */
  height: number;
  biome: BiomeId;
  /** 0..1, how mountainous. */
  mountain: number;
}

const CAVE_STEP = 4;

export class Terrain {
  readonly seed: number;
  private readonly cont: Simplex;
  private readonly eros: Simplex;
  private readonly detail: Simplex;
  private readonly ridge: Simplex;
  private readonly temp: Simplex;
  private readonly humid: Simplex;
  private readonly cave1: Simplex;
  private readonly cave2: Simplex;
  private readonly cheese: Simplex;
  private readonly patch: Simplex;
  private siteCache: VillageSite | null | undefined;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    const s = this.seed;
    this.cont = new Simplex(s ^ 0x1001);
    this.eros = new Simplex(s ^ 0x2002);
    this.detail = new Simplex(s ^ 0x3003);
    this.ridge = new Simplex(s ^ 0x4004);
    this.temp = new Simplex(s ^ 0x5005);
    this.humid = new Simplex(s ^ 0x6006);
    this.cave1 = new Simplex(s ^ 0x7007);
    this.cave2 = new Simplex(s ^ 0x8008);
    this.cheese = new Simplex(s ^ 0x9009);
    this.patch = new Simplex(s ^ 0xa00a);
  }

  /** Terrain without the village flatten (used to find the site itself). */
  rawColumn(x: number, z: number): ColumnSample {
    const c = fbm2(this.cont, x / 520, z / 520, 4);
    const e = fbm2(this.eros, x / 300, z / 300, 3);
    const d = fbm2(this.detail, x / 70, z / 70, 4);
    const r = 1 - Math.abs(fbm2(this.ridge, x / 180, z / 180, 4));
    const mountain = smoothstep(0.12, 0.5, e) * smoothstep(-0.25, 0.1, c);
    const base = 66 + c * 20 + d * 4.5;
    let height = base + mountain * (r * r * 42 + 6);
    height = Math.max(4, Math.min(118, Math.round(height)));
    const t = fbm2(this.temp, x / 380, z / 380, 3);
    const h = fbm2(this.humid, x / 320, z / 320, 3);
    let biome: BiomeId;
    if (height < SEA_LEVEL) biome = BIOME.lake;
    else if (mountain > 0.45 && height > 80) biome = BIOME.mountains;
    else if (t > 0.2 && h < 0.05) biome = BIOME.desert;
    else if (t < -0.22) biome = BIOME.snowy_taiga;
    else if (height <= SEA_LEVEL + 2 && c < 0.05) biome = BIOME.beach;
    else if (h > 0.05) biome = BIOME.forest;
    else biome = BIOME.plains;
    return { height, biome, mountain };
  }

  /** Final terrain column, including the village-site flatten. */
  column(x: number, z: number): ColumnSample {
    const raw = this.rawColumn(x, z);
    const site = this.villageSite();
    if (!site) return raw;
    const w = this.flattenWeight(x, z);
    if (w <= 0) return raw;
    const height = Math.round(raw.height + (site.y - 1 - raw.height) * w);
    return { height, biome: w > 0.35 ? site.biome : raw.biome, mountain: raw.mountain * (1 - w) };
  }

  heightAt(x: number, z: number): number {
    return this.column(x, z).height;
  }

  biomeAt(x: number, z: number): BiomeId {
    return this.column(x, z).biome;
  }

  /** 0..1: how strongly the village site flattens this column (1 inside, 0 outside). */
  flattenWeight(x: number, z: number): number {
    const site = this.villageSite();
    if (!site) return 0;
    const d = Math.hypot(x - site.x, z - site.z);
    const inner = site.radius - 10;
    if (d <= inner) return 1;
    if (d >= site.radius) return 0;
    return 1 - smoothstep(inner, site.radius, d);
  }

  /** The village site for this seed (computed once). */
  villageSite(): VillageSite | null {
    if (this.siteCache === undefined) this.siteCache = findVillageSiteFor(this);
    return this.siteCache;
  }

  /** Low-frequency 2D noise in -1..1 for surface patches (clay, gravel, flowers). */
  patchNoise(x: number, z: number, scale = 24): number {
    return this.patch.noise2(x / scale, z / scale);
  }

  /**
   * Cave carve density at a lattice point: > 0 means air. Sampled every 4 blocks and
   * trilinearly interpolated by {@link Terrain.isCave} so chunk gen and point queries agree.
   */
  caveLattice(x: number, y: number, z: number): number {
    const a = this.cave1.noise3(x / 64, y / 36, z / 64);
    const b = this.cave2.noise3(x / 64, y / 36, z / 64);
    const worm = 0.0055 - (a * a + b * b);
    const ch = this.cheese.noise3(x / 52, y / 26, z / 52) - 0.6 + (y < 30 ? 0.06 : 0);
    return Math.max(worm * 40, ch);
  }

  /** Interpolated cave density at any block (see {@link Terrain.caveLattice}). */
  caveDensity(x: number, y: number, z: number): number {
    const x0 = Math.floor(x / CAVE_STEP) * CAVE_STEP;
    const y0 = Math.floor(y / CAVE_STEP) * CAVE_STEP;
    const z0 = Math.floor(z / CAVE_STEP) * CAVE_STEP;
    const tx = (x - x0) / CAVE_STEP;
    const ty = (y - y0) / CAVE_STEP;
    const tz = (z - z0) / CAVE_STEP;
    const s = CAVE_STEP;
    const c000 = this.caveLattice(x0, y0, z0);
    const c100 = this.caveLattice(x0 + s, y0, z0);
    const c010 = this.caveLattice(x0, y0 + s, z0);
    const c110 = this.caveLattice(x0 + s, y0 + s, z0);
    const c001 = this.caveLattice(x0, y0, z0 + s);
    const c101 = this.caveLattice(x0 + s, y0, z0 + s);
    const c011 = this.caveLattice(x0, y0 + s, z0 + s);
    const c111 = this.caveLattice(x0 + s, y0 + s, z0 + s);
    return trilerp(c000, c100, c010, c110, c001, c101, c011, c111, tx, ty, tz);
  }

  /** Whether caves may carve this cell given the column's surface height. */
  caveAllowed(x: number, y: number, z: number, surface: number): boolean {
    if (y < 1) return false;
    if (surface < SEA_LEVEL + 2) return y < surface - 6;
    if (this.flattenWeight(x, z) > 0) return y < surface - 6;
    return y <= surface;
  }

  isCave(x: number, y: number, z: number, surface = this.heightAt(x, z)): boolean {
    return this.caveAllowed(x, y, z, surface) && this.caveDensity(x, y, z) > 0 && (y < surface - 3 || this.surfaceOpening(x, z));
  }

  /** Cave mouths reach the surface only in some areas, so the landscape isn't riddled with holes. */
  surfaceOpening(x: number, z: number): boolean {
    return this.patch.noise2(x / 90 + 100, z / 90) > 0.35;
  }

  /** Deterministic 0..1 hash for a world position and salt. */
  hash(x: number, z: number, salt: number): number {
    return hash01(this.seed ^ salt, x, z);
  }
}

export function trilerp(
  c000: number, c100: number, c010: number, c110: number,
  c001: number, c101: number, c011: number, c111: number,
  tx: number, ty: number, tz: number,
): number {
  const c00 = c000 + (c100 - c000) * tx;
  const c10 = c010 + (c110 - c010) * tx;
  const c01 = c001 + (c101 - c001) * tx;
  const c11 = c011 + (c111 - c011) * tx;
  const c0 = c00 + (c10 - c00) * ty;
  const c1 = c01 + (c11 - c01) * ty;
  return c0 + (c1 - c0) * tz;
}

export const VILLAGE_RADIUS = 44;

function findVillageSiteFor(t: Terrain): VillageSite | null {
  const step = 48;
  // Spiral search outward from the origin for a flat, dry plains/desert area.
  for (let ring = 0; ring <= 24; ring++) {
    for (let i = -ring; i <= ring; i++) {
      for (const [gx, gz] of ring === 0 ? [[0, 0]] : [[i, -ring], [i, ring], [-ring, i], [ring, i]]) {
        const x = gx * step;
        const z = gz * step;
        const c = t.rawColumn(x, z);
        if (c.biome !== BIOME.plains && c.biome !== BIOME.desert) continue;
        if (c.height < SEA_LEVEL + 2 || c.height > 80) continue;
        let min = c.height, max = c.height, sum = 0, n = 0, ok = true;
        for (let a = 0; a < 16 && ok; a++) {
          const ang = (a / 16) * Math.PI * 2;
          for (const r of [14, 28, 40]) {
            const s = t.rawColumn(x + Math.cos(ang) * r, z + Math.sin(ang) * r);
            if (s.height < SEA_LEVEL + 1) ok = false;
            min = Math.min(min, s.height);
            max = Math.max(max, s.height);
            sum += s.height;
            n++;
          }
        }
        if (!ok || max - min > 10) continue;
        const y = Math.round(sum / n) + 1;
        return { x, z, y, radius: VILLAGE_RADIUS, biome: c.biome, spawn: { x: x + VILLAGE_RADIUS - 14, z: z + 3 } };
      }
    }
  }
  return null;
}

const terrains = new Map<number, Terrain>();

/** Cached {@link Terrain} for a seed. */
export function terrainFor(seed: number): Terrain {
  let t = terrains.get(seed >>> 0);
  if (!t) {
    t = new Terrain(seed);
    terrains.set(seed >>> 0, t);
  }
  return t;
}

/**
 * Finds the reserved village site for a seed: a flat-ish dry plains or desert area near the
 * origin. Deterministic; returns null only if no candidate exists within ~1.1 km.
 */
export function findVillageSite(seed: number): VillageSite | null {
  return terrainFor(seed).villageSite();
}

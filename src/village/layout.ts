/**
 * Oakhollow layout: a pure, deterministic function of `(seed, site)`.
 *
 * The gen worker uses it to stamp blocks and the main thread uses it for ownership regions,
 * villager homes and work spots, posts, Bram's plot and repair snapshots, so both always agree.
 *
 * Frame: the plaza centre O sits 3 blocks south of the site centre, so the player's spawn column
 * (`site.spawn`, 30 blocks east of O) lands on the main east-west road. Everything stays inside the
 * fully flattened radius (site radius − 10).
 */
import { hash01, hash4, mulberry32 } from '../engine/random';
import { BIOME } from '../world/biomes';
import type { VillageSite } from '../world/terrain';
import { Local, type Facing, type VoxelSink, type WorldPos } from './gen/local';
import { DESERT, PLAINS, styleFor, type BuildingStyle, type Palette } from './gen/palette';
import { drawTemplate, type BuildingKind, type LPos, type TemplateAnchors } from './gen/templates';
import type { Rect } from './gen/decor';

export type { Rect } from './gen/decor';
export type { BuildingKind } from './gen/templates';
export type { Facing, WorldPos } from './gen/local';

export interface BuildingSpec {
  id: string;
  /** Villager id of the owner. */
  owner: string;
  kind: BuildingKind;
  name: string;
  /** World min corner of the rotated footprint. */
  x0: number;
  z0: number;
  /** Local width/depth (see gen/local.ts). */
  w: number;
  d: number;
  /** World facing of the front/door. */
  facing: Facing;
  style: BuildingStyle;
}

export interface FarmSpec {
  id: string;
  owner: string;
  rect: Rect;
  scarecrow: boolean;
}

export interface PlotSpec {
  id: string;
  owner: string;
  /** The buildable area (inclusive). */
  rect: Rect;
  sign: { x: number; z: number };
}

export interface LampSpec {
  x: number;
  z: number;
  glow: boolean;
}

/** A generic villager rolled from the seed. */
export interface GenericVillagerSpec {
  id: string;
  name: string;
  home: string;
  work: 'farm' | 'yard' | 'library' | 'plaza';
  robe: number;
}

export interface VillageLayout {
  seed: number;
  site: VillageSite;
  desert: boolean;
  pal: Palette;
  /** Plaza centre (world x/z). */
  ox: number;
  oz: number;
  /** y of the ground block layer (top solid block); villagers stand at y0 + 1. */
  y0: number;
  plaza: Rect;
  roads: Rect[];
  paths: Rect[];
  well: { x: number; z: number };
  bell: { x: number; z: number };
  board: { x: number; z: number };
  gate: { x: number; z0: number; z1: number };
  lamps: LampSpec[];
  greens: Rect[];
  gardens: Rect[];
  buildings: BuildingSpec[];
  farms: FarmSpec[];
  plot: PlotSpec;
  generics: GenericVillagerSpec[];
  /** Named stand spots (world, feet y). */
  posts: Record<string, WorldPos>;
  /** Everything the stamp touches. */
  bounds: Rect;
}

const GENERIC_NAMES = ['Tobin', 'Wren', 'Elsie', 'Corin', 'Fenn', 'Isla', 'Odo', 'Nell', 'Bryn', 'Hal', 'Mabel', 'Tamsin', 'Ivo', 'Rosalind'];

/** Building placements relative to O: [id, owner, kind, dx0, dz0, w, d, facing, name]. */
type Placement = [string, string, BuildingKind, number, number, number, number, Facing, string];

const PLACEMENTS: Placement[] = [
  ['bram_house', 'bram', 'small_house', -26, -23, 7, 7, 2, "Bram's house"],
  ['house_a', 'villager_1', 'small_house', -15, -24, 7, 8, 2, 'Timber house'],
  ['builders_yard', 'bram', 'yard', -32, -12, 10, 8, 1, "Bram's builder's yard"],
  ['smithy', 'hilde', 'smithy', 7, -11, 9, 7, 2, "Hilde's smithy"],
  ['hilde_house', 'hilde', 'large_house', 18, -14, 9, 9, 2, "Hilde's house"],
  ['library', 'pip', 'library', 4, -27, 11, 9, 2, "Pip's library"],
  ['mara_house', 'mara', 'cosy_house', -13, 4, 7, 6, 0, "Mara's house"],
  ['farm_hut', 'mara', 'farm_hut', -12, 13, 5, 5, 3, "Mara's farm hut"],
  ['house_b', 'villager_3', 'small_house', 7, 4, 7, 7, 0, 'Brick cottage'],
  ['guard_tower', 'rowan', 'tower', 21, 4, 5, 5, 0, 'Guard tower'],
];

const layouts = new Map<number, VillageLayout>();

/** The (cached) layout for a seed and its village site. */
export function planVillage(seed: number, site: VillageSite): VillageLayout {
  const key = seed >>> 0;
  let l = layouts.get(key);
  if (!l) {
    l = buildLayout(key, site);
    layouts.set(key, l);
  }
  return l;
}

function buildLayout(seed: number, site: VillageSite): VillageLayout {
  const desert = site.biome === BIOME.desert;
  const pal = desert ? DESERT : PLAINS;
  const ox = site.x, oz = site.z + 3;
  const y0 = site.y - 1;
  const R = (x0: number, z0: number, x1: number, z1: number): Rect => ({ x0: ox + x0, z0: oz + z0, x1: ox + x1, z1: oz + z1 });

  const plaza = R(-5, -5, 5, 5);
  const roads = [
    R(-31, -1, 31, 1),
    R(-1, -16, 1, 14),
    R(-27, -15, -2, -15),
    R(2, -15, 20, -15),
    R(-15, 2, -15, 20),
  ];

  // Generic villagers (3–4) with names and robes from the seed.
  const rng = mulberry32(hash4(seed, 0x0a11, 0x7e));
  const names = [...GENERIC_NAMES];
  const generics: GenericVillagerSpec[] = [];
  const count = rng() < 0.5 ? 3 : 4;
  const plan: [string, GenericVillagerSpec['work']][] = [['house_a', 'farm'], ['house_a', 'yard'], ['house_b', 'library'], ['hilde_house', 'plaza']];
  for (let i = 0; i < count; i++) {
    const name = names.splice(Math.floor(rng() * names.length), 1)[0];
    generics.push({ id: `villager_${i + 1}`, name, home: plan[i][0], work: plan[i][1], robe: Math.floor(rng() * 6) });
  }

  const buildings: BuildingSpec[] = PLACEMENTS.map(([id, owner, kind, dx, dz, w, d, facing, name], i) => {
    const roll = hash01(seed ^ 0xb11d, i, 7);
    const style = styleFor(pal, roll, desert);
    let label = name;
    if (owner.startsWith('villager_')) {
      const g = generics.find((v) => v.id === owner);
      if (g) label = `${g.name}'s house`;
    }
    return { id, owner, kind, name: label, x0: ox + dx, z0: oz + dz, w, d, facing, style };
  });

  const farms: FarmSpec[] = [
    { id: 'farm_north', owner: 'mara', rect: R(-24, 4, -16, 10), scarecrow: true },
    { id: 'farm_south', owner: 'mara', rect: R(-24, 13, -16, 19), scarecrow: false },
  ];
  const plot: PlotSpec = { id: 'bram_plot', owner: 'bram', rect: R(-22, -13, -9, -4), sign: { x: ox - 15, z: oz - 2 } };

  // Paths from each entrance, straight out until a road (stopping at anything solid in the way).
  const blockers: Rect[] = [
    ...buildings.map(footprint),
    ...farms.map((f) => f.rect),
    { x0: plot.rect.x0 - 1, z0: plot.rect.z0 - 1, x1: plot.rect.x1 + 1, z1: plot.rect.z1 + 1 },
  ];
  const inAny = (rs: Rect[], x: number, z: number) => rs.some((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1);
  const paths: Rect[] = [];
  for (const b of buildings) {
    const a = anchorsFor(b, y0);
    const ent = a.entrance;
    const dx = [0, 1, 0, -1][b.facing], dz = [-1, 0, 1, 0][b.facing];
    let x = ent.x, z = ent.z, n = 0;
    while (n < 24 && !inAny(roads, x, z) && !inAny([plaza], x, z)) {
      if (n > 0 && inAny(blockers, x, z)) break;
      x += dx;
      z += dz;
      n++;
    }
    const ex = x - dx, ez = z - dz;
    paths.push({ x0: Math.min(ent.x, ex), z0: Math.min(ent.z, ez), x1: Math.max(ent.x, ex), z1: Math.max(ent.z, ez) });
  }

  const lamps: LampSpec[] = [
    ...[[-5, -5], [5, -5], [-5, 5], [5, 5]].map(([x, z]) => ({ x: ox + x, z: oz + z, glow: true })),
    ...[[-28, 2], [-20, -2], [-12, 2], [12, -2], [19, 2], [2, -10], [-2, 10], [-18, -16], [16, -16], [-14, 12]].map(([x, z]) => ({ x: ox + x, z: oz + z, glow: false })),
  ];

  const posts: Record<string, WorldPos> = {};
  const P = (dx: number, dz: number, dy = 0): WorldPos => ({ x: ox + dx, y: y0 + 1 + dy, z: oz + dz });
  posts.gate = P(26, 0);
  posts.well = P(3, 3);
  posts.plaza = P(-3, 3);
  posts.mara_house = P(-10, 2);
  posts.farm = P(-15, 7);
  posts.bram_plot = P(-14, -2);
  const towerB = buildings.find((b) => b.id === 'guard_tower')!;
  const towerA = anchorsFor(towerB, y0);
  posts.tower = towerA.top ?? towerA.entrance;
  posts.square = posts.plaza;
  posts.walls = posts.gate;

  let bounds: Rect = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity };
  const grow = (r: Rect, m = 0) => {
    bounds = { x0: Math.min(bounds.x0, r.x0 - m), z0: Math.min(bounds.z0, r.z0 - m), x1: Math.max(bounds.x1, r.x1 + m), z1: Math.max(bounds.z1, r.z1 + m) };
  };
  for (const r of roads) grow(r);
  for (const b of buildings) grow(footprint(b), 2);
  for (const f of farms) grow(f.rect, 2);
  grow(plot.rect, 2);
  grow(plaza, 1);

  return {
    seed, site, desert, pal, ox, oz, y0, plaza, roads, paths,
    well: { x: ox - 2, z: oz - 2 },
    bell: { x: ox + 2, z: oz - 4 },
    board: { x: ox - 5, z: oz - 4 },
    gate: { x: ox + 28, z0: oz - 1, z1: oz + 1 },
    lamps,
    greens: [R(15, 5, 19, 11)],
    gardens: [R(-5, 6, -3, 9)],
    buildings, farms, plot, generics, posts, bounds,
  };
}

/** World footprint rect of a building (without the roof overhang). */
export function footprint(b: BuildingSpec): Rect {
  const [sx, sz] = Local.footprint(b.w, b.d, b.facing);
  return { x0: b.x0, z0: b.z0, x1: b.x0 + sx - 1, z1: b.z0 + sz - 1 };
}

/** A local frame for a building writing into `sink`. */
export function localFrame(b: BuildingSpec, y0: number, sink: VoxelSink): Local {
  return new Local(sink, b.x0, y0, b.z0, b.w, b.d, b.facing);
}

const NULL_SINK: VoxelSink = { set() {} };

/** World-space anchors of a building. */
export interface BuildingAnchors {
  door: WorldPos | null;
  entrance: WorldPos;
  beds: { head: WorldPos; foot: WorldPos; stand: WorldPos }[];
  work: { at: WorldPos; look: WorldPos }[];
  piles?: Record<string, { at: WorldPos; look: WorldPos }>;
  top?: WorldPos;
  height: number;
}

const anchorCache = new WeakMap<BuildingSpec, BuildingAnchors>();

/** Anchors of a building in world coordinates (computed by dry-running its template). */
export function anchorsFor(b: BuildingSpec, y0: number): BuildingAnchors {
  let a = anchorCache.get(b);
  if (a) return a;
  const L = localFrame(b, y0, NULL_SINK);
  const t: TemplateAnchors = drawTemplate(b.kind, L, b.style);
  const w = (p: LPos) => L.pos(p[0], p[1], p[2]);
  a = {
    door: t.door ? w(t.door) : null,
    entrance: w(t.entrance),
    beds: t.beds.map((bd) => ({ head: w(bd.head), foot: w(bd.foot), stand: w(bd.stand) })),
    work: t.work.map((s) => ({ at: w(s.at), look: w(s.look) })),
    piles: t.piles ? Object.fromEntries(Object.entries(t.piles).map(([k, s]) => [k, { at: w(s.at), look: w(s.look) }])) : undefined,
    top: t.top ? w(t.top) : undefined,
    height: t.height,
  };
  anchorCache.set(b, a);
  return a;
}

/** Records every block a building's template writes: key "x,y,z" → [id, meta]. */
export function recordBuilding(b: BuildingSpec, y0: number): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  const sink: VoxelSink = { set: (x, y, z, id, meta = 0) => void out.set(`${x},${y},${z}`, [id, meta]) };
  drawTemplate(b.kind, localFrame(b, y0, sink), b.style);
  return out;
}

/**
 * Parametric building templates for Oakhollow, in an original timber-and-brick style.
 *
 * Every template draws in the local frame of {@link Local} (front = local south, ly 0 = ground
 * layer) and returns anchors (door, beds, work spots, material piles) in local coordinates. The
 * same functions run in the gen worker (stamping) and on the main thread (anchors, ownership,
 * the repair snapshot), so they must stay pure and deterministic.
 */
import { BLOCK } from '../../engine/blocks';
import { hash01 } from '../../engine/random';
import { L_EAST, L_NORTH, L_SOUTH, L_WEST, Local } from './local';
import type { BuildingStyle } from './palette';

export type BuildingKind =
  | 'small_house' | 'large_house' | 'cosy_house' | 'smithy' | 'library' | 'farm_hut' | 'tower' | 'yard';

export type LPos = [number, number, number];

/** A stand spot plus the point to face while standing there. */
export interface LSpot {
  at: LPos;
  look: LPos;
}

export interface TemplateAnchors {
  /** Lower half of the front door (null for open fronts). */
  door: LPos | null;
  /** Floor cell just outside the entrance. */
  entrance: LPos;
  /** Bed head blocks with the floor cell to stand on before lying down. */
  beds: { head: LPos; foot: LPos; stand: LPos }[];
  /** Work stand spots. */
  work: LSpot[];
  /** Builder's yard: material → stand spot in front of the pile. */
  piles?: Record<string, LSpot>;
  /** Tower lookout stand spot. */
  top?: LPos;
  /** Highest local y drawn. */
  height: number;
}

/** Local footprint sizes per kind (the layout may pass others). */
export const DEFAULT_SIZE: Record<BuildingKind, [number, number]> = {
  small_house: [7, 7],
  large_house: [9, 9],
  cosy_house: [7, 6],
  smithy: [9, 7],
  library: [11, 9],
  farm_hut: [5, 5],
  tower: [5, 5],
  yard: [10, 8],
};

/** Draws a building and returns its local anchors. */
export function drawTemplate(kind: BuildingKind, L: Local, s: BuildingStyle): TemplateAnchors {
  switch (kind) {
    case 'small_house': return smallHouse(L, s);
    case 'large_house': return largeHouse(L, s);
    case 'cosy_house': return cosyHouse(L, s);
    case 'smithy': return smithy(L, s);
    case 'library': return library(L, s);
    case 'farm_hut': return farmHut(L, s);
    case 'tower': return tower(L, s);
    case 'yard': return yard(L, s);
  }
}

// -- shared pieces -----------------------------------------------------------------------------

/** Clears the footprint plus a 1-block ring up to `height` and lays fill under the foundation. */
function prepare(L: Local, s: BuildingStyle, height: number): void {
  L.fill(-1, 1, -1, L.w, height, L.d, BLOCK.air);
  L.fill(-1, -2, -1, L.w, -1, L.d, s.fill);
}

function isEdge(L: Local, lx: number, lz: number): boolean {
  return lx === 0 || lz === 0 || lx === L.w - 1 || lz === L.d - 1;
}

function isCorner(L: Local, lx: number, lz: number): boolean {
  return (lx === 0 || lx === L.w - 1) && (lz === 0 || lz === L.d - 1);
}

/** Foundation ring + floor at ly 0. */
function base(L: Local, foundation: number, floor: number): void {
  for (let lz = 0; lz < L.d; lz++)
    for (let lx = 0; lx < L.w; lx++) L.set(lx, 0, lz, isEdge(L, lx, lz) ? foundation : floor);
}

/** Perimeter walls from ly0..ly1 with `frame` corners. */
function walls(L: Local, ly0: number, ly1: number, wall: number, frame: number): void {
  for (let ly = ly0; ly <= ly1; ly++)
    for (let lz = 0; lz < L.d; lz++)
      for (let lx = 0; lx < L.w; lx++) {
        if (!isEdge(L, lx, lz)) continue;
        L.set(lx, ly, lz, isCorner(L, lx, lz) ? frame : wall);
      }
}

function ring(L: Local, ly: number, id: number): void {
  for (let lz = 0; lz < L.d; lz++) for (let lx = 0; lx < L.w; lx++) if (isEdge(L, lx, lz)) L.set(lx, ly, lz, id);
}

/**
 * Stepped gable roof whose ridge runs front-to-back (gable triangles on the front and back).
 * Overhangs one block on every side. Returns the ridge ly.
 */
function gableZ(L: Local, ly0: number, roof: number, ridge: number, gable: number): number {
  const { w, d } = L;
  for (let k = 0; ; k++) {
    const ly = ly0 + k;
    const a = -1 + k, b = w - k;
    if (b <= a + 1) {
      for (let lz = -1; lz <= d; lz++) {
        L.set(a, ly, lz, ridge);
        L.set(b, ly, lz, ridge);
      }
      return ly;
    }
    for (let lz = -1; lz <= d; lz++) {
      L.set(a, ly, lz, roof);
      L.set(b, ly, lz, roof);
    }
    for (let lx = a + 1; lx < b; lx++) {
      L.set(lx, ly, 0, gable);
      L.set(lx, ly, d - 1, gable);
    }
  }
}

/** Stepped gable roof whose ridge runs across the width (gable triangles on the sides). */
function gableX(L: Local, ly0: number, roof: number, ridge: number, gable: number): number {
  const { w, d } = L;
  for (let k = 0; ; k++) {
    const ly = ly0 + k;
    const a = -1 + k, b = d - k;
    if (b <= a + 1) {
      for (let lx = -1; lx <= w; lx++) {
        L.set(lx, ly, a, ridge);
        L.set(lx, ly, b, ridge);
      }
      return ly;
    }
    for (let lx = -1; lx <= w; lx++) {
      L.set(lx, ly, a, roof);
      L.set(lx, ly, b, roof);
    }
    for (let lz = a + 1; lz < b; lz++) {
      L.set(0, ly, lz, gable);
      L.set(w - 1, ly, lz, gable);
    }
  }
}

function bed(L: Local, head: LPos, foot: LPos, stand: LPos, quilt: number): TemplateAnchors['beds'][number] {
  L.set(head[0], head[1], head[2], BLOCK.white_wool);
  L.set(foot[0], foot[1], foot[2], quilt);
  return { head, foot, stand };
}

const QUILTS = [BLOCK.red_wool, BLOCK.blue_wool, BLOCK.green_wool, BLOCK.yellow_wool];

function quiltFor(s: BuildingStyle, i = 0): number {
  return QUILTS[(Math.floor(s.variant * 97) + i) % QUILTS.length];
}

/** A planter box with a flower, outside the front wall. */
function planter(L: Local, lx: number, lz: number, flower: number): void {
  L.set(lx, 1, lz, BLOCK.spruce_planks);
  L.set(lx, 2, lz, flower);
}

// -- templates ---------------------------------------------------------------------------------

function smallHouse(L: Local, s: BuildingStyle): TemplateAnchors {
  const { w, d } = L;
  const cx = w >> 1;
  prepare(L, s, 5 + (w >> 1) + 2);
  base(L, s.foundation, s.floor);
  walls(L, 1, 3, s.wall, s.frame);
  ring(L, 4, s.beam);
  // Windows.
  L.set(cx - 2, 2, d - 1, BLOCK.glass);
  L.set(cx + 2, 2, d - 1, BLOCK.glass);
  L.set(cx, 2, 0, BLOCK.glass);
  const rows = d >= 8 ? [2, d - 3] : [d >> 1];
  for (const lz of rows) {
    L.set(0, 2, lz, BLOCK.glass);
    L.set(w - 1, 2, lz, BLOCK.glass);
  }
  gableZ(L, 5, s.roof, s.ridge, s.wall);
  L.set(cx, 6, d - 1, BLOCK.glass);
  L.set(cx, 6, 0, BLOCK.glass);
  L.door(cx, 1, d - 1, L_SOUTH);
  // Interior.
  const beds = [bed(L, [1, 1, 1], [1, 1, 2], [2, 1, 2], quiltFor(s))];
  L.oriented(w - 2, 1, 1, BLOCK.crafting_table, L_SOUTH);
  L.oriented(w - 2, 1, 2, BLOCK.chest, L_WEST);
  L.torch(cx, 3, 1, L_NORTH);
  // Outside: torches by the door, planters under the front windows.
  L.torch(cx - 1, 2, d, L_NORTH);
  L.torch(cx + 1, 2, d, L_NORTH);
  planter(L, cx - 2, d, s.variant < 0.5 ? BLOCK.red_flower : BLOCK.yellow_flower);
  planter(L, cx + 2, d, s.variant < 0.5 ? BLOCK.yellow_flower : BLOCK.red_flower);
  return { door: [cx, 1, d - 1], entrance: [cx, 1, d], beds, work: [], height: 5 + (w >> 1) + 1 };
}

function largeHouse(L: Local, s: BuildingStyle): TemplateAnchors {
  const { w, d } = L;
  const cx = w >> 1, cz = d >> 1;
  const top = 9 + (w >> 1) + 1;
  prepare(L, s, top + 1);
  base(L, s.foundation, s.floor);
  walls(L, 1, 3, s.wall, s.frame);
  ring(L, 4, s.beam);
  L.fill(1, 4, 1, w - 2, 4, d - 2, s.floor);
  // Upper storey: plaster panels in a timber frame.
  const plaster = s.wall === BLOCK.sandstone ? BLOCK.sandstone : BLOCK.white_wool;
  walls(L, 5, 7, plaster, s.frame);
  for (let ly = 5; ly <= 7; ly++) {
    L.set(cx, ly, 0, s.frame);
    L.set(cx, ly, d - 1, s.frame);
    L.set(0, ly, cz, s.frame);
    L.set(w - 1, ly, cz, s.frame);
  }
  ring(L, 8, s.beam);
  // Windows (ground and upper).
  for (const lx of [2, w - 3]) {
    L.set(lx, 2, d - 1, BLOCK.glass);
    L.set(lx, 2, 0, BLOCK.glass);
    L.set(lx, 6, d - 1, BLOCK.glass);
    L.set(lx, 6, 0, BLOCK.glass);
  }
  for (const lz of [2, d - 3]) {
    for (const lx of [0, w - 1]) {
      L.set(lx, 2, lz, BLOCK.glass);
      L.set(lx, 6, lz, BLOCK.glass);
    }
  }
  gableZ(L, 9, s.roof, s.ridge, s.wall === BLOCK.sandstone ? s.wall : plaster);
  L.set(cx, 10, d - 1, BLOCK.glass);
  L.door(cx, 1, d - 1, L_SOUTH);
  // Ladder to the upper floor.
  L.set(w - 2, 4, 1, BLOCK.air);
  for (let ly = 1; ly <= 4; ly++) L.ladder(w - 2, ly, 1, L_NORTH);
  // Ground floor.
  const beds = [
    bed(L, [1, 1, 1], [1, 1, 2], [2, 1, 2], quiltFor(s, 0)),
    bed(L, [3, 1, 1], [3, 1, 2], [4, 1, 3], quiltFor(s, 1)),
  ];
  L.oriented(w - 2, 1, d - 3, BLOCK.crafting_table, L_WEST);
  L.oriented(w - 2, 1, cz, BLOCK.chest, L_WEST);
  L.oriented(1, 1, d - 3, BLOCK.furnace, L_EAST);
  L.torch(cx, 3, 1, L_NORTH);
  // Upper floor.
  L.fill(1, 5, 1, 3, 6, 1, BLOCK.bookshelf);
  L.oriented(1, 5, d - 2, BLOCK.chest, L_EAST);
  L.torch(cx, 7, 1, L_NORTH);
  // Outside.
  L.torch(cx - 1, 2, d, L_NORTH);
  L.torch(cx + 1, 2, d, L_NORTH);
  planter(L, 2, d, BLOCK.red_flower);
  planter(L, w - 3, d, BLOCK.yellow_flower);
  return { door: [cx, 1, d - 1], entrance: [cx, 1, d], beds, work: [], height: top };
}

/** Mara's cottage: Tudor frame, plaster panels, thatched roof, a fireplace chimney. */
function cosyHouse(L: Local, s: BuildingStyle): TemplateAnchors {
  const { w, d } = L;
  const cx = w >> 1;
  const desert = s.wall === BLOCK.sandstone;
  const plaster = desert ? BLOCK.sandstone : BLOCK.white_wool;
  const frame = BLOCK.oak_log;
  const thatch = BLOCK.hay_bale;
  prepare(L, s, 12);
  base(L, s.foundation, BLOCK.oak_planks);
  walls(L, 1, 3, plaster, frame);
  for (let ly = 1; ly <= 3; ly++) {
    L.set(cx - 1, ly, d - 1, frame);
    L.set(cx + 1, ly, d - 1, frame);
    L.set(cx, ly, 0, frame);
  }
  ring(L, 4, frame);
  // Windows: front pair, back pair, wide side windows.
  L.set(1, 2, d - 1, BLOCK.glass);
  L.set(w - 2, 2, d - 1, BLOCK.glass);
  L.set(cx - 1 - 1 < 1 ? 1 : cx - 2, 2, 0, BLOCK.glass);
  L.set(cx + 2 > w - 2 ? w - 2 : cx + 2, 2, 0, BLOCK.glass);
  for (const lx of [0, w - 1]) {
    L.set(lx, 2, 2, BLOCK.glass);
    L.set(lx, 2, 3, BLOCK.glass);
  }
  gableX(L, 5, thatch, thatch, plaster);
  L.set(0, 6, d >> 1, BLOCK.glass);
  L.set(w - 1, 6, d >> 1, BLOCK.glass);
  L.door(cx, 1, d - 1, L_SOUTH);
  // Fireplace and chimney.
  L.oriented(w - 2, 1, 1, BLOCK.furnace, L_SOUTH);
  for (let ly = 2; ly <= 10; ly++) L.set(w - 2, ly, 1, BLOCK.cobblestone);
  L.set(w - 2, 11, 1, BLOCK.mossy_cobblestone);
  // Interior.
  const beds = [bed(L, [1, 1, 1], [1, 1, 2], [2, 1, 2], BLOCK.green_wool)];
  L.oriented(1, 1, d - 2, BLOCK.chest, L_EAST);
  L.oriented(w - 2, 1, d - 2, BLOCK.crafting_table, L_WEST);
  L.set(w - 2, 1, d - 3, BLOCK.hay_bale);
  L.torch(cx, 3, 1, L_NORTH);
  // Outside: flower boxes, torches on the door posts, a hay doormat.
  planter(L, 1, d, BLOCK.red_flower);
  planter(L, w - 2, d, BLOCK.yellow_flower);
  L.torch(cx - 1, 2, d, L_NORTH);
  L.torch(cx + 1, 2, d, L_NORTH);
  L.set(cx, 0, d, BLOCK.hay_bale);
  return { door: [cx, 1, d - 1], entrance: [cx, 1, d], beds, work: [], height: 11 };
}

/** Hilde's smithy: open front, lava forge, furnaces, an iron anvil, brick chimney. */
function smithy(L: Local, s: BuildingStyle): TemplateAnchors {
  const { w, d } = L;
  const cx = w >> 1;
  prepare(L, s, 12);
  base(L, s.foundation, s.stone);
  for (let ly = 1; ly <= 4; ly++) {
    for (let lx = 0; lx < w; lx++) L.set(lx, ly, 0, s.foundation);
    for (let lz = 1; lz <= 3; lz++) {
      L.set(0, ly, lz, s.foundation);
      L.set(w - 1, ly, lz, s.foundation);
    }
    L.set(0, ly, d - 1, s.frame);
    L.set(w - 1, ly, d - 1, s.frame);
  }
  for (let lx = 1; lx < w - 1; lx++) L.set(lx, 4, d - 1, s.beam);
  for (let lz = 4; lz < d - 1; lz++) {
    L.set(0, 4, lz, s.beam);
    L.set(w - 1, 4, lz, s.beam);
  }
  gableX(L, 5, BLOCK.spruce_planks, BLOCK.spruce_log, s.foundation);
  // Lava forge with a stone rim and a brick hood + chimney.
  L.set(1, 1, 1, BLOCK.lava);
  L.set(2, 1, 1, BLOCK.lava);
  L.set(1, 1, 2, s.stone);
  L.set(2, 1, 2, s.stone);
  L.set(3, 1, 1, s.stone);
  L.set(3, 1, 2, s.stone);
  L.set(1, 3, 1, BLOCK.bricks);
  L.set(2, 3, 1, BLOCK.bricks);
  for (let ly = 1; ly <= 11; ly++) L.set(2, ly, 0, BLOCK.bricks);
  // Furnaces, anvil, storage.
  L.oriented(5, 1, 1, BLOCK.furnace, L_SOUTH);
  L.oriented(6, 1, 1, BLOCK.furnace, L_SOUTH);
  L.set(cx, 1, 3, BLOCK.iron_block);
  L.oriented(w - 2, 1, 1, BLOCK.chest, L_SOUTH);
  L.oriented(w - 2, 1, 3, BLOCK.crafting_table, L_WEST);
  // Light.
  L.torch(1, 3, d - 1, L_WEST);
  L.torch(w - 2, 3, d - 1, L_EAST);
  L.torch(cx, 3, 1, L_NORTH);
  return {
    door: null,
    entrance: [cx, 1, d],
    beds: [],
    work: [
      { at: [cx, 1, 4], look: [cx, 1, 3] },
      { at: [5, 1, 2], look: [5, 1, 1] },
      { at: [3, 1, 3], look: [2, 1, 1] },
    ],
    height: 11,
  };
}

/** Pip's library: tall timber hall lined with bookshelves, a carpet aisle and a slate roof. */
function library(L: Local, s: BuildingStyle): TemplateAnchors {
  const { w, d } = L;
  const cx = w >> 1;
  const top = 7 + (w >> 1) + 1;
  prepare(L, s, top + 1);
  base(L, s.stone, s.floor);
  const desert = s.wall === BLOCK.sandstone;
  const frame = desert ? s.frame : BLOCK.spruce_log;
  walls(L, 1, 5, s.wall, frame);
  for (let ly = 1; ly <= 5; ly++) {
    for (const lx of [3, w - 4]) {
      L.set(lx, ly, 0, frame);
      L.set(lx, ly, d - 1, frame);
    }
    L.set(0, ly, d >> 1, frame);
    L.set(w - 1, ly, d >> 1, frame);
  }
  ring(L, 6, frame);
  // Windows: 2x2 on the front, a big 3x3 at the back, clerestory on the sides.
  for (const lx of [1, 2, w - 3, w - 2]) for (const ly of [2, 3]) L.set(lx, ly, d - 1, BLOCK.glass);
  for (let lx = cx - 1; lx <= cx + 1; lx++) for (let ly = 2; ly <= 4; ly++) L.set(lx, ly, 0, BLOCK.glass);
  for (const lz of [2, d - 3]) {
    L.set(0, 4, lz, BLOCK.glass);
    L.set(w - 1, 4, lz, BLOCK.glass);
  }
  L.set(cx, 3, d - 1, BLOCK.glass);
  gableZ(L, 7, desert ? s.roof : BLOCK.stone_bricks, BLOCK.spruce_log, s.wall);
  L.set(cx, 9, d - 1, BLOCK.glass);
  L.set(cx, 9, 0, BLOCK.glass);
  L.door(cx, 1, d - 1, L_SOUTH);
  // Bookshelves along both side walls; a carpet aisle with a floor lamp.
  for (let lz = 1; lz <= d - 2; lz++) {
    if (lz === d - 2) continue;
    for (let ly = 1; ly <= 3; ly++) {
      L.set(1, ly, lz, BLOCK.bookshelf);
      L.set(w - 2, ly, lz, BLOCK.bookshelf);
    }
  }
  for (let lz = 1; lz <= d - 2; lz++) L.set(cx, 0, lz, BLOCK.red_wool);
  L.set(cx, 0, d >> 1, BLOCK.glow_lamp);
  L.oriented(cx - 2, 1, 3, BLOCK.crafting_table, L_EAST);
  L.oriented(cx + 2, 1, 3, BLOCK.crafting_table, L_WEST);
  // Pip sleeps among the books.
  const beds = [bed(L, [w - 3, 1, 1], [w - 3, 1, 2], [w - 4, 1, 2], BLOCK.blue_wool)];
  L.torch(2, 3, 2, L_WEST);
  L.torch(w - 3, 3, d - 3, L_EAST);
  L.torch(cx - 1, 2, d, L_NORTH);
  L.torch(cx + 1, 2, d, L_NORTH);
  return {
    door: [cx, 1, d - 1],
    entrance: [cx, 1, d],
    beds,
    work: [
      { at: [2, 1, 3], look: [1, 2, 3] },
      { at: [w - 3, 1, d - 4], look: [w - 2, 2, d - 4] },
      { at: [cx - 1, 1, 3], look: [cx - 2, 1, 3] },
    ],
    height: top,
  };
}

function farmHut(L: Local, s: BuildingStyle): TemplateAnchors {
  const { w, d } = L;
  const cx = w >> 1;
  prepare(L, s, 9);
  base(L, s.foundation, s.floor);
  walls(L, 1, 3, s.wall, s.frame);
  L.set(0, 2, d >> 1, BLOCK.glass);
  L.set(w - 1, 2, d >> 1, BLOCK.glass);
  L.set(cx, 2, 0, BLOCK.glass);
  gableZ(L, 4, BLOCK.spruce_planks, BLOCK.spruce_log, s.wall);
  L.door(cx, 1, d - 1, L_SOUTH);
  L.oriented(1, 1, 1, BLOCK.chest, L_SOUTH);
  L.oriented(w - 2, 1, 1, BLOCK.crafting_table, L_SOUTH);
  L.set(w - 2, 1, 2, BLOCK.hay_bale);
  L.torch(cx - 1, 2, d, L_NORTH);
  // Hay stacked by the wall.
  L.set(-1, 1, 1, BLOCK.hay_bale);
  L.set(-1, 1, 2, BLOCK.hay_bale);
  L.set(-1, 2, 1, BLOCK.hay_bale);
  return { door: [cx, 1, d - 1], entrance: [cx, 1, d], beds: [], work: [{ at: [cx, 1, 2], look: [1, 1, 1] }], height: 8 };
}

/** Guard tower: stone shaft, ladder, lookout platform with merlons, torches and a banner. */
function tower(L: Local, s: BuildingStyle): TemplateAnchors {
  const { w, d } = L;
  const cx = w >> 1;
  const H = 10;
  prepare(L, s, H + 4);
  base(L, s.foundation, s.foundation);
  for (let ly = 1; ly <= H; ly++)
    for (let lz = 0; lz < d; lz++)
      for (let lx = 0; lx < w; lx++) {
        if (!isEdge(L, lx, lz)) continue;
        const p = L.pos(lx, ly, lz);
        const mossy = hash01(0x70e7, p.x, p.y, p.z) < 0.22;
        L.set(lx, ly, lz, isCorner(L, lx, lz) ? s.foundation : mossy ? s.towerAccent : s.tower);
      }
  L.door(cx, 1, d - 1, L_SOUTH);
  for (const ly of [5, 8]) {
    L.set(0, ly, d >> 1, BLOCK.glass);
    L.set(w - 1, ly, d >> 1, BLOCK.glass);
  }
  L.set(cx, 7, d - 1, BLOCK.glass);
  // Platform, merlons, corner torches.
  L.fill(-1, H + 1, -1, w, H + 1, d, BLOCK.spruce_planks);
  for (let ly = 1; ly <= H + 1; ly++) L.ladder(cx, ly, 1, L_NORTH);
  for (let lz = -1; lz <= d; lz++)
    for (let lx = -1; lx <= w; lx++) {
      const edge = lx === -1 || lz === -1 || lx === w || lz === d;
      if (edge && ((lx + lz) & 1) === 0) L.set(lx, H + 2, lz, s.tower);
    }
  for (const [lx, lz] of [[-1, -1], [w, -1], [-1, d], [w, d]]) L.torch(lx, H + 3, lz);
  // Banner under the front of the platform.
  L.set(cx, H, d, BLOCK.blue_wool);
  L.set(cx, H - 1, d, BLOCK.blue_wool);
  L.set(cx, H - 2, d, BLOCK.white_wool);
  L.torch(cx - 1, 2, d, L_NORTH);
  L.torch(cx + 1, 2, d, L_NORTH);
  // Barracks bunk and chest.
  const beds = [bed(L, [1, 1, 2], [1, 1, 3], [cx, 1, 2], BLOCK.red_wool)];
  L.oriented(w - 2, 1, d - 2, BLOCK.chest, L_WEST);
  return {
    door: [cx, 1, d - 1],
    entrance: [cx, 1, d],
    beds,
    work: [{ at: [cx, H + 2, d - 1], look: [cx, H + 2, d + 6] }],
    top: [cx, H + 2, d - 1],
    height: H + 3,
  };
}

/** Bram's builder's yard: a fenced lot with material piles, a workbench and a chest. Local 10×8. */
function yard(L: Local, s: BuildingStyle): TemplateAnchors {
  const { w, d } = L;
  prepare(L, s, 6);
  for (let lz = 0; lz < d; lz++)
    for (let lx = 0; lx < w; lx++) {
      const p = L.pos(lx, 0, lz);
      L.set(lx, 0, lz, hash01(0x7a2d, p.x, p.z) < 0.45 ? s.pathEdge : s.fill === BLOCK.sandstone ? BLOCK.sand : BLOCK.dirt);
    }
  // Fence: posts every third block, a plank rail between; the front stays open.
  for (let lz = 0; lz < d; lz++)
    for (let lx = 0; lx < w; lx++) {
      const back = lz === 0, side = lx === 0 || lx === w - 1;
      if (!back && !side) continue;
      const post = isCorner(L, lx, lz) || (back ? lx % 3 === 0 : lz % 3 === 0);
      if (lz === d - 1 && !isCorner(L, lx, lz)) continue;
      L.set(lx, 1, lz, post ? s.frame : BLOCK.spruce_planks);
      if (post) L.set(lx, 2, lz, s.frame);
    }
  L.torch(0, 3, d - 1);
  L.torch(w - 1, 3, d - 1);
  // Material piles along the back fence and both sides.
  L.fill(1, 1, 1, 2, 3, 2, BLOCK.oak_planks);
  L.fill(4, 1, 1, 5, 2, 2, BLOCK.cobblestone);
  L.fill(7, 1, 1, 8, 2, 2, BLOCK.bricks);
  L.fill(1, 1, 4, 1, 2, 5, BLOCK.oak_log);
  L.fill(w - 2, 1, 4, w - 2, 2, 4, BLOCK.stone_bricks);
  L.fill(w - 2, 1, 5, w - 2, 2, 5, BLOCK.glass);
  L.oriented(4, 1, d - 3, BLOCK.crafting_table, L_SOUTH);
  L.oriented(5, 1, d - 3, BLOCK.chest, L_SOUTH);
  const spot = (at: LPos, look: LPos): LSpot => ({ at, look });
  const piles: Record<string, LSpot> = {
    oak_planks: spot([2, 1, 3], [2, 2, 2]),
    cobblestone: spot([4, 1, 3], [4, 1, 2]),
    bricks: spot([7, 1, 3], [7, 1, 2]),
    oak_log: spot([2, 1, 5], [1, 1, 5]),
    stone_bricks: spot([w - 3, 1, 4], [w - 2, 1, 4]),
    glass: spot([w - 3, 1, 5], [w - 2, 1, 5]),
    any: spot([4, 1, d - 2], [4, 1, d - 3]),
  };
  return {
    door: null,
    entrance: [w >> 1, 1, d],
    beds: [],
    work: [piles.oak_planks, piles.bricks, piles.any, piles.cobblestone],
    piles,
    height: 3,
  };
}

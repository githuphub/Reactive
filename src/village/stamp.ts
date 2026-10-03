/**
 * Stamps Oakhollow into a generated chunk. Called from `village/gen-pass.ts` inside the gen
 * worker. The layout is a pure function of the seed, so each chunk redraws only the elements
 * that touch it (out-of-chunk writes are dropped by the gen context).
 */
import type { GenContext } from '../world/gen';
import {
  drawBell, drawFarm, drawGarden, drawGate, drawGreen, drawLamp, drawNoticeBoard, drawPlaza, drawPlot, drawRoad, drawWell,
  type Rect,
} from './gen/decor';
import type { VoxelSink } from './gen/local';
import { drawTemplate } from './gen/templates';
import { footprint, localFrame, planVillage } from './layout';

function touches(r: Rect, x0: number, z0: number, margin: number): boolean {
  return r.x1 + margin >= x0 && r.x0 - margin <= x0 + 15 && r.z1 + margin >= z0 && r.z0 - margin <= z0 + 15;
}

const pt = (x: number, z: number, w = 1, d = 1): Rect => ({ x0: x, z0: z, x1: x + w - 1, z1: z + d - 1 });

/** Draws every village element that intersects the chunk in `ctx`. */
export function stampVillage(ctx: GenContext): void {
  const site = ctx.site;
  if (!site) return;
  const v = planVillage(ctx.seed, site);
  const { x0, z0 } = ctx;
  if (!touches(v.bounds, x0, z0, 2)) return;
  const s: VoxelSink = { set: (x, y, z, id, meta) => ctx.set(x, y, z, id, meta) };
  const y0 = v.y0;
  const near = (r: Rect, m = 1) => touches(r, x0, z0, m);

  // 1. Ground: roads, paths, plaza.
  for (const r of v.roads) if (near(r)) drawRoad(s, r, y0, v.pal, v.seed);
  for (const r of v.paths) if (near(r)) drawRoad(s, r, y0, v.pal, v.seed);
  if (near(v.plaza)) drawPlaza(s, v.plaza, v.ox, v.oz, y0, v.pal, v.seed);

  // 2. Bram's plot and the farms.
  const plotBig: Rect = { x0: v.plot.rect.x0 - 1, z0: v.plot.rect.z0 - 1, x1: v.plot.rect.x1 + 1, z1: v.plot.rect.z1 + 1 };
  if (near(plotBig, 2)) drawPlot(s, v.plot.rect, y0, v.plot.sign, v.pal);
  for (const f of v.farms) if (near(f.rect, 2)) drawFarm(s, f.rect, y0, v.seed, f.scarecrow);

  // 3. Buildings (with their roof overhang and the cleared ring).
  for (const b of v.buildings) if (near(footprint(b), 2)) drawTemplate(b.kind, localFrame(b, y0, s), b.style);

  // 4. Greens, gardens and street furniture.
  for (const r of v.greens) if (near(r)) drawGreen(s, r, y0, v.pal, v.seed);
  for (const r of v.gardens) if (near(r)) drawGarden(s, r, y0);
  if (near(pt(v.well.x, v.well.z, 4, 4))) drawWell(s, v.well.x, v.well.z, y0, v.pal);
  if (near(pt(v.bell.x, v.bell.z, 3, 1))) drawBell(s, v.bell.x, v.bell.z, y0);
  if (near(pt(v.board.x - 1, v.board.z, 6, 1))) drawNoticeBoard(s, v.board.x, v.board.z, y0);
  if (near({ x0: v.gate.x, z0: v.gate.z0 - 1, x1: v.gate.x, z1: v.gate.z1 + 1 })) drawGate(s, v.gate.x, v.gate.z0, v.gate.z1, y0, v.pal);
  for (const l of v.lamps) if (near(pt(l.x, l.z))) drawLamp(s, l.x, l.z, y0, l.glow);
}

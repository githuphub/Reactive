/**
 * Village generation pass — OWNED BY LANE V2.
 *
 * Any `src/<folder>/gen-pass.ts` with a default-exported GenPass is picked up automatically by
 * `world/gen.ts` (runs in the gen worker after terrain, caves, ores, trees and plants). The site
 * is already flattened by the terrain (`ctx.site`, see world/terrain.ts `VillageSite`).
 *
 * V2: replace this no-op with the village stamp (e.g. call `stampVillage(ctx)` from
 * `village/stamp.ts`). Write with `ctx.set(x, y, z, id, meta)` in world coordinates; writes
 * outside the current chunk are ignored, so draw whole structures every time.
 */
import type { GenPass } from '../world/gen';

const villagePass: GenPass = {
  name: 'village',
  order: 100,
  run(ctx) {
    if (!ctx.site) return;
    // V0 placeholder: nothing is stamped yet.
  },
};

export default villagePass;

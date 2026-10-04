/**
 * Village generation pass (lane V2). Auto-discovered by `world/gen.ts` and run in the gen worker
 * after terrain, caves, ores, trees and plants. Stamps Oakhollow at the seed's reserved village
 * site (see `village/stamp.ts` and the pure layout in `village/layout.ts`). Only built-in blocks
 * are used, so block ids match the main thread without any registration.
 */
import type { GenPass } from '../world/gen';
import { stampVillage } from './stamp';

const villagePass: GenPass = {
  name: 'village',
  order: 100,
  run(ctx) {
    if (!ctx.site) return;
    stampVillage(ctx);
  },
};

export default villagePass;

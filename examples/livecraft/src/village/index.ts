/**
 * Public surface of the village lane (V2). V3 imports from here:
 *
 * ```ts
 * import { village } from '../village';
 * await village.ready;
 * const bram = village.controller('bram')!;
 * await bram.walkTo('bram_plot');
 * const plot = village.plots[0];
 * await bram.buildPlan(expanded, { origin: plot.origin, onProgress: (p) => console.log(p) });
 * village.ownerAt(x, y, z); // { buildingId: 'mara_house', owner: 'mara' } | null
 * ```
 */
export { village, Village } from './village';
export type { Building, Plot, VillageState, RepairTracker, TalkHandler, Posture, SavedVillage } from './village';
export { VillagerController, AGENT_GRACE } from './npc/controller';
export type { ActionResult, ActionProgress, ActionOptions, BuildOptions, WalkOptions, ExpandedPlanLike, PlanBlock, Target } from './npc/controller';
export { Npc } from './npc/npc';
export { NAMED_CAST } from './npc/cast';
export type { CastMember } from './npc/cast';
export { GridNavigator } from './nav';
export type { Navigator, NavOptions, Vec3Like } from './nav';
export { planVillage } from './layout';
export type { VillageLayout, BuildingSpec } from './layout';
export { OFFERS, priceAt } from './trade/offers';
export type { TradeOffer } from './trade/offers';
export type { HaggleHandler, HaggleRequest, HaggleResult } from './trade/screen';
export { COINS } from './items';
export type { TradedEvent, HaggledEvent, VillagerActionEvent } from './events';

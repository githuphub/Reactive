// Module "forge" - OWNER: K3. Only edit files inside packages/server/src/modules/forge/.
// Forge: Blueprint v1 / Variant / VFX recipes / stats from prompts or context, Hyper3D upgrade jobs, bake + review.
// Contract: docs/CONTRACTS.md. Asks owned here: forge.item, forge.armour_set, forge.look, forge.vfx, forge.creature,
// forge.npc_look, forge.prop, forge.loot. Projections owned here: forge.gallery (world; ForgeGallery).
//
// How it works (spec §3.5):
//  - instant = rules: keyword + procedural (Counterforge's keyless forge, generalised to the manifest's families,
//    slots, elements, stats and tags) -> Blueprint v1 / Variant / VFX recipe, every stat clamped to the item schema
//    and rarity budget, raw-power requests kept plain (creativity rules), blocked wishes "fizzle" into slag.
//  - upgrade = one structured LLM call per ask (compact style / shape, ~300 tokens), clamped + grip / ground guards.
//  - `mesh: true` + manifest clamps.forge.meshJobs + HYPER3D_API_KEY: a Hyper3D job; the blueprint is the stand-in,
//    the core pushes `forge.ready` with the GLB url; GET /v1/m/forge/mesh/:jobId proxies to it.
//  - bake mode + review queue: /admin/m/forge/bake | review | pack (see routes.ts).
// Library data: library/archetypes.ts (~130 Counterforge templates), library/objects.ts (~40 everyday things +
// creature behaviour models), library/armour.ts (slot templates). Options: env.ts ForgeOptions.
import { defineModule } from "../../module.js";
import { forgeAsks } from "./asks.js";
import { galleryProjection } from "./gallery.js";
import { forgeAdmin, forgeContexts, forgePublic } from "./routes.js";

export default defineModule({
  id: "forge",
  description: "Forge: Blueprint v1 / Variant / VFX recipes / stats from prompts or context, Hyper3D upgrade jobs, bake + review.",
  projections: [galleryProjection],
  signalHandlers: [],
  asks: forgeAsks,
  ticks: [],
  routes: { admin: forgeAdmin, public: forgePublic },
  init(ctx) {
    forgeContexts.set(ctx.game, ctx);
  },
});

export { produceRules, produceAi, FORGE_KINDS, type ForgeKind } from "./service.js";
export { forgeEnv, type ForgeEnv, type ForgeOptions } from "./env.js";
export { forgeLootRules, forgeItemRules, type LootContext } from "./items.js";

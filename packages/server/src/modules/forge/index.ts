// Module "forge" - OWNER: K3. Only edit files inside packages/server/src/modules/forge/.
// Forge: Blueprint v1 / Variant / VFX recipes / stats from prompts or context, Hyper3D upgrade jobs, bake + review.
// Contract: docs/CONTRACTS.md. Asks owned here: forge.item, forge.armour_set, forge.look, forge.vfx, forge.creature, forge.npc_look, forge.prop, forge.loot.
// Projections owned here: forge.gallery (world; ForgeGallery).
import { defineModule } from "../../module.js";

export default defineModule({
  id: "forge",
  description: "Forge: Blueprint v1 / Variant / VFX recipes / stats from prompts or context, Hyper3D upgrade jobs, bake + review.",
  projections: [],
  signalHandlers: [],
  // Unimplemented ask kinds fall back to the core rules stubs in core/fallbacks.ts.
  asks: {},
  ticks: [],
});

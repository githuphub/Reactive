// Module "builder" - OWNER: K6. Only edit files inside packages/server/src/modules/builder/.
// Voxel build plans for the Voxel DSL (@liveforge/protocol voxel.ts).
//
// Ask builder.plan {prompt, site: {size, ground?}, palette?, style?, npc?, context?} -> {plan, summary, materials, template?}
//  - instant: keyword -> parametric template (house, tower, wall, statue, bridge, farm, well; "house with a tower"
//    combines two) sized to the site, palette from params or manifest builder.palette. Rules summary sentence.
//  - upgrade: Sonnet structured output against voxelPlanJsonSchema (lore + tone + the game's block ids in the
//    prompt), clamped, expanded to count materials; an empty plan keeps the template. Cached on prompt+site+palette.
// Every plan is recorded as lf.builder.planned {npc, prompt, plan, summary, source} and pushed to the Brain feed.
// Manifest: modules.builder: true, plus `builder: {palette, blockIds?, aliases?, maxBlocks?, fallbackBlock?, styleGuide?}`.
import { defineModule } from "../../module.js";
import { builderPlan } from "./plan.js";

export default defineModule({
  id: "builder",
  description: "Voxel build plans: parametric templates instantly, Sonnet-designed Voxel DSL plans as the upgrade.",
  asks: { "builder.plan": builderPlan },
});

export { builderPlan, expandForGame, type BuilderOptions } from "./plan.js";
export { builderSystem, builderUser } from "./prompt.js";

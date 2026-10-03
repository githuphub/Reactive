// builder.plan: instant = keyword template sized to the site; upgrade = Sonnet structured output against
// voxelPlanJsonSchema, clamped, expanded (materials) and rejected when empty.
import {
  brainModel, chooseVoxelTemplate, clampVoxelPlan, expandVoxelPlan, rulesVoxelPlan, voxelPlanJsonSchema,
  type AskParams, type AskResult, type BrainModel, type ExpandedPlan, type VoxelPlan, type VoxelVec,
} from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";
import type { AskHandler, ScopedContext } from "../../module.js";
import { npcName } from "../agents/lore.js";
import { builderSystem, builderUser } from "./prompt.js";

type Params = AskParams<"builder.plan">;
type Result = AskResult<"builder.plan">;

/** Module options (manifest `modules.builder: {options: {...}}`). */
export interface BuilderOptions {
  /** Output token cap for the AI plan (default 2500). */
  maxTokens?: number;
  /** LLM timeout (default 40 000 ms). */
  timeoutMs?: number;
}

const optionsOf = (o: Record<string, unknown>): Required<BuilderOptions> => ({
  maxTokens: typeof o.maxTokens === "number" ? Math.max(500, Math.min(8000, o.maxTokens)) : 2500,
  timeoutMs: typeof o.timeoutMs === "number" ? Math.max(5000, Math.min(120_000, o.timeoutMs)) : 40_000,
});

/** Expand with the manifest's block ids, aliases and limits. */
export function expandForGame(m: Manifest, plan: VoxelPlan, size: VoxelVec): ExpandedPlan {
  return expandVoxelPlan(plan, {
    site: size,
    blockIds: m.builder.blockIds,
    aliases: m.builder.aliases,
    fallback: m.builder.fallbackBlock,
    maxBlocks: m.builder.maxBlocks,
  });
}

const total = (mat: Record<string, number>) => Object.values(mat).reduce((a, b) => a + b, 0);
const topMaterials = (mat: Record<string, number>, n = 3) =>
  Object.entries(mat).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `${c} ${k}`).join(", ");

function record(ctx: ScopedContext, p: Params, result: Result, source: "rules" | "ai", model: BrainModel, ms?: number): void {
  ctx.record("lf.builder.planned", { npc: p.npc ?? null, prompt: p.prompt, plan: result.plan, summary: result.summary, source, template: result.template ?? null, materials: result.materials });
  ctx.brain({
    source: "builder",
    actor: p.npc ?? "builder",
    kind: "plan",
    text: result.summary,
    data: { prompt: p.prompt, site: p.site.size, plan: result.plan, materials: result.materials, template: result.template },
    model,
    ...(ms !== undefined ? { ms } : {}),
  });
}

export const builderPlan: AskHandler<"builder.plan"> = {
  instant(ctx, p) {
    const m = ctx.manifest;
    const size = p.site.size as VoxelVec;
    const template = chooseVoxelTemplate(p.prompt);
    // for statues the palette carries the colours; the manifest's material palette would make a wooden statue
    const palette = template === "statue" ? p.palette : p.palette?.length ? p.palette : m.builder.palette.length ? m.builder.palette : undefined;
    const rp = rulesVoxelPlan({ prompt: `${p.prompt} ${p.style ?? ""}`, size, palette });
    const ex = expandForGame(m, rp.plan, size);
    const who = npcName(m, p.npc);
    const summary = `${who} picks the ${rp.template.replace("+", " and ")} template: ${rp.plan.name}, ${total(ex.materials)} blocks (${topMaterials(ex.materials)}).`.slice(0, 300);
    const result: Result = { plan: rp.plan, summary, materials: ex.materials, template: rp.template };
    record(ctx, p, result, "rules", "rules");
    return { result, why: `rules: "${rp.template}" template sized to the ${size.join("x")} site`, source: "rules" };
  },

  async upgrade(ctx, p) {
    if (!ctx.llm) return null;
    const m = ctx.manifest;
    const o = optionsOf(ctx.options);
    const size = p.site.size as VoxelVec;
    const palette = p.palette?.length ? p.palette : m.builder.palette;
    const template = chooseVoxelTemplate(p.prompt);
    const r = await ctx.llm.json(voxelPlanJsonSchema(), builderSystem(m), builderUser(m, p, palette, template), {
      tier: "rich", task: "builder.plan", maxTokens: o.maxTokens, timeoutMs: o.timeoutMs, signal: ctx.signal,
    });
    const plan = clampVoxelPlan(r.value, { site: size, maxBlocks: m.builder.maxBlocks });
    const ex = expandForGame(m, plan, size);
    const blocks = total(ex.materials);
    if (!blocks) {
      ctx.log.info("AI build plan had no blocks; keeping the template", { prompt: p.prompt });
      return null;
    }
    // LLM text out: moderate name + summary, fall back to plain wording when flagged
    const text = `${plan.name}. ${plan.summary ?? ""}`;
    const v = await ctx.moderation.check(text, { direction: "output", manifest: m });
    if (!v.ok) {
      plan.name = "Custom build";
      delete plan.summary;
    }
    const summary = (plan.summary ? `${plan.name}: ${plan.summary}` : `${npcName(m, p.npc)} designs ${plan.name}: ${blocks} blocks (${topMaterials(ex.materials)}).`).slice(0, 300);
    const result: Result = { plan, summary, materials: ex.materials };
    record(ctx, p, result, "ai", brainModel(r.model, (r as { source?: string }).source), r.ms);
    return { result, why: `AI plan: ${plan.ops.length} ops, ${blocks} blocks${ex.warnings.length ? ` (${ex.warnings.length} fixes)` : ""}` };
  },

  cacheKey: (p) => ({ prompt: p.prompt.trim().toLowerCase(), site: p.site.size, palette: p.palette ?? null, style: p.style ?? null }),
  cacheTtlSec: 24 * 3600,
  upgradeTimeoutMs: 45_000,
};

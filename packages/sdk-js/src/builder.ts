// `lf.builder`: Voxel DSL build plans. plan() is a normal two-stage ask (instant template, AI upgrade); offline or
// unreachable it answers from the local template planner (same rules as the server), so builds always happen.
import {
  expandVoxelPlan,
  rulesVoxelPlan,
  type AskParamsInput,
  type AskResult,
  type ExpandedPlan,
  type VoxelPlan,
  type VoxelVec,
} from "@liveforge/protocol";
import type { VoxelExpandOptions } from "@liveforge/protocol";
import type { AskHandle } from "./ask.js";
import type { AskOptions, FallbackFn } from "./client.js";

export type BuilderPlanParams = AskParamsInput<"builder.plan">;
export type BuilderPlanResult = AskResult<"builder.plan">;

/** @internal wiring from the client. */
export interface BuilderDeps {
  ask(params: BuilderPlanParams, opts?: AskOptions<"builder.plan">): AskHandle<"builder.plan">;
  setFallback(fn: FallbackFn<"builder.plan">): void;
}

/** The keyless planner (server instant rules, run locally). */
export function localBuilderPlan(params: BuilderPlanParams, opts: { blockIds?: readonly string[] } = {}): BuilderPlanResult {
  const size = params.site.size as VoxelVec;
  const rp = rulesVoxelPlan({ prompt: `${params.prompt} ${params.style ?? ""}`, size, ...(params.palette ? { palette: params.palette } : {}) });
  const ex = expandVoxelPlan(rp.plan, { site: size, ...(opts.blockIds ? { blockIds: opts.blockIds } : {}) });
  return { plan: rp.plan, summary: rp.summary.slice(0, 300), materials: ex.materials, template: rp.template };
}

export class BuilderApi {
  private blockIds: readonly string[] | undefined;

  constructor(private readonly deps: BuilderDeps) {
    deps.setFallback((p) => localBuilderPlan(p, { blockIds: this.blockIds }));
  }

  /**
   * Plans a build. `instant` = a template sized to the site (rules), `onUpgrade` = the AI-designed plan.
   *
   * ```ts
   * const h = lf.builder.plan({ prompt: "a cosy house with a tower", site: { size: [16, 14, 10] }, npc: "bram" });
   * startBuilding((await h.instant).result.plan);
   * h.onUpgrade((r) => switchTo(r.result.plan));
   * ```
   */
  plan(params: BuilderPlanParams, opts?: AskOptions<"builder.plan">): AskHandle<"builder.plan"> {
    return this.deps.ask(params, opts);
  }

  /** Expands a plan into an ordered block list (blocks known to this game when setBlockIds was called). */
  expand(plan: VoxelPlan, opts: VoxelExpandOptions = {}): ExpandedPlan {
    return expandVoxelPlan(plan, { ...(this.blockIds ? { blockIds: this.blockIds } : {}), ...opts });
  }

  /** The game's block ids: local plans and expand() map unknown ids onto these. */
  setBlockIds(ids: readonly string[]): void {
    this.blockIds = ids.length ? [...ids] : undefined;
  }
}

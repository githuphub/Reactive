// `lf.forge`: forge anything. thing() is a normal two-stage ask (instant keyword rules, AI upgrade); offline or
// unreachable it answers from the local rules forge (same rules as the server), so a forge never comes back empty.
import {
  expandVoxelModel,
  rulesForgedThing,
  type AskParamsInput,
  type AskResult,
  type ExpandedModel,
  type ThingCategory,
  type VoxelModel,
} from "@liveforge/protocol";
import type { AskHandle } from "./ask.js";
import type { AskOptions, FallbackFn } from "./client.js";

export type ForgeThingParams = AskParamsInput<"forge.thing">;
export type ForgeThingResult = AskResult<"forge.thing">;

/** thing() options: ask options plus the forge.thing params besides the prompt. */
export interface ForgeThingOptions extends AskOptions<"forge.thing"> {
  /** Allowed categories (default all). */
  categories?: ThingCategory[];
  /** Max model size per axis in voxels (default 16, 4-32). */
  maxModelSize?: number;
  /** Free game context (biome, who asks ...). */
  context?: Record<string, unknown>;
}

/** @internal wiring from the client. */
export interface ForgeDeps {
  ask(params: ForgeThingParams, opts?: AskOptions<"forge.thing">): AskHandle<"forge.thing">;
  setFallback(fn: FallbackFn<"forge.thing">): void;
}

/** The keyless forge (server instant rules, run locally). */
export function localForgeThing(params: ForgeThingParams): ForgeThingResult {
  return rulesForgedThing({ prompt: params.prompt, ...(params.categories ? { categories: params.categories } : {}), ...(params.maxModelSize ? { maxModelSize: params.maxModelSize } : {}) });
}

export class ForgeApi {
  constructor(private readonly deps: ForgeDeps) {
    deps.setFallback((p) => localForgeThing(p));
  }

  /**
   * Forges whatever the prompt names: a creature, food, tool, weapon, wearable, decoration, material or block, with
   * a coloured voxel model. `instant` = keyword rules, `onUpgrade` = the AI-designed thing.
   *
   * ```ts
   * const h = lf.forge.thing("a chicken");
   * spawn((await h.instant).result);            // category "creature": model, behaviour, sounds, lays "egg"
   * h.onUpgrade((r) => replace(r.result));
   * ```
   */
  thing(prompt: string, opts: ForgeThingOptions = {}): AskHandle<"forge.thing"> {
    const { categories, maxModelSize, context, ...ask } = opts;
    return this.deps.ask({ prompt, ...(categories ? { categories } : {}), ...(maxModelSize ? { maxModelSize } : {}), ...(context ? { context } : {}) }, ask);
  }

  /** Expands a thing's model into coloured voxels `{x, y, z, color}` (air removed, build order). */
  expand(model: VoxelModel): ExpandedModel {
    return expandVoxelModel(model);
  }
}

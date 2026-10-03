// Which library recipes a manifest switched on, and their params (recipe defaults < manifest params).
import { recipeDoc, type ReactionRecipeId } from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";

export type Params = Record<string, unknown>;

const cache = new WeakMap<Manifest, Map<string, Params>>();

/** Enabled recipes -> merged params (doc defaults, then the manifest's). Cached per manifest object. */
export function libraryOf(m: Manifest): Map<string, Params> {
  let out = cache.get(m);
  if (out) return out;
  out = new Map();
  for (const e of m.reactions.library) {
    const doc = recipeDoc(e.recipe);
    if (!doc) continue;
    const params: Params = { enabled: true, chance: 1, ai: true };
    for (const [k, spec] of Object.entries(doc.params)) if (spec.default !== undefined) params[k] = spec.default;
    Object.assign(params, e.params);
    if (params.enabled === false) continue;
    out.set(e.recipe, params);
  }
  cache.set(m, out);
  return out;
}

export const libraryOn = (m: Manifest): boolean => libraryOf(m).size > 0;
export const recipeOn = (m: Manifest, id: ReactionRecipeId | string): boolean => libraryOf(m).has(id);
export const paramsOf = (m: Manifest, id: string): Params => libraryOf(m).get(id) ?? {};

export const pNum = (p: Params, k: string, d: number): number => (typeof p[k] === "number" && Number.isFinite(p[k]) ? (p[k] as number) : d);
export const pStr = (p: Params, k: string, d = ""): string => (typeof p[k] === "string" ? (p[k] as string) : d);
export const pBool = (p: Params, k: string, d: boolean): boolean => (typeof p[k] === "boolean" ? (p[k] as boolean) : d);
export const pList = (p: Params, k: string, d: string[] = []): string[] => (Array.isArray(p[k]) ? (p[k] as unknown[]).filter((x): x is string => typeof x === "string") : d);
export const pRecord = (p: Params, k: string): Record<string, string> => {
  const v = p[k];
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === "string")) as Record<string, string>;
};

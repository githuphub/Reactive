// Per-call forge environment: the manifest's item schema, elements, clamps and the module options
// (manifest modules.forge.options), resolved once per manifest object.
import { moduleOptions, type Manifest } from "@liveforge/manifest";
import { itemSchema, type ItemSchema, type StatRange } from "./schema.js";
import { clampN, finOr, isObj } from "./model.js";

/**
 * manifest `modules.forge.options` (all optional):
 * ```yaml
 * modules:
 *   forge:
 *     options:
 *       creatureStats: { hp: { min: 10, max: 2000 }, damage: { min: 1, max: 80 }, speed: { min: 0.5, max: 12 } }
 *       creatureBehaviours: [charge, orbit, turret, guard, kite]   # behaviour ids your game implements
 *       meshWaitMs: 1500        # how long an instant answer waits for the Hyper3D job id
 *       bakeWorld: _bake        # world used by bake mode (admin)
 *       maxBake: 50             # max items per bake request
 *       lootRarityBoost: { elite: 1, boss: 2 }
 * ```
 */
export interface ForgeOptions {
  creatureStats: Record<string, StatRange>;
  creatureBehaviours: string[] | null;
  meshWaitMs: number;
  bakeWorld: string;
  maxBake: number;
  lootRarityBoost: { elite: number; boss: number };
}

export interface ForgeEnv {
  manifest: Manifest;
  schema: ItemSchema;
  elements: string[];
  /** manifest clamps.forge.maxParts */
  maxParts: number;
  factions: string[];
  options: ForgeOptions;
}

const DEFAULT_CREATURE_STATS: Record<string, StatRange> = {
  hp: { min: 5, max: 1000, default: 60 },
  damage: { min: 1, max: 60, default: 10 },
  speed: { min: 0.5, max: 12, default: 4 },
};

const ENV_CACHE = new WeakMap<Manifest, ForgeEnv>();

function readOptions(raw: Record<string, unknown>): ForgeOptions {
  const cs: Record<string, StatRange> = {};
  if (isObj(raw.creatureStats)) {
    for (const [k, v] of Object.entries(raw.creatureStats)) {
      if (isObj(v) && typeof v.min === "number" && typeof v.max === "number" && v.max >= v.min) {
        cs[k] = { min: v.min, max: v.max, ...(typeof v.default === "number" ? { default: v.default } : {}) };
      }
    }
  }
  const boost = isObj(raw.lootRarityBoost) ? raw.lootRarityBoost : {};
  return {
    creatureStats: Object.keys(cs).length ? cs : DEFAULT_CREATURE_STATS,
    creatureBehaviours: Array.isArray(raw.creatureBehaviours) ? raw.creatureBehaviours.filter((b): b is string => typeof b === "string" && !!b).slice(0, 32) : null,
    meshWaitMs: clampN(finOr(raw.meshWaitMs, 1500), 0, 5000),
    bakeWorld: typeof raw.bakeWorld === "string" && /^[A-Za-z0-9_\-.:]{1,64}$/.test(raw.bakeWorld) ? raw.bakeWorld : "_bake",
    maxBake: Math.round(clampN(finOr(raw.maxBake, 50), 1, 500)),
    lootRarityBoost: { elite: Math.round(clampN(finOr(boost.elite, 1), 0, 4)), boss: Math.round(clampN(finOr(boost.boss, 2), 0, 4)) },
  };
}

/**
 * Forge environment for a manifest (cached per manifest object). Options always come from the manifest's
 * modules.forge.options, so other modules (the Director's loot drops) get the same environment.
 */
export function forgeEnv(manifest: Manifest, _options?: Record<string, unknown>): ForgeEnv {
  let env = ENV_CACHE.get(manifest);
  if (!env) {
    env = {
      manifest,
      schema: itemSchema(manifest),
      elements: manifest.elements.length ? manifest.elements : ["physical"],
      maxParts: manifest.clamps.forge.maxParts,
      factions: manifest.factions.map((f) => f.id),
      options: readOptions(moduleOptions(manifest, "forge") ?? {}),
    };
    ENV_CACHE.set(manifest, env);
  }
  return env;
}

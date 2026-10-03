// Director options (manifest modules.director.options) with game-agnostic defaults. Everything game-specific (squad
// tactics, elite modifiers, spawn tables) is data here, so a game tunes the Director from its manifest.
import { moduleOptions, type Manifest } from "@liveforge/manifest";

/** An elite modifier and what it counters (player habit / trait names, gear tags or element names). */
export interface EliteModifier { id: string; counters: string[]; description?: string }

/**
 * manifest `modules.director.options` (all optional):
 * ```yaml
 * modules:
 *   director:
 *     options:
 *       tactics: [flank, kite, ambush, shield_wall, focus_healer, rush, hold, surround, retreat]
 *       eliteModifiers:
 *         - { id: shielded, counters: [ranged_camper, Piercing], description: "blocks projectiles from the front" }
 *         - swift                                  # plain ids work too (chosen when nothing counters better)
 *       spawnTable: { default: [hollow, hollow_archer], courtyard: [pickpocket] }
 *       autoPacing: false     # true = the pacing tick pushes spawn / breather / loot directives on its own
 *       peakSec: 12           # how long tension may stay at its peak before a breather
 *       fixedAggression: 0.5  # aggression when difficulty mode is "off"
 *       inventPerPhase: 1     # invented grammar moves added per boss phase
 * ```
 */
export interface DirectorOptions {
  tactics: string[];
  eliteModifiers: EliteModifier[];
  spawnTable: Record<string, string[]>;
  autoPacing: boolean;
  peakSec: number;
  fixedAggression: number | null;
  inventPerPhase: number;
}

export const DEFAULT_TACTICS = ["flank", "kite", "ambush", "shield_wall", "focus_healer", "rush", "hold", "surround", "retreat"];

export const DEFAULT_ELITE_MODIFIERS: EliteModifier[] = [
  { id: "shielded", counters: ["ranged_camper", "glass_cannon", "range_long", "piercing"], description: "a frontal shield that eats projectiles" },
  { id: "swift", counters: ["ranged_camper", "range_long", "dodger", "speedrunner"], description: "closes distance fast" },
  { id: "reflective", counters: ["ranged_camper", "range_long", "magic", "focus", "staff"], description: "reflects projectiles and spells" },
  { id: "unstoppable", counters: ["turtle", "blocker", "shield", "heavy"], description: "guard-breaking attacks" },
  { id: "regenerating", counters: ["dodger", "pacifist", "hit_and_run", "swift"], description: "heals when not hit" },
  { id: "explosive", counters: ["berserker", "range_close", "melee"], description: "bursts when struck in melee" },
  { id: "vampiric", counters: ["glass_cannon", "berserker", "lifesteal"], description: "heals by hitting" },
  { id: "frenzied", counters: ["turtle", "stationary", "hoarder"], description: "attacks faster the longer the fight" },
  { id: "warded", counters: ["fire", "ice", "lightning", "arcane", "poison", "holy", "shadow"], description: "resists the player's favourite element" },
];

const str = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const OPT_CACHE = new WeakMap<Manifest, DirectorOptions>();

/** Director options for a manifest (cached per manifest object). */
export function directorOptions(manifest: Manifest, _raw?: Record<string, unknown>): DirectorOptions {
  let o = OPT_CACHE.get(manifest);
  if (o) return o;
  const raw = moduleOptions(manifest, "director") ?? {};
  const tactics = Array.isArray(raw.tactics) ? raw.tactics.filter(str).map((t) => t.slice(0, 32)) : [];
  const mods: EliteModifier[] = [];
  if (Array.isArray(raw.eliteModifiers)) {
    for (const m of raw.eliteModifiers) {
      if (str(m)) mods.push(DEFAULT_ELITE_MODIFIERS.find((d) => d.id === m) ?? { id: m.slice(0, 48), counters: [] });
      else if (m && typeof m === "object" && str((m as Record<string, unknown>).id)) {
        const r = m as Record<string, unknown>;
        mods.push({
          id: String(r.id).slice(0, 48),
          counters: Array.isArray(r.counters) ? r.counters.filter(str).map((c) => c.toLowerCase()) : [],
          ...(str(r.description) ? { description: r.description.slice(0, 200) } : {}),
        });
      }
    }
  }
  const table: Record<string, string[]> = {};
  if (raw.spawnTable && typeof raw.spawnTable === "object") {
    for (const [k, v] of Object.entries(raw.spawnTable as Record<string, unknown>)) {
      if (Array.isArray(v)) table[k] = v.filter(str).map((x) => x.slice(0, 64)).slice(0, 16);
    }
  }
  const num = (v: unknown, d: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  o = {
    tactics: tactics.length ? tactics : DEFAULT_TACTICS,
    eliteModifiers: mods.length ? mods : DEFAULT_ELITE_MODIFIERS,
    spawnTable: table,
    autoPacing: raw.autoPacing === true,
    peakSec: num(raw.peakSec, 12, 2, 120),
    fixedAggression: typeof raw.fixedAggression === "number" ? num(raw.fixedAggression, 0.5, 0, 1) : null,
    inventPerPhase: Math.round(num(raw.inventPerPhase, 1, 0, 3)),
  };
  OPT_CACHE.set(manifest, o);
  return o;
}

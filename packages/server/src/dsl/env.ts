// The canonical DslEnv (CONTRACTS §7, owner K1): evaluates trait-rule DSL functions for one player over the event
// log (sliding windows), the Observer player model (traits / stats / moments), World factions and Persona memories.
// Used by Observer designer traits + moments, and by K2 reactions, achievements, unlocks and dynamic objectives.
import { matchDslFilter, parseDslRef, type DslEnv, type DslValue, type FactionState, type PersonaMemories, type StoredEvent } from "@liveforge/protocol";
import type { ModuleContext } from "../module.js";
import { readModel, type ModelState } from "../modules/observer/model.js";
import { gearNames, gearTags, traitAt } from "../modules/observer/view.js";
import { BUILTIN_TRAITS } from "../modules/observer/traits.js";

/** What makeDslEnv needs from a module context (any ctx works). */
export type DslHost = Pick<ModuleContext, "now" | "events" | "projections" | "manifest">;

export interface DslEnvOptions {
  /** Evaluation time (default ctx.now()). */
  now?: number;
  /** Extra bare identifiers (checked before traits / stats), e.g. reaction-local values. */
  vars?: Record<string, DslValue>;
  /** Extra functions (also pass their names to checkDsl's `functions`). */
  functions?: Record<string, (args: DslValue[], env: LiveDslEnv) => DslValue>;
  /** Default window for window functions called without one (default 1h). */
  defaultWindowMs?: number;
  /** Cap on events loaded for window functions (default 5000, newest kept). */
  maxEvents?: number;
  /**
   * Ignore events before this time (ms): window functions, last/since and moment() only see events at or after it.
   * Used by K2 dynamic objectives and quest conditions so "count(combat.dodged, 30s)" counts from the start time.
   */
  notBefore?: number;
}

/** A DslEnv bound to one player, plus the data it read (handy for evidence strings). */
export interface LiveDslEnv extends DslEnv {
  readonly world: string;
  readonly player: string | null;
  readonly now: number;
  /** The player's Observer model (empty when unknown / no player). */
  readonly model: ModelState;
  /** The player's current zone: model stat "zone", else the last movement.entered_zone ("" when unknown). */
  zone(): string;
}

const HOUR = 3_600_000;
const num = (v: DslValue | undefined, d = 0): number => (typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? d : Number(v) || d);
const typeMatches = (pattern: string, type: string) => pattern === "*" || (pattern.endsWith(".*") ? type.startsWith(pattern.slice(0, -1)) : pattern === type);

/**
 * Build the DSL environment for one player (player may be null for world-level rules: windows then cover the
 * whole world and trait / stat lookups return 0). Event windows are loaded lazily, once per env, so evaluate many
 * rules against one env. Errors in env lookups never throw: unknown things evaluate to 0.
 */
export function makeDslEnv(ctx: DslHost, world: string, player: string | null, opts: DslEnvOptions = {}): LiveDslEnv {
  const now = opts.now ?? ctx.now();
  const defaultWindow = opts.defaultWindowMs ?? HOUR;
  const maxEvents = opts.maxEvents ?? 5000;
  const floor = opts.notBefore ?? 0;
  const model = player ? readModel((n, s) => ctx.projections.get(n, s), world, player) : readModel(() => undefined, world, "");
  const manifest = ctx.manifest;

  // Lazily loaded window: newest-first events since (now - loadedWindow).
  let loadedWindow = -1;
  let loaded: StoredEvent[] = [];
  const windowEvents = (windowMs: number): StoredEvent[] => {
    if (windowMs > loadedWindow) {
      loaded = ctx.events({ world, ...(player ? { player } : {}), since: Math.max(0, floor, now - windowMs), limit: maxEvents, desc: true })
        .filter((e) => !e.type.startsWith("lf."));
      loadedWindow = windowMs;
    }
    const since = Math.max(floor, now - windowMs);
    return loaded.filter((e) => e.ts >= since && e.ts <= now + 60_000);
  };
  const matching = (refName: string, windowMs: number, withField: boolean) => {
    const ref = parseDslRef(refName, withField);
    return { ref, events: windowEvents(windowMs).filter((e) => typeMatches(ref.type, e.type) && matchDslFilter(ref.filter, e.data)) };
  };
  const fieldOf = (e: StoredEvent, field: string | null): unknown => (field ? (e.data as Record<string, unknown>)[field] : undefined);
  const lastMatching = (refName: string, withField: boolean): { ev: StoredEvent | undefined; field: string | null } => {
    const ref = parseDslRef(refName, withField);
    const q = ctx.events({ world, ...(player ? { player } : {}), ...(ref.type !== "*" ? { type: ref.type } : {}), desc: true, limit: 200 });
    return { ev: q.find((e) => e.ts >= floor && !e.type.startsWith("lf.") && typeMatches(ref.type, e.type) && matchDslFilter(ref.filter, e.data)), field: ref.field };
  };
  const windowArg = (v: DslValue | undefined) => (v === undefined ? defaultWindow : Math.max(1, num(v, defaultWindow)));

  const stat = (name: string): DslValue => {
    const v = model.stats[name];
    if (v !== undefined) return v;
    if (name === "traits") return Object.keys(model.traits).length;
    return 0;
  };
  const trait = (name: string): number => traitAt(model, name, now, manifest);
  const safeGet = <T>(name: string, scope: { world: string; player?: string | null }): T | undefined => {
    try {
      return ctx.projections.get(name, scope) as T;
    } catch {
      return undefined;
    }
  };

  let zoneCache: string | undefined;
  const zone = (): string => {
    if (zoneCache !== undefined) return zoneCache;
    const z = model.stats.zone;
    if (typeof z === "string" && z) return (zoneCache = z);
    const ev = player ? ctx.events({ world, player, type: "movement.entered_zone", desc: true, limit: 1 })[0] : undefined;
    return (zoneCache = typeof ev?.data.zone === "string" ? ev.data.zone : "");
  };

  const env: LiveDslEnv = {
    world, player, now, model, zone,
    ident(name) {
      if (opts.vars && name in opts.vars) return opts.vars[name];
      if (name in model.traits || name in BUILTIN_TRAITS || name in manifest.traits) return trait(name);
      return stat(name);
    },
    call(fn, args) {
      try {
        switch (fn) {
          case "count": return matching(String(args[0]), windowArg(args[1]), false).events.length;
          case "rate": {
            const w = windowArg(args[1]);
            return matching(String(args[0]), w, false).events.length / Math.max(1 / 60, w / 60_000);
          }
          case "sum": case "avg": case "max": {
            const { ref, events } = matching(String(args[0]), windowArg(args[1]), true);
            const xs = events.map((e) => fieldOf(e, ref.field)).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
            if (!xs.length) return 0;
            if (fn === "sum") return xs.reduce((a, b) => a + b, 0);
            if (fn === "avg") return xs.reduce((a, b) => a + b, 0) / xs.length;
            return Math.max(...xs);
          }
          case "distinct": {
            const { ref, events } = matching(String(args[0]), windowArg(args[1]), true);
            return new Set(events.map((e) => JSON.stringify(fieldOf(e, ref.field) ?? null))).size;
          }
          case "last": {
            const { ev, field } = lastMatching(String(args[0]), true);
            const v = ev ? fieldOf(ev, field) : undefined;
            return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : 0;
          }
          case "since": {
            const { ev } = lastMatching(String(args[0]), false);
            return ev ? Math.max(0, (now - ev.ts) / 1000) : Infinity;
          }
          case "trait": return trait(String(args[0]));
          case "stat": return stat(String(args[0]));
          case "moment": {
            const kind = String(args[0]);
            const since = Math.max(floor, now - windowArg(args[1]));
            return model.moments.filter((m) => (kind === "*" || m.kind === kind) && m.ts >= since).length;
          }
          case "rep": {
            const faction = String(args[0]);
            const st = safeGet<FactionState>("world.factions", { world });
            const v = player ? st?.reputation?.[faction]?.[player] : undefined;
            if (typeof v === "number") return v;
            return manifest.factions.find((f) => f.id === faction)?.attitude ?? 0;
          }
          case "attitude": {
            const npc = String(args[0]);
            const mem = player ? safeGet<PersonaMemories>("persona.memories", { world, player }) : undefined;
            const v = mem?.npcs?.[npc]?.attitude;
            if (typeof v === "number") return v;
            const persona = manifest.personas.find((p) => p.id === npc);
            return manifest.factions.find((f) => f.id === persona?.faction)?.attitude ?? 0;
          }
          case "has": {
            const tag = String(args[0]).toLowerCase();
            if (gearTags(model).some((t) => t.toLowerCase() === tag)) return true;
            if (Object.values(gearNames(model)).some((n) => n.toLowerCase() === tag)) return true;
            const v = model.stats[String(args[0])] ?? model.stats[`tag:${args[0]}`];
            return v === true || (typeof v === "number" && v > 0) || (typeof v === "string" && v.length > 0);
          }
          case "min2": return Math.min(num(args[0]), num(args[1]));
          case "max2": return Math.max(num(args[0]), num(args[1]));
          default: {
            const extra = opts.functions?.[fn];
            return extra ? extra(args, env) : 0;
          }
        }
      } catch {
        return 0;
      }
    },
  };
  return env;
}

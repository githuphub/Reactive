// Thin stand-in for the trait-rule DSL environment (K2, isolated in the world module folder).
// K1 (Observer) owns the canonical DslEnv. Until it lands, World + Quests evaluate reactions, achievements,
// progression unlocks and dynamic objectives with this one. It reads the event log directly, plus the
// observer / persona / world projections when those modules are enabled, so it works with any subset of modules.
// At merge: point modules/world/dsl.ts at K1 modules/observer/dsl-env.ts (makeDslEnv) and delete this file.
import type { DslEnv, DslValue, StoredEvent } from "@liveforge/protocol";
import type { ModuleContext } from "../../module.js";
import { matchType } from "../../store/events.js";

/** The parts of a module context the environment needs (any ModuleContext / scoped context fits). */
export type DslHost = Pick<ModuleContext, "events" | "projections" | "manifest" | "now">;

export interface DslEnvOptions {
  /** Ignore events before this time (ms). Dynamic objectives / quests pass their start time so windows clip to it. */
  notBefore?: number;
  /** Max events loaded for window functions (default 5000, newest first). */
  maxEvents?: number;
  /** Extra functions (name -> implementation). They shadow nothing: built-ins win. */
  functions?: Record<string, (args: DslValue[]) => DslValue>;
}

/** A DslEnv plus the cached reads it made (handy for templates and `why` strings). */
export interface HostDslEnv extends DslEnv {
  /** observer.player_model state, or null when the Observer is disabled / has no state yet. */
  readonly model: PlayerModelLike | null;
  /** Current zone (player model stat "zone", else the last movement.entered_zone). */
  zone(): string;
}

/** The subset of observer.player_model this env reads (kept loose so K1 can extend the shape freely). */
export interface PlayerModelLike {
  traits?: Record<string, { score?: number } | undefined>;
  stats?: Record<string, number | string | boolean | undefined>;
  moments?: { kind: string; ts: number }[];
}

const DEFAULT_WINDOW = 10 * 60_000;
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : NaN);

/** Split "economy.bought.price{vendor=kit}" into type / field / raw filter (filters are matched loosely: field=value pairs). */
function splitRef(name: string, withField: boolean): { type: string; field: string | null; filter: [string, string, string][] } {
  const brace = name.indexOf("{");
  const base = brace >= 0 ? name.slice(0, brace) : name;
  const filter: [string, string, string][] = [];
  if (brace >= 0) {
    for (const part of name.slice(brace + 1).replace(/\}$/, "").split(",")) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*(==|!=|>=|<=|=|>|<)\s*["']?(.*?)["']?\s*$/.exec(part);
      if (m) filter.push([m[1], m[2] === "==" ? "=" : m[2], m[3]]);
    }
  }
  if (!withField) return { type: base, field: null, filter };
  const parts = base.split(".");
  if (parts.length >= 3) return { type: parts.slice(0, -1).join("."), field: parts[parts.length - 1], filter };
  return { type: base, field: null, filter };
}

function passes(filter: [string, string, string][], data: Record<string, unknown>): boolean {
  for (const [field, op, raw] of filter) {
    const v = field.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), data);
    if (op === "=" || op === "!=") {
      const eq = Array.isArray(v) ? v.map(String).includes(raw) : v !== undefined && String(v) === raw;
      if (op === "=" ? !eq : eq) return false;
      continue;
    }
    const a = num(v);
    const b = num(raw);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if ((op === ">" && !(a > b)) || (op === ">=" && !(a >= b)) || (op === "<" && !(a < b)) || (op === "<=" && !(a <= b))) return false;
  }
  return true;
}

/** Numeric value of a field, with sensible fallbacks for two-segment refs (economy.gold -> amount). */
function fieldValue(data: Record<string, unknown>, field: string | null): number {
  if (field) return num(data[field]);
  for (const k of ["amount", "value", "delta", "damage", "price"]) {
    const n = num(data[k]);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

function safeGet<T>(ctx: DslHost, name: string, scope: { world: string; player?: string | null }): T | null {
  try {
    return ctx.projections.get<T>(name, scope) ?? null;
  } catch {
    return null;
  }
}

/**
 * Build a DSL environment for one player in one world. Cheap to create; loads events lazily on the first window
 * function and caches them for the life of the env (create a fresh one per evaluation pass).
 */
export function makeDslEnv(ctx: DslHost, world: string, player: string, opts: DslEnvOptions = {}): HostDslEnv {
  const now = ctx.now();
  const floor = opts.notBefore ?? 0;
  const maxEvents = opts.maxEvents ?? 5000;
  let loaded: StoredEvent[] = [];
  let loadedSince = Infinity;
  let modelRead = false;
  let model: PlayerModelLike | null = null;
  let gear: Map<string, { item: string; tags: string[] }> | null = null;

  const getModel = (): PlayerModelLike | null => {
    if (!modelRead) {
      modelRead = true;
      model = safeGet<PlayerModelLike>(ctx, "observer.player_model", { world, player });
    }
    return model;
  };

  /** Player events with ts >= since (newest first). */
  const window = (ms: number): StoredEvent[] => {
    const since = Math.max(floor, now - (Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_WINDOW));
    if (since < loadedSince) {
      loaded = ctx.events({ world, player, since, limit: maxEvents, desc: true });
      loadedSince = since;
    }
    return loaded.filter((e) => e.ts >= since);
  };

  const select = (ref: string, ms: number, withField: boolean) => {
    const r = splitRef(ref, withField);
    const evs = window(ms).filter((e) => matchType(r.type, e.type) && passes(r.filter, e.data));
    return { r, evs };
  };

  const latest = (ref: string, withField: boolean): { ev: StoredEvent | null; field: string | null } => {
    const r = splitRef(ref, withField);
    const pattern = r.type;
    const list = ctx.events({ world, player, type: pattern, since: floor || undefined, desc: true, limit: r.filter.length ? 200 : 1 });
    return { ev: list.find((e) => passes(r.filter, e.data)) ?? null, field: r.field };
  };

  const zone = (): string => {
    const z = getModel()?.stats?.zone;
    if (typeof z === "string" && z) return z;
    const ev = ctx.events({ world, player, type: "movement.entered_zone", desc: true, limit: 1 })[0];
    return typeof ev?.data.zone === "string" ? ev.data.zone : "";
  };

  const stat = (name: string): DslValue => {
    const v = getModel()?.stats?.[name];
    if (v !== undefined) return v;
    if (name === "zone") return zone();
    if (name === "gold") {
      const ev = ctx.events({ world, player, type: "economy.gold", desc: true, limit: 1 })[0];
      const n = num(ev?.data.amount);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  };

  const trait = (name: string): number => {
    const s = getModel()?.traits?.[name]?.score;
    return typeof s === "number" && Number.isFinite(s) ? s : 0;
  };

  const rep = (faction: string): number => {
    const st = safeGet<{ reputation?: Record<string, Record<string, number>> }>(ctx, "world.factions", { world });
    const v = st?.reputation?.[faction]?.[player];
    if (typeof v === "number") return v;
    return ctx.manifest.factions.find((f) => f.id === faction)?.attitude ?? 0;
  };

  const attitude = (npc: string): number => {
    const mem = safeGet<{ npcs?: Record<string, { attitude?: number }> }>(ctx, "persona.memories", { world, player });
    const a = mem?.npcs?.[npc]?.attitude;
    if (typeof a === "number") return a;
    const f = ctx.manifest.personas.find((p) => p.id === npc)?.faction;
    return f ? rep(f) : 0;
  };

  const has = (tag: string): boolean => {
    const s = getModel()?.stats?.[tag];
    if (s === true) return true;
    if (!gear) {
      gear = new Map();
      const evs = ctx.events({ world, player, type: "gear.*", desc: true, limit: 300 }).reverse();
      for (const e of evs) {
        const slot = String(e.data.slot ?? e.data.item ?? "");
        if (e.type === "gear.equipped") gear.set(slot, { item: String(e.data.item ?? ""), tags: Array.isArray(e.data.tags) ? e.data.tags.map(String) : [] });
        else if (e.type === "gear.unequipped") gear.delete(slot);
      }
    }
    const t = tag.toLowerCase();
    for (const g of gear.values()) if (g.item.toLowerCase() === t || g.tags.some((x) => x.toLowerCase() === t)) return true;
    return false;
  };

  const ms = (v: DslValue | undefined): number => (typeof v === "number" ? v : DEFAULT_WINDOW);

  const env: HostDslEnv = {
    get model() {
      return getModel();
    },
    zone,
    ident(name: string): DslValue {
      const m = getModel();
      if (m?.traits && name in m.traits) return trait(name);
      if (m?.stats && m.stats[name] !== undefined) return m.stats[name] as DslValue;
      const z = zone();
      if (z && (name === z || name === `in_${z}`)) return true;
      if (name.startsWith("in_")) return false;
      if (name === "zone" || name === "gold") return stat(name);
      return trait(name);
    },
    call(fn: string, args: DslValue[]): DslValue {
      const a0 = String(args[0] ?? "");
      switch (fn) {
        case "count": return select(a0, ms(args[1]), false).evs.length;
        case "rate": {
          const w = ms(args[1]);
          return select(a0, w, false).evs.length / Math.max(w / 60_000, 1 / 60);
        }
        case "sum":
        case "avg":
        case "max": {
          const { r, evs } = select(a0, ms(args[1]), true);
          const vals = evs.map((e) => fieldValue(e.data, r.field)).filter(Number.isFinite);
          if (!vals.length) return 0;
          if (fn === "sum") return vals.reduce((x, y) => x + y, 0);
          if (fn === "avg") return vals.reduce((x, y) => x + y, 0) / vals.length;
          return Math.max(...vals);
        }
        case "distinct": {
          const { r, evs } = select(a0, ms(args[1]), true);
          return new Set(evs.map((e) => JSON.stringify(r.field ? e.data[r.field] : e.type))).size;
        }
        case "last": {
          const { ev, field } = latest(a0, true);
          if (!ev) return 0;
          const v = field ? ev.data[field] : fieldValue(ev.data, null);
          return typeof v === "number" || typeof v === "string" || typeof v === "boolean" ? v : 0;
        }
        case "since": {
          const { ev } = latest(a0, false);
          return ev ? Math.max(0, (now - ev.ts) / 1000) : Infinity;
        }
        case "trait": return trait(a0);
        case "stat": return stat(a0);
        case "moment": {
          const since = Math.max(floor, now - ms(args[1]));
          return ctx.events({ world, player, type: "lf.observer.moment", since, limit: 500 })
            .filter((e) => (e.data.moment as { kind?: string } | undefined)?.kind === a0).length;
        }
        case "rep": return rep(a0);
        case "attitude": return attitude(a0);
        case "has": return has(a0);
        case "min2": return Math.min(num(args[0]) || 0, num(args[1]) || 0);
        case "max2": return Math.max(num(args[0]) || 0, num(args[1]) || 0);
      }
      const extra = opts.functions?.[fn];
      if (extra) return extra(args);
      throw new Error(`unknown DSL function "${fn}"`);
    },
  };
  return env;
}

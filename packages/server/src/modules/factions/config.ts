// Factions module (K7): manifest + options resolution and small pure helpers.
import { DEFAULT_RAID_MOBS, hashString, type RaidSize } from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";
import type { ModuleContext } from "../../module.js";

export type FactionCfg = Manifest["factions"][number];

export const clamp = (v: number, lo: number, hi: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
export const round2 = (v: number): number => Math.round(v * 100) / 100;
export const round3 = (v: number): number => Math.round(v * 1000) / 1000;
export const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
export const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
export const humanise = (id: string): string => id.replace(/[_\-.]+/g, " ").trim();
/** Deterministic pick from a list. */
export const pickBy = <T>(list: readonly T[], seed: string): T => list[hashString(seed) % list.length];

/** Module options (manifest modules.factions.options), all optional. */
export interface FactionsOptions {
  /** LLM council upgrade on posture changes (Haiku, fast tier). Default true. */
  council: boolean;
  /** Minimum seconds between two LLM councils of the same faction. Default 30. */
  councilCooldownSec: number;
  /** A posture must hold this long before it may calm down (escalation is immediate). Default 20. */
  postureMinSec: number;
  /** Minutes of damage / threats the rules look back over. Default 10. */
  windowMin: number;
  /** Also put decisions on the Director timeline (lf.director.decision). Default true. */
  directorTimeline: boolean;
  /** Push custom.faction_posture / custom.guard_posts directives. Default true. */
  directives: boolean;
}

export function factionsOptions(ctx: Pick<ModuleContext, "options">): FactionsOptions {
  const o = ctx.options ?? {};
  const b = (k: string, d: boolean) => (typeof o[k] === "boolean" ? (o[k] as boolean) : d);
  return {
    council: b("council", true),
    councilCooldownSec: clamp(num(o.councilCooldownSec, 30), 0, 3600),
    postureMinSec: clamp(num(o.postureMinSec, 20), 0, 3600),
    windowMin: clamp(num(o.windowMin, 10), 1, 240),
    directorTimeline: b("directorTimeline", true),
    directives: b("directives", true),
  };
}

const GUARD_ROLE = /guard|captain|golem|watch|soldier|sentry|knight/i;

/** Everything the mind needs about one faction, resolved from the manifest with defaults. */
export interface ResolvedFaction {
  id: string;
  name: string;
  cfg: FactionCfg;
  /** Explicit members plus personas whose `faction` is this id. */
  members: string[];
  guards: string[];
  posts: string[];
  home?: string;
  mobs: string[];
  captains: string[];
  raidSize: RaidSize;
  priceRange: [number, number];
}

const resolvedCache = new WeakMap<Manifest, Map<string, ResolvedFaction>>();

export function resolveFactions(m: Manifest): Map<string, ResolvedFaction> {
  let map = resolvedCache.get(m);
  if (map) return map;
  map = new Map();
  for (const f of m.factions) {
    const members = [...new Set([...(f.members ?? []), ...m.personas.filter((p) => p.faction === f.id).map((p) => p.id)])];
    const guards = f.guards?.length
      ? f.guards.filter((g) => members.includes(g) || m.personas.some((p) => p.id === g))
      : members.filter((id) => GUARD_ROLE.test(m.personas.find((p) => p.id === id)?.role ?? ""));
    const [lo, hi] = m.clamps.npc.priceMultiplier;
    map.set(f.id, {
      id: f.id,
      name: f.name,
      cfg: f,
      members,
      guards,
      posts: f.posts?.length ? [...f.posts] : ["gate", "square", "well"],
      home: f.home,
      mobs: f.raid?.mobs?.length ? [...f.raid.mobs] : [...DEFAULT_RAID_MOBS],
      captains: f.raid?.captains?.length ? [...f.raid.captains] : ["Gravelmaw", "Old Rattlebones", "Mossjaw the Patient", "Captain Creepwick", "Lady Webweaver", "Sir Hollowbones"],
      raidSize: f.raid?.size ?? "medium",
      priceRange: [Math.max(lo, Math.min(f.priceRange[0], 1)), Math.min(hi, Math.max(f.priceRange[1], 1))],
    });
  }
  resolvedCache.set(m, map);
  return map;
}

/** npc id -> faction id (explicit members win over persona.faction). */
const memberCache = new WeakMap<Manifest, Map<string, string>>();
export function memberIndex(m: Manifest): Map<string, string> {
  let idx = memberCache.get(m);
  if (idx) return idx;
  idx = new Map();
  for (const p of m.personas) if (p.faction) idx.set(p.id, p.faction);
  for (const f of m.factions) for (const id of f.members ?? []) idx.set(id, f.id);
  memberCache.set(m, idx);
  return idx;
}

/** The faction an id refers to: a faction id, or a member's id. */
export function factionOfRef(m: Manifest, ref: unknown): string | undefined {
  const id = str(ref);
  if (!id) return undefined;
  if (m.factions.some((f) => f.id === id)) return id;
  return memberIndex(m).get(id);
}

/** The faction whose raid config a raid plan uses: the asked one, else the first with a raid block, else the first. */
export function raidFaction(m: Manifest, asked?: string): ResolvedFaction | undefined {
  const all = resolveFactions(m);
  if (asked && all.has(asked)) return all.get(asked);
  const withRaid = m.factions.find((f) => f.raid);
  return withRaid ? all.get(withRaid.id) : m.factions[0] ? all.get(m.factions[0].id) : undefined;
}

export const personaName = (m: Manifest, id: string): string => m.personas.find((p) => p.id === id)?.name ?? humanise(id);

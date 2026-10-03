// Projection "factions.mind" (world scope): one FactionMind per faction, folded deterministically from the log.
//   trust      <- lf.world.reputation (the World module's reputation events: one source of truth, not duplicated)
//   damage     <- world.property_damaged / world.destroyed / block.broken whose owner is a member (or in the home zone)
//   threats    <- combat.killed of a member, economy.stole from / social.threatened a member, lf.factions.threat
//   mood       <- gifts, help, trade, quest completions, repairs (+); damage, kills, thefts, grim rumours (-)
//   posture, priceMult, guards, history <- lf.factions.decision ; raids <- lf.factions.raid_plan
import { FACTION_POSTURES, RAID_SIZES, RAID_SPAWNS, type FactionMind, type FactionMindState, type FactionPosture, type StoredEvent } from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";
import type { Projection } from "../../module.js";
import { clamp, factionOfRef, num, resolveFactions, round3, str } from "./config.js";

const MOOD_HALF_LIFE_MS = 10 * 60_000;
const MAX_RECENT = 12;
const MAX_THREATS = 10;
const MAX_SEEN = 50;
const MAX_HISTORY = 30;
const MAX_RAIDS = 10;

/** Fields that may name the NPC / faction a signal is about. */
const REF_FIELDS = ["owner", "target", "to", "from", "vendor", "npc", "giver", "faction", "village"] as const;

export function freshMind(faction: string): FactionMind {
  return {
    faction,
    posture: "calm",
    priceMult: 1,
    trust: {},
    damage: { count: 0, value: 0, recent: [] },
    threats: [],
    guards: [],
    mood: 0,
    moodTs: 0,
    rumours: { count: 0, sentiment: 0 },
    seen: {},
    postureSince: 0,
    history: [],
    raids: [],
  };
}

function mindFor(s: FactionMindState, m: Manifest, id: string): FactionMind | null {
  if (!m.factions.some((f) => f.id === id)) return null;
  return (s.factions[id] ??= freshMind(id));
}

/** Which faction an SDK signal concerns: a named member / faction, else the home zone. */
export function factionOfEvent(m: Manifest, ev: StoredEvent): string | undefined {
  const d = ev.data;
  for (const k of REF_FIELDS) {
    const f = factionOfRef(m, d[k]);
    if (f) return f;
  }
  const zone = str(d.zone) || str(d.place);
  if (zone) for (const f of m.factions) if (f.home && f.home === zone) return f.id;
  return undefined;
}

function addMood(mind: FactionMind, ts: number, delta: number): void {
  const dt = Math.max(0, ts - (mind.moodTs || ts));
  mind.mood = round3(clamp(mind.mood * Math.pow(0.5, dt / MOOD_HALF_LIFE_MS) + delta, -1, 1));
  mind.moodTs = ts;
}

function noteSeen(mind: FactionMind, player: string | null, ts: number): void {
  if (!player) return;
  mind.seen[player] = ts;
  const keys = Object.keys(mind.seen);
  if (keys.length > MAX_SEEN) {
    keys.sort((a, b) => mind.seen[a] - mind.seen[b]);
    for (const k of keys.slice(0, keys.length - MAX_SEEN)) delete mind.seen[k];
  }
}

function addThreat(mind: FactionMind, t: FactionMind["threats"][number]): void {
  mind.threats.push(t);
  if (mind.threats.length > MAX_THREATS) mind.threats.splice(0, mind.threats.length - MAX_THREATS);
}

function addDamage(mind: FactionMind, ev: StoredEvent, object: string, owner: string | undefined, value: number): void {
  mind.damage.count += 1;
  mind.damage.value = round3(mind.damage.value + value);
  mind.damage.recent.push({ ts: ev.ts, player: ev.player, object: object.slice(0, 64), ...(owner ? { owner: owner.slice(0, 64) } : {}), value });
  if (mind.damage.recent.length > MAX_RECENT) mind.damage.recent.splice(0, mind.damage.recent.length - MAX_RECENT);
}

const phaseOf = (hour: number): string => (hour >= 5 && hour < 7 ? "dawn" : hour >= 7 && hour < 18 ? "day" : hour >= 18 && hour < 20 ? "dusk" : "night");
const isPosture = (v: unknown): v is FactionPosture => typeof v === "string" && (FACTION_POSTURES as readonly string[]).includes(v);

export const mindProjection: Projection<FactionMindState> = {
  name: "factions.mind",
  scope: "world",
  version: 1,
  types: [
    "world.*", "combat.killed", "social.*", "economy.*", "quest.completed", "block.*",
    "lf.quests.completed", "lf.world.rumour", "lf.world.reputation", "lf.factions.*",
  ],
  init: (_key, m) => ({ factions: Object.fromEntries(m.factions.map((f) => [f.id, freshMind(f.id)])) }),
  apply(s, ev, env) {
    const m = env.manifest;
    if (!m.factions.length) return;
    s.factions ??= {};
    const d = ev.data;

    // ---- module + world events
    if (ev.type === "lf.world.reputation") {
      const mind = mindFor(s, m, str(d.faction));
      const player = ev.player ?? (str(d.player) || null);
      if (!mind || !player) return;
      const base = mind.trust[player] ?? m.factions.find((f) => f.id === mind.faction)?.attitude ?? 0;
      mind.trust[player] = round3(clamp(typeof d.set === "number" ? d.set : base + num(d.delta, 0), -1, 1));
      return;
    }
    if (ev.type === "lf.factions.decision") {
      const mind = mindFor(s, m, str(d.faction));
      if (!mind || !isPosture(d.posture)) return;
      const priceMult = num(d.priceMult, mind.priceMult);
      if (mind.posture !== d.posture) mind.postureSince = ev.ts;
      const changed = mind.posture !== d.posture || Math.abs(mind.priceMult - priceMult) >= 0.01;
      mind.posture = d.posture;
      mind.priceMult = round3(priceMult);
      if (Array.isArray(d.guards)) {
        mind.guards = (d.guards as { npc?: unknown; post?: unknown }[])
          .filter((g) => str(g?.npc) && str(g?.post))
          .map((g) => ({ npc: str(g.npc).slice(0, 64), post: str(g.post).slice(0, 64) }));
      }
      const why = str(d.why).slice(0, 300);
      const source = str(d.source).slice(0, 16) || "rules";
      mind.lastPlan = {
        ts: ev.ts, kind: "council", summary: str(d.summary).slice(0, 200) || `${d.posture}, prices x${mind.priceMult}`, why, source,
        ...(str(d.model) ? { model: str(d.model).slice(0, 64) } : {}),
        posture: d.posture, priceMult: mind.priceMult,
        ...(str(d.announcement) ? { announcement: str(d.announcement).slice(0, 200) } : {}),
      };
      if (changed || source !== "rules") {
        mind.history.push({ ts: ev.ts, posture: d.posture, priceMult: mind.priceMult, why, source });
        if (mind.history.length > MAX_HISTORY) mind.history.splice(0, mind.history.length - MAX_HISTORY);
      }
      return;
    }
    if (ev.type === "lf.factions.raid_plan") {
      const mind = mindFor(s, m, str(d.faction));
      const plan = d.plan as Record<string, unknown> | undefined;
      if (!mind || !plan || !Array.isArray(plan.waves)) return;
      const size = (RAID_SIZES as readonly string[]).includes(str(plan.size)) ? (str(plan.size) as (typeof RAID_SIZES)[number]) : "medium";
      const waves = (plan.waves as Record<string, unknown>[]).map((w) => ({
        mob: str(w.mob), count: Math.max(1, Math.round(num(w.count, 1))), tactic: str(w.tactic),
        spawn: ((RAID_SPAWNS as readonly string[]).includes(str(w.spawn)) ? str(w.spawn) : "edge") as (typeof RAID_SPAWNS)[number],
      }));
      const counters = Array.isArray(plan.counters) ? (plan.counters as Record<string, unknown>[]).map((c) => ({ habit: str(c.habit), tactic: str(c.tactic), why: str(c.why) })) : [];
      const cap = plan.captain as { name?: unknown; taunt?: unknown } | undefined;
      const source = str(d.source).slice(0, 16) || "rules";
      const why = str(plan.why).slice(0, 300);
      mind.raids.push({
        ts: ev.ts, player: ev.player ?? (str(d.player) || null), ...(typeof plan.night === "number" ? { night: Math.round(plan.night) } : {}),
        size, waves, counters, ...(cap && str(cap.name) ? { captain: { name: str(cap.name), taunt: str(cap.taunt) } } : {}), why, source,
      });
      if (mind.raids.length > MAX_RAIDS) mind.raids.splice(0, mind.raids.length - MAX_RAIDS);
      const total = waves.reduce((n, w) => n + w.count, 0);
      mind.lastPlan = {
        ts: ev.ts, kind: "raid", summary: `raid: ${waves.length} wave(s), ${total} mobs (${waves.map((w) => `${w.count} ${w.mob}`).join(", ")})`.slice(0, 200),
        why, source, ...(str(d.model) ? { model: str(d.model).slice(0, 64) } : {}),
      };
      return;
    }
    if (ev.type === "lf.factions.threat") {
      const mind = mindFor(s, m, str(d.faction));
      if (!mind) return;
      addThreat(mind, { kind: str(d.kind).slice(0, 32) || "threat", source: str(d.source).slice(0, 64) || "unknown", level: clamp(num(d.level, 0.5), 0, 1), ts: ev.ts, ...(str(d.note) ? { note: str(d.note).slice(0, 160) } : {}) });
      addMood(mind, ev.ts, -0.1 * clamp(num(d.level, 0.5), 0, 1));
      return;
    }
    if (ev.type === "lf.world.rumour") {
      const r = d.rumour as { about?: { player?: string }; knownBy?: string[]; heat?: number } | undefined;
      const sentiment = num(d.sentiment, 0);
      if (!r?.about?.player || !sentiment) return;
      const idx = resolveFactions(m);
      for (const [fid, rf] of idx) {
        const knows = (r.knownBy ?? []).some((n) => rf.members.includes(n));
        if (!knows) continue;
        const mind = mindFor(s, m, fid)!;
        mind.rumours.count += 1;
        mind.rumours.sentiment = round3(mind.rumours.sentiment + sentiment * num(r.heat, 0.5));
        addMood(mind, ev.ts, clamp(0.12 * sentiment * num(r.heat, 0.5), -0.15, 0.15));
      }
      return;
    }
    if (ev.type === "lf.quests.completed") {
      const mind = mindFor(s, m, factionOfRef(m, d.giver) ?? "");
      if (!mind) return;
      addMood(mind, ev.ts, 0.15);
      noteSeen(mind, ev.player, ev.ts);
      return;
    }
    if (ev.type.startsWith("lf.")) return;

    // ---- world clock (applies to every faction)
    if (ev.type === "world.time") {
      const hour = num(d.hour, NaN);
      const phase = str(d.phase) || (Number.isFinite(hour) ? phaseOf(hour) : "");
      for (const f of m.factions) {
        const mind = mindFor(s, m, f.id)!;
        if (phase) mind.phase = phase.slice(0, 16);
        if (typeof d.day === "number") mind.day = Math.round(d.day);
      }
      return;
    }

    // ---- SDK signals about a faction
    const fid = factionOfEvent(m, ev);
    if (!fid) return;
    const mind = mindFor(s, m, fid);
    if (!mind) return;
    const raidMobs = resolveFactions(m).get(fid)?.mobs ?? [];
    switch (ev.type) {
      case "world.property_damaged":
      case "world.destroyed": {
        if (ev.type === "world.destroyed" && !str(d.owner)) return;
        const value = Math.max(0, num(d.value, 10));
        addDamage(mind, ev, str(d.object) || "property", str(d.owner) || undefined, value);
        addMood(mind, ev.ts, -clamp(0.04 + value / 500, 0.04, 0.2));
        break;
      }
      case "block.broken": {
        if (!str(d.owner)) return; // only blocks inside someone's house count as damage
        const value = Math.max(0, num(d.value, 2));
        addDamage(mind, ev, str(d.block) || "block", str(d.owner), value);
        addMood(mind, ev.ts, -0.03);
        break;
      }
      case "block.placed": {
        // repairs / building for the village
        addMood(mind, ev.ts, 0.01);
        break;
      }
      case "combat.killed": {
        const target = str(d.target);
        const ttype = str(d.target_type);
        if (factionOfRef(m, target) === fid || factionOfRef(m, ttype) === fid) {
          addThreat(mind, { kind: "killer", source: ev.player ?? "unknown", level: 1, ts: ev.ts, note: `killed ${target || ttype}`.slice(0, 160) });
          addMood(mind, ev.ts, -0.5);
        } else if (raidMobs.includes(ttype) || raidMobs.includes(target)) {
          addMood(mind, ev.ts, 0.03); // defended the village
        } else return;
        break;
      }
      case "social.threatened":
        addThreat(mind, { kind: "threat", source: ev.player ?? "unknown", level: 0.5, ts: ev.ts, note: `threatened ${str(d.target)}`.slice(0, 160) });
        addMood(mind, ev.ts, -0.1);
        break;
      case "economy.stole":
        if (d.seen === false) return;
        addThreat(mind, { kind: "thief", source: ev.player ?? "unknown", level: 0.6, ts: ev.ts, note: `stole from ${str(d.from)}`.slice(0, 160) });
        addMood(mind, ev.ts, -0.15);
        break;
      case "social.gave":
        addMood(mind, ev.ts, 0.08);
        break;
      case "world.helped":
        addMood(mind, ev.ts, 0.1);
        break;
      case "economy.bought":
      case "economy.sold":
        addMood(mind, ev.ts, 0.02);
        break;
      case "quest.completed":
        addMood(mind, ev.ts, 0.05);
        break;
      default:
        return;
    }
    noteSeen(mind, ev.player, ev.ts);
  },
};

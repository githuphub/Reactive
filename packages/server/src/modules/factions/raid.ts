// Ask "faction.raid_plan": a night raid that counters how this player plays.
// Instant (rules): habits -> counter-table -> waves sized by raid size, Director aggression and night number, a
// captain whose taunt names the habit, and a why. Upgrade (Haiku): the same shape as structured output, clamped
// to the faction's mob ids and the size limits. Both record lf.factions.raid_plan, a Director timeline entry and
// a Brain entry.
import {
  RAID_SIZE_LIMITS, clampRaidPlan, defaultRaidPlan, raidPlanJsonSchema,
  type AskParams, type AskResult, type RaidCounter, type RaidSize, type RaidSpawn, type RaidWave,
} from "@liveforge/protocol";
import type { AskContext, AskHandler } from "../../module.js";
import { isReplayModel, modelBadge } from "../../providers/cassette.js";
import { clamp, factionsOptions, pickBy, raidFaction, round2, type ResolvedFaction } from "./config.js";
import { brain, mindOf } from "./council.js";
import { readHabits, type Habit, type HabitRead } from "./habits.js";

type Params = AskParams<"faction.raid_plan">;
type Result = AskResult<"faction.raid_plan">;

interface CounterDef {
  waves: { mob: string; alt?: string; tactic: string; spawn: RaidSpawn; share: number }[];
  tactic: string;
  why: string;
  /** Taunt vocabulary. */
  noun: string;
  ing: string;
  counter: string;
}

/** The counter-table (docs/factions.md). */
export const COUNTER_TABLE: Record<Habit, CounterDef> = {
  pillaring: {
    waves: [
      { mob: "spider", tactic: "climb", spawn: "edge", share: 0.55 },
      { mob: "skeleton", tactic: "crossfire", spawn: "rooftops", share: 0.45 },
    ],
    tactic: "climbing spiders + skeleton crossfire", why: "spiders climb pillars; skeletons shoot from two sides",
    noun: "pillar", ing: "pillaring", counter: "climbers and crossfire",
  },
  bow_heavy: {
    waves: [
      { mob: "zombie", tactic: "shield_rush", spawn: "edge", share: 0.7 },
      { mob: "baby_zombie", alt: "zombie", tactic: "rush", spawn: "behind_player", share: 0.3 },
    ],
    tactic: "shielded zombies + rush", why: "shields soak arrows and a rush closes the range",
    noun: "bow", ing: "shooting", counter: "shields",
  },
  hiding: {
    waves: [
      { mob: "creeper", tactic: "tunnel", spawn: "underground", share: 0.65 },
      { mob: "zombie", tactic: "dig_in", spawn: "edge", share: 0.35 },
    ],
    tactic: "creepers tunnel underground", why: "creepers dig straight to whoever hides in a hole",
    noun: "hole", ing: "hiding", counter: "tunnellers",
  },
  melee_heavy: {
    waves: [
      { mob: "skeleton", tactic: "keep_distance", spawn: "rooftops", share: 0.7 },
      { mob: "spider", tactic: "harass", spawn: "edge", share: 0.3 },
    ],
    tactic: "skeletons keep their distance", why: "skeletons stay out of sword reach",
    noun: "sword arm", ing: "swinging", counter: "archers who never come close",
  },
  kiting: {
    waves: [
      { mob: "baby_zombie", alt: "zombie", tactic: "run_down", spawn: "behind_player", share: 0.6 },
      { mob: "spider", tactic: "cut_off", spawn: "edge", share: 0.4 },
    ],
    tactic: "fast baby zombies", why: "baby zombies are faster than a sprinting player",
    noun: "running legs", ing: "running", counter: "little runners",
  },
  fire: {
    waves: [
      { mob: "zombie", tactic: "fire_resistant", spawn: "edge", share: 0.6 },
      { mob: "skeleton", tactic: "spread_out", spawn: "rooftops", share: 0.4 },
    ],
    tactic: "fire-resistant, spread out", why: "they arrive soaked and spread out so fire and lava catch fewer",
    noun: "fire", ing: "burning", counter: "soaked skins",
  },
};

const TAUNTS = [
  "All that {ing} won't save you tonight, {player}.",
  "We watched your {noun}, {player}. Tonight we answer it with {counter}.",
  "Keep {ing}, {player}. My {mob}s are counting on it.",
  "Your {noun} again? How predictable. Meet my {counter}.",
  "Every night the same {ing}. Every night we learn. Tonight: {counter}.",
  "{village} hides behind your {noun}? Not for long.",
  "Hear that, {player}? That's {counter}. They don't care about your {noun}.",
];
const TAUNTS_PLAIN = [
  "No tricks yet, {player}? Then we come from everywhere.",
  "Sleep well, {village}. We won't.",
  "Tonight we test you, {player}. Tomorrow we know you.",
];

const fill = (t: string, v: Record<string, string>) => t.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? "");

/** Director aggression (0-1) of the world; 0.5 when the Director is off. */
function aggressionOf(ctx: AskContext): number {
  try {
    return clamp(ctx.projections.get("director.state", { world: ctx.world })?.aggression ?? 0.5, 0, 1);
  } catch {
    return 0.5;
  }
}

/** Rules raid plan from habits (exported for routes / tests of the counter-table). */
export function rulesRaid(rf: ResolvedFaction, habits: HabitRead[], o: { player: string; night: number; size: RaidSize; aggression: number }): Result {
  const lim = RAID_SIZE_LIMITS[o.size];
  const scale = (0.55 + 0.45 * o.aggression) * (1 + Math.min(0.5, 0.08 * Math.max(0, o.night - 1)));
  const total = clamp(Math.round(lim.total * scale), Math.min(lim.total, 2), lim.total);
  const top = habits.filter((h) => h.score >= 0.25).slice(0, 2);
  const mobOk = (mob: string, alt?: string) => (rf.mobs.includes(mob) ? mob : alt && rf.mobs.includes(alt) ? alt : rf.mobs[0]);

  if (!top.length) {
    const base = defaultRaidPlan(rf.mobs, o.size);
    const captainName = pickBy(rf.captains, `${o.player}:${o.night}`);
    const taunt = fill(pickBy(TAUNTS_PLAIN, `${o.player}:${o.night}:plain`), { player: o.player, village: rf.name });
    return { ...base, captain: { name: captainName, taunt }, why: `no strong habit read for ${o.player} yet: a mixed raid (aggression ${o.aggression.toFixed(2)}, night ${o.night})`, faction: rf.id, night: o.night, size: o.size, aggression: round2(o.aggression), habits: habits.slice(0, 3) };
  }

  // budget per habit by score, then per wave by share; one filler wave if room is left
  const sum = top.reduce((n, h) => n + h.score, 0);
  const waves: RaidWave[] = [];
  const counters: RaidCounter[] = [];
  let used = 0;
  for (const h of top) {
    const def = COUNTER_TABLE[h.habit];
    const budget = Math.max(1, Math.round((total * h.score) / sum));
    counters.push({ habit: h.habit, tactic: def.tactic, why: `${h.evidence}: ${def.why}`.slice(0, 200) });
    for (const w of def.waves) {
      if (waves.length >= lim.waves || used >= total) break;
      const count = Math.min(lim.perWave, total - used, Math.max(1, Math.round(budget * w.share)));
      waves.push({ mob: mobOk(w.mob, w.alt), count, tactic: w.tactic, spawn: w.spawn, delaySec: waves.length * 20 });
      used += count;
    }
  }
  if (waves.length < lim.waves && used < total) {
    const mob = rf.mobs.includes("zombie") ? "zombie" : rf.mobs[0];
    waves.push({ mob, count: Math.min(lim.perWave, total - used), tactic: "rush", spawn: "edge", delaySec: waves.length * 20 });
  }
  const lead = COUNTER_TABLE[top[0].habit];
  const captainName = pickBy(rf.captains, `${o.player}:${o.night}`);
  const taunt = fill(pickBy(TAUNTS, `${o.player}:${o.night}:${top[0].habit}`), {
    player: o.player, village: rf.name, noun: lead.noun, ing: lead.ing, counter: lead.counter, mob: waves[0]?.mob ?? "zombie",
  });
  const why = `${o.player}: ${top.map((h) => `${h.habit.replace(/_/g, " ")} (${h.evidence})`).join(" + ")} → ${top.map((h) => COUNTER_TABLE[h.habit].tactic).join("; ")}; aggression ${o.aggression.toFixed(2)}, night ${o.night}, ${o.size}`;
  return {
    waves, counters, captain: { name: captainName, taunt: taunt.slice(0, 200) }, why: why.slice(0, 300),
    faction: rf.id, night: o.night, size: o.size, aggression: round2(o.aggression), habits: habits.slice(0, 4),
  };
}

function recordPlan(ctx: AskContext, rf: ResolvedFaction, player: string, plan: Result, source: string, model: string | null, ms?: number): void {
  const total = plan.waves.reduce((n, w) => n + w.count, 0);
  const summary = `raid night ${plan.night ?? "?"}: ${plan.waves.map((w) => `${w.count} ${w.mob} (${w.tactic}, ${w.spawn})`).join(", ")}`.slice(0, 200);
  ctx.record("lf.factions.raid_plan", { faction: rf.id, player, plan, source, model }, { player });
  if (factionsOptions(ctx).directorTimeline) {
    ctx.record("lf.director.decision", {
      decision: { ts: ctx.now(), kind: "raid_plan", summary, why: (source === "replay" ? `${plan.why} (replay)` : plan.why).slice(0, 300), source: source === "rules" ? "rules" : "ai", data: { faction: rf.id, player, waves: plan.waves.length, mobs: total, model } },
    }, { player });
  }
  const badge = source === "rules" ? "rules" : modelBadge(model);
  if (plan.habits?.length && source === "rules") {
    brain(ctx, { ref: ctx.askId, source: "factions", actor: rf.id, kind: "thought", text: `Threat model for ${player}: ${plan.habits.map((h) => `${h.habit} ${h.score.toFixed(2)} (${h.evidence})`).join("; ")}`, data: { player, habits: plan.habits }, model: "rules" });
  }
  brain(ctx, { ref: ctx.askId, source: "factions", actor: rf.id, kind: "plan", text: `${summary}${plan.captain ? ` · ${plan.captain.name}: "${plan.captain.taunt}"` : ""}`, data: { player, plan }, model: badge, ...(ms !== undefined ? { ms } : {}) });
  brain(ctx, { ref: ctx.askId, source: "factions", actor: rf.id, kind: "decision", text: `why: ${plan.why}`, data: { player, counters: plan.counters }, model: badge });
}

export const raidPlanAsk: AskHandler<"faction.raid_plan"> = {
  instant(ctx, params: Params) {
    const m = ctx.manifest;
    const rf = raidFaction(m, params.faction);
    const player = params.player ?? ctx.player ?? "player";
    if (!rf) return { result: defaultRaidPlan(undefined, params.size), why: "no factions declared: a plain mixed raid", final: true };
    const mind = mindOf(ctx, ctx.world, rf.id);
    const night = params.night ?? mind.day ?? 1;
    const size = params.size ?? rf.raidSize;
    const habits = readHabits(ctx, ctx.world, player);
    const plan = rulesRaid(rf, habits, { player, night, size, aggression: aggressionOf(ctx) });
    recordPlan(ctx, rf, player, plan, "rules", null);
    return { result: plan, why: plan.why };
  },

  async upgrade(ctx, params: Params, instant: Result) {
    const llm = ctx.llm;
    if (!llm) return null;
    const m = ctx.manifest;
    const rf = raidFaction(m, params.faction);
    if (!rf) return null;
    const player = params.player ?? ctx.player ?? "player";
    const size = instant.size ?? params.size ?? rf.raidSize;
    const lim = RAID_SIZE_LIMITS[size];
    const habits = instant.habits ?? [];
    const system = [
      `You plan tonight's monster raid on ${rf.name}. The monsters learn: every raid counters how this player plays.`,
      `World lore:\n${m.lore.bible.slice(0, 2500)}`,
      `Tone: ${m.lore.tone}. Content rating ${m.safety.rating}; keep it a game, no gore.`,
      `Mobs you may use: ${rf.mobs.join(", ")}. Spawn points: edge (village edge), underground (tunnel up), behind_player, rooftops.`,
      `Limits for a ${size} raid: at most ${lim.waves} waves, ${lim.perWave} mobs per wave, ${lim.total} mobs in total.`,
      `Tactics are short snake_case ids the game understands, e.g. climb, crossfire, shield_rush, rush, tunnel, keep_distance, run_down, flank, spread_out, fire_resistant, harass.`,
      `Counter-table (use it, you may improve it): pillaring -> climbing spiders + skeleton crossfire; bow_heavy -> shielded zombies + rush; hiding -> creepers tunnel underground; melee_heavy -> skeletons keep distance; kiting -> fast baby zombies; fire -> fire-resistant tactic.`,
      `Every counter names the habit it punishes. The captain's taunt (max 140 characters) names the habit. why: max 200 characters.`,
    ].join("\n\n");
    const user = [
      `Player ${player}. Habits (strongest first): ${habits.length ? habits.map((h) => `${h.habit} ${h.score.toFixed(1)} (${h.evidence})`).join("; ") : "none known yet"}.`,
      `Night ${instant.night ?? 1}; Director aggression ${(instant.aggression ?? 0.5).toFixed(1)}; size ${size}.`,
      `Rules draft: ${JSON.stringify({ waves: instant.waves.map(({ delaySec: _d, ...w }) => w), counters: instant.counters, captain: instant.captain })}`,
      `Write the final plan.`,
    ].join("\n");
    const r = await llm.json<unknown>(raidPlanJsonSchema(rf.mobs), system, user, { tier: "fast", task: "faction.raid_plan", maxTokens: 700, signal: ctx.signal });
    const plan = clampRaidPlan(r.value, { mobs: rf.mobs, size });
    if (!plan) return null;
    if (plan.captain) {
      const mod = await ctx.moderation.check(plan.captain.taunt, { direction: "output", manifest: m });
      if (!mod.ok) plan.captain = instant.captain;
    } else if (instant.captain) plan.captain = instant.captain;
    plan.waves.forEach((w, i) => (w.delaySec ??= i * 20));
    const source = isReplayModel(r.model) ? "replay" : "ai";
    const result: Result = { ...plan, faction: rf.id, night: instant.night, size, aggression: instant.aggression, habits: instant.habits, why: plan.why };
    recordPlan(ctx, rf, player, result, source, r.model, r.ms);
    return { result, why: `${plan.why} (${source === "replay" ? "replay" : r.model}, ${r.ms}ms)`.slice(0, 300) };
  },

  /** Same habits + night + size -> same plan (the habit read is part of the key, so a new habit re-plans). */
  cacheKey(params: Params, ctx: AskContext) {
    const player = params.player ?? ctx.player ?? "player";
    const habits = readHabits(ctx, ctx.world, player).filter((h) => h.score >= 0.25).slice(0, 2).map((h) => h.habit);
    return { faction: params.faction ?? null, player, night: params.night ?? null, size: params.size, habits, aggression: Math.round(aggressionOf(ctx) * 10) };
  },
  cacheTtlSec: 1800,
};

// Dynamic objectives inside encounters (spec §3.6): a short challenge with a DSL condition, a reward and an expiry,
// pushed as an `objective.dynamic` directive. Triggered by Director decisions (lf.director.decision), by moments
// (comeback / near-death) or by the game (route). Conditions are evaluated with windows clipped to the start time.
// "reach" objectives complete as soon as the condition holds; "keep" objectives fail the moment it breaks and
// complete at expiry. Results are pushed as `quest.update` with questId = objective id.
import { checkDsl, type Moment, type StoredEvent } from "@liveforge/protocol";
import type { EventContext, ModuleContext, ScopedContext, TickContext } from "../../module.js";
import { evalCondition, makeDslEnv } from "../world/dsl.js";
import { clamp, clip, numOr, opt, pick, rngFrom, scopeFor, shortId, str, throttle } from "../world/util.js";
import { questLog, type DynamicObjective } from "./log.js";

interface ObjectiveTemplate {
  /** Trait this challenges (stretch goals pick templates the player does NOT lean on). */
  counters?: string;
  text: (s: number) => string;
  condition: (s: number) => string;
  mode: DynamicObjective["mode"];
  seconds: number;
  weight: number;
}

const BOSS: ObjectiveTemplate[] = [
  { text: (s) => `Take no damage for ${s} seconds`, condition: (s) => `count(combat.hurt, ${s}s) == 0`, mode: "keep", seconds: 30, weight: 1.2, counters: "berserker" },
  { text: (s) => `Block or parry 4 attacks in ${s} seconds`, condition: (s) => `count(combat.blocked, ${s}s) + count(combat.parried, ${s}s) >= 4`, mode: "reach", seconds: 30, weight: 1, counters: "dodger" },
  { text: (s) => `Dodge 6 attacks in ${s} seconds`, condition: (s) => `count(combat.dodged, ${s}s) >= 6`, mode: "reach", seconds: 30, weight: 1, counters: "turtle" },
  { text: (s) => `Land 12 hits in ${s} seconds`, condition: (s) => `count(combat.hit, ${s}s) >= 12`, mode: "reach", seconds: 25, weight: 1, counters: "ranged_camper" },
];
const ENCOUNTER: ObjectiveTemplate[] = [
  { text: (s) => `Defeat 4 enemies in ${s} seconds`, condition: (s) => `count(combat.killed, ${s}s) >= 4`, mode: "reach", seconds: 30, weight: 1, counters: "pacifist" },
  { text: (s) => `Win without using an ability for ${s} seconds`, condition: (s) => `count(combat.ability_used, ${s}s) == 0`, mode: "keep", seconds: 40, weight: 0.8, counters: "glass_cannon" },
  { text: (s) => `Stay in the fight: no fleeing for ${s} seconds`, condition: (s) => `count(movement.fled, ${s}s) == 0`, mode: "keep", seconds: 45, weight: 0.8, counters: "speedrunner" },
];
const COMEBACK: ObjectiveTemplate[] = [
  { text: (s) => `Second wind: defeat 3 enemies in ${s} seconds`, condition: (s) => `count(combat.killed, ${s}s) >= 3`, mode: "reach", seconds: 25, weight: 1.2 },
  { text: (s) => `Catch your breath: no damage for ${s} seconds`, condition: (s) => `count(combat.hurt, ${s}s) == 0`, mode: "keep", seconds: 20, weight: 0.8 },
];

/** Reward inside the manifest reward types / budgets (small: these are minute-long challenges). */
function rewardFor(m: ModuleContext["manifest"], weight: number): DynamicObjective["reward"] {
  const types = m.quests.rewardTypes;
  if (types.includes("gold")) return { type: "gold", amount: Math.max(1, Math.round(m.quests.rewards.goldMax * 0.05 * weight)) };
  if (types.includes("xp")) return { type: "xp", amount: Math.max(1, Math.round(m.quests.rewards.xpMax * 0.05 * weight)) };
  if (types.includes("item")) return { type: "item", id: "forge.loot" };
  return { type: types[0] ?? "xp" };
}

export interface ObjectiveRequest {
  trigger: string;
  text?: string;
  condition?: string;
  mode?: DynamicObjective["mode"];
  expiresInSec?: number;
  reward?: DynamicObjective["reward"];
}

/**
 * Start a dynamic objective for a player (at most one active; cooldown options.objectiveCooldownSec, default 45).
 * With `condition` the caller's DSL is used (validated); otherwise a template matching the trigger is picked,
 * preferring challenges that stretch the player's style. Returns the objective or null with a reason.
 */
export function startObjective(ctx: ScopedContext, player: string, req: ObjectiveRequest): { objective: DynamicObjective | null; why: string } {
  const m = ctx.manifest;
  const now = ctx.now();
  const log = questLog(ctx, ctx.world, player);
  if (log.objectives.some((o) => o.status === "active" && o.expiresAt > now)) return { objective: null, why: "an objective is already active" };
  const cdKey = `obj:${ctx.world}:${player}`;
  const cooldown = opt(ctx, "objectiveCooldownSec", 45) * 1000;
  if (now - (ctx.kv.get<number>(cdKey) ?? 0) < cooldown && !req.condition) return { objective: null, why: "objective cooldown" };

  let text: string;
  let condition: string;
  let mode: DynamicObjective["mode"];
  let seconds: number;
  let weight = 1;
  if (req.condition) {
    const err = checkDsl(req.condition);
    if (err) return { objective: null, why: `invalid condition: ${err}` };
    condition = req.condition.slice(0, 300);
    text = clip(req.text || "Complete the challenge", 200);
    mode = req.mode ?? "reach";
    seconds = clamp(numOr(req.expiresInSec, 45), 5, 600);
  } else {
    const list = req.trigger.includes("boss") ? BOSS : req.trigger.startsWith("moment") ? COMEBACK : ENCOUNTER;
    const env = makeDslEnv(ctx, ctx.world, player);
    const trait = (t?: string) => (t ? numOr(env.call("trait", [t]), 0) : 0);
    // Stretch: prefer templates whose countered trait the player shows (push them out of their habit).
    const ranked = [...list].sort((a, b) => trait(b.counters) - trait(a.counters));
    const top = ranked.filter((t) => trait(t.counters) === trait(ranked[0].counters));
    const tpl = pick(top, rngFrom(`${player}:${now}`))!;
    seconds = clamp(numOr(req.expiresInSec, tpl.seconds), 5, 600);
    text = req.text ? clip(req.text, 200) : tpl.text(seconds);
    condition = tpl.condition(seconds);
    mode = req.mode ?? tpl.mode;
    weight = tpl.weight;
  }
  const reward = req.reward && m.quests.rewardTypes.includes(req.reward.type)
    ? { type: req.reward.type, ...(req.reward.id ? { id: req.reward.id } : {}), ...(typeof req.reward.amount === "number" ? { amount: clamp(req.reward.amount, 0, req.reward.type === "gold" ? m.quests.rewards.goldMax : m.quests.rewards.xpMax) } : {}) }
    : rewardFor(m, weight);
  const objective: DynamicObjective = {
    id: shortId("obj", `${ctx.world}:${player}:${now}`), text, condition, reward, mode,
    startedAt: now, expiresAt: now + seconds * 1000, status: "active", trigger: req.trigger.slice(0, 64),
  };
  ctx.kv.set(cdKey, now);
  ctx.record("lf.quests.objective", { objective }, { player });
  ctx.emit({
    kind: "objective.dynamic", target: "ui",
    args: { id: objective.id, text, condition, reward, expiresInSec: seconds },
    why: clip(`${req.trigger}: ${mode === "keep" ? "keep" : "reach"} ${condition}`, 200),
  }, { player });
  return { objective, why: `started from ${req.trigger}` };
}

function end(ctx: ScopedContext, player: string, o: DynamicObjective, status: DynamicObjective["status"], why: string): void {
  const done: DynamicObjective = { ...o, status, endedAt: ctx.now() };
  ctx.record("lf.quests.objective", { objective: done }, { player });
  ctx.emit({ kind: "quest.update", target: "ui", args: { questId: o.id, status: status === "active" ? "active" : status }, why: clip(why, 200) }, { player });
}

/** Evaluate the player's active objective(s). */
export function checkObjectives(ctx: ScopedContext, player: string): void {
  const now = ctx.now();
  for (const o of questLog(ctx, ctx.world, player).objectives) {
    if (o.status !== "active") continue;
    const r = evalCondition(ctx, ctx.world, player, o.condition, { notBefore: o.startedAt });
    if (r.error) {
      end(ctx, player, o, "failed", `condition error: ${r.error}`);
      continue;
    }
    if (o.mode === "reach") {
      if (r.ok) end(ctx, player, o, "completed", `${o.text}: done`);
      else if (now >= o.expiresAt) end(ctx, player, o, "expired", `${o.text}: out of time`);
    } else {
      if (!r.ok) end(ctx, player, o, "failed", `${o.text}: broken`);
      else if (now >= o.expiresAt) end(ctx, player, o, "completed", `${o.text}: held to the end`);
    }
  }
}

/** Signal handler: Director decisions and comeback moments start objectives; combat signals re-check them. */
export function onObjectiveSource(ctx: EventContext, ev: StoredEvent): void {
  const player = ev.player ?? (str(ev.data.player) || null);
  if (!player || opt(ctx, "dynamicObjectives", true) === false) return;
  const sc = ev.player ? ctx : scopeFor(ctx, ctx.world, player);
  if (ev.type === "lf.director.decision") {
    const d = (ev.data.decision ?? {}) as { kind?: string; data?: Record<string, unknown> };
    const kind = str(d.kind);
    const action = str(d.data?.action);
    if (kind === "boss_phase" || kind === "encounter" || (kind === "pacing" && (action === "spawn" || action === "escalate"))) startObjective(sc, player, { trigger: `director:${kind}` });
    return;
  }
  if (ev.type === "lf.observer.moment") {
    const mo = ev.data.moment as Moment | undefined;
    if (mo && (mo.kind === "comeback" || mo.kind === "near_death_escape")) startObjective(sc, player, { trigger: `moment:${mo.kind}` });
    return;
  }
  if (!throttle(`quests:obj:${ctx.game}:${ctx.world}:${player}`, 300, ctx.now())) return;
  if (questLog(ctx, ctx.world, player).objectives.some((o) => o.status === "active")) checkObjectives(sc, player);
}

/** Tick: expiries and time-based conditions. */
export function objectiveTick(ctx: TickContext): void {
  for (const player of ctx.activePlayers.slice(0, 200)) {
    if (!questLog(ctx, ctx.world, player).objectives.some((o) => o.status === "active")) continue;
    checkObjectives(scopeFor(ctx, ctx.world, player), player);
  }
}

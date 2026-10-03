// Adaptive difficulty (spec §3.4): aggression 0-1 inside the designer's bounds (manifest clamps.difficulty), moved
// at most maxStep per adjustment. Modes: hidden (adapts silently to how the player is doing), assist (explicit,
// player-chosen: pinned low and announced), off (fixed). Every change is a `difficulty.set` directive with a why.
import type { ScopedContext } from "../../module.js";
import { directorOptions } from "./options.js";
import { directorState, recordDecision } from "./state.js";

export type DifficultyMode = "hidden" | "assist" | "off";

/** Minimum time between two hidden adjustments of a world. */
const ADJUST_EVERY_MS = 20_000;
const LOOKBACK_MS = 5 * 60_000;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Current aggression of the world, within the designer bounds. */
export function currentAggression(ctx: ScopedContext): number {
  const d = ctx.manifest.clamps.difficulty;
  return clamp(directorState(ctx).aggression, d.aggressionMin, d.aggressionMax);
}

/** Effective mode: an assist toggle (state) overrides the manifest's mode. */
export function currentMode(ctx: ScopedContext): DifficultyMode {
  return directorState(ctx).difficultyMode ?? ctx.manifest.clamps.difficulty.mode;
}

/** Apply a new aggression / mode: event + timeline + directive. Returns the applied aggression. */
export function setDifficulty(ctx: ScopedContext, next: { aggression: number; mode: DifficultyMode; why: string; player?: string | null }): number {
  const d = ctx.manifest.clamps.difficulty;
  const prev = currentAggression(ctx);
  const aggression = r2(clamp(next.aggression, d.aggressionMin, d.aggressionMax));
  ctx.record("lf.director.difficulty", { aggression, mode: next.mode });
  recordDecision(ctx, {
    kind: "difficulty", source: "rules",
    summary: `aggression ${prev.toFixed(2)} -> ${aggression.toFixed(2)} (${next.mode})`, why: next.why,
    data: { aggression, mode: next.mode },
  });
  ctx.emit({ kind: "difficulty.set", target: "world", args: { aggression, mode: next.mode, reason: next.why.slice(0, 200) }, why: next.why.slice(0, 200) }, { world: ctx.world, player: next.player ?? null });
  return aggression;
}

/**
 * Hidden-mode adjustment from the last five minutes of the world's combat: deaths and near-deaths pull aggression
 * down, clean kills without damage push it up. Moves at most maxStep, at most every 20 s. Returns the new value
 * (or the old one when nothing changed).
 */
export function adaptDifficulty(ctx: ScopedContext, players: string[]): number {
  const d = ctx.manifest.clamps.difficulty;
  const mode = currentMode(ctx);
  const now = ctx.now();
  const agg = currentAggression(ctx);
  if (mode === "off") {
    const fixed = directorOptions(ctx.manifest, ctx.options).fixedAggression ?? r2((d.aggressionMin + d.aggressionMax) / 2);
    if (Math.abs(fixed - agg) > 0.01) return setDifficulty(ctx, { aggression: fixed, mode, why: "difficulty off: fixed aggression" });
    return agg;
  }
  if (mode === "assist") {
    if (agg > d.aggressionMin + 0.01) return setDifficulty(ctx, { aggression: d.aggressionMin, mode, why: "assist mode on: enemies hold back" });
    return agg;
  }
  const last = ctx.kv.get<number>(`adjust:${ctx.world}`) ?? 0;
  if (now - last < ADJUST_EVERY_MS || !players.length) return agg;
  let deaths = 0, lowHp = 0, kills = 0, hurt = 0, dodges = 0;
  for (const p of players.slice(0, 16)) {
    for (const e of ctx.events({ world: ctx.world, player: p, type: "combat.*", since: now - LOOKBACK_MS, limit: 400 })) {
      if (e.type === "combat.died") deaths++;
      else if (e.type === "combat.hurt") { hurt++; if (typeof e.data.hp === "number" && e.data.hp < 0.25) lowHp++; }
      else if (e.type === "combat.killed") kills++;
      else if (e.type === "combat.dodged" || e.type === "combat.parried") dodges++;
    }
  }
  if (deaths + kills + hurt === 0) return agg;
  const n = Math.max(1, players.length);
  // > 0: the player is cruising; < 0: struggling
  const performance = clamp((kills / n) * 0.08 + (dodges / n) * 0.01 - (deaths / n) * 0.45 - (lowHp / n) * 0.12 - (hurt / n) * 0.01, -1, 1);
  const target = clamp(0.5 + performance * 0.5, d.aggressionMin, d.aggressionMax);
  const step = clamp(target - agg, -d.maxStep, d.maxStep);
  ctx.kv.set(`adjust:${ctx.world}`, now);
  if (Math.abs(step) < 0.02) return agg;
  const why = step < 0
    ? `struggling: ${deaths} deaths, ${lowHp} near-deaths in 5 min -> ease off`
    : `cruising: ${kills} kills, ${deaths} deaths in 5 min -> press harder`;
  return setDifficulty(ctx, { aggression: agg + step, mode, why });
}

// Unlocks & progression suggestions within the manifest progression schema. Unlock conditions (DSL) are evaluated
// continuously; an unlock records lf.quests.unlock and pushes `custom.progression.unlocked`. Suggestions rank the
// locked unlocks by progress toward their condition and fit with the player's style; when one gets close (>= 75%)
// a `custom.progression.suggest` directive nudges the player once.
import type { ModuleContext, ScopedContext } from "../../module.js";
import { conditionProgress, evalWith, makeDslEnv, type HostDslEnv } from "../world/dsl.js";
import { clip, numOr, round3 } from "../world/util.js";
import { questLog, type UnlockRecord } from "./log.js";

/** Words in an unlock id / name that fit a play style (a fitting unlock is ranked higher). */
const STYLE_WORDS: Record<string, RegExp> = {
  dodger: /dodge|evasi|roll|dash|swift|blink|agil/i,
  turtle: /block|shield|guard|armou?r|ward|parry/i,
  glass_cannon: /crit|power|burst|damage/i,
  ranged_camper: /bow|range|shot|arrow|snipe|throw|cannon|gun/i,
  berserker: /rage|fury|frenzy|axe|cleave|strength/i,
  explorer: /map|travel|explore|mount|slot|bag|lantern/i,
  rich: /merchant|trade|shop|coin|bank/i,
  big_spender: /merchant|trade|shop|discount/i,
  hoarder: /bag|slot|storage|vault/i,
  chatterbox: /charm|persua|speech|voice|talk/i,
  pacifist: /heal|calm|charm|persua|peace/i,
  thief: /steal|lock|pick|stealth|shadow/i,
  speedrunner: /dash|sprint|speed|haste/i,
};

export interface ProgressionSuggestion {
  id: string;
  name: string;
  kind: string;
  /** 0-1 estimated progress toward the unlock condition. */
  progress: number;
  /** Sort score (progress + style fit). */
  score: number;
  /** Matching play style, if any. */
  fits?: string;
  why: string;
}

/** Locked unlocks ranked for this player. */
export function suggestProgression(ctx: Pick<ModuleContext, "events" | "projections" | "manifest" | "now">, world: string, player: string, env?: HostDslEnv, limit = 5): ProgressionSuggestion[] {
  const m = ctx.manifest;
  const done = new Set(questLog(ctx, world, player).unlocks.map((u) => u.id));
  const e = env ?? makeDslEnv(ctx, world, player);
  const traits = Object.keys(e.model.traits ?? {}).map((k) => [k, numOr(e.call("trait", [k]), 0)] as const).filter(([, v]) => v >= 0.5).sort((a, b) => b[1] - a[1]);
  const out: ProgressionSuggestion[] = [];
  for (const u of m.progression.unlocks) {
    if (done.has(u.id)) continue;
    const progress = u.condition ? round3(conditionProgress(e, u.condition)) : 0;
    const fit = traits.find(([t]) => STYLE_WORDS[t]?.test(`${u.id} ${u.name}`));
    const score = round3(progress + (fit ? 0.25 * fit[1] : 0));
    const why = u.condition
      ? `${Math.round(progress * 100)}% toward ${u.condition}${fit ? `; fits your ${fit[0]} style` : ""}`
      : `no condition: the game grants it${fit ? `; fits your ${fit[0]} style` : ""}`;
    out.push({ id: u.id, name: u.name, kind: u.kind, progress, score, ...(fit ? { fits: fit[0] } : {}), why: clip(why, 200) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Evaluate unlock conditions; record + announce new unlocks, nudge near-misses once. Returns new unlocks. */
export function checkProgression(ctx: ScopedContext, player: string, env?: HostDslEnv): UnlockRecord[] {
  const m = ctx.manifest;
  if (!m.progression.unlocks.length) return [];
  const e = env ?? makeDslEnv(ctx, ctx.world, player);
  const done = new Set(questLog(ctx, ctx.world, player).unlocks.map((u) => u.id));
  const out: UnlockRecord[] = [];
  for (const u of m.progression.unlocks) {
    if (done.has(u.id) || !u.condition) continue;
    if (!evalWith(e, u.condition).ok) continue;
    const rec: UnlockRecord = { id: u.id, name: u.name, kind: u.kind, at: ctx.now() };
    ctx.record("lf.quests.unlock", { unlock: rec }, { player });
    ctx.emit({ kind: "custom.progression.unlocked", target: "ui", args: { unlock: rec }, why: clip(`${u.name}: ${u.condition}`, 200) }, { player });
    out.push(rec);
  }
  for (const s of suggestProgression(ctx, ctx.world, player, e, 3)) {
    if (s.progress < 0.75 || s.progress >= 1) continue;
    const key = `nudge:${ctx.world}:${player}:${s.id}`;
    if (ctx.kv.get<boolean>(key)) continue;
    ctx.kv.set(key, true);
    ctx.emit({ kind: "custom.progression.suggest", target: "ui", args: { suggestion: s }, why: clip(`close to ${s.name}: ${s.why}`, 200) }, { player });
  }
  return out;
}

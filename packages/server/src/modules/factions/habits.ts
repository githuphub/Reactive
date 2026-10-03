// Play-style read for raid plans: the player's recent signals (last 20 min) plus Observer trait scores.
//   pillaring   build.pillared {height}                      + trait pillarer
//   bow_heavy   combat.shot_bow, combat.hit with a bow        + traits archer, ranged_camper
//   hiding      combat.hid {depth}                            + traits hider, turtle
//   melee_heavy combat.hit with a melee weapon                + trait berserker
//   kiting      movement.sprint*, movement.fled, combat.fled, combat.dodged + traits speedrunner, dodger
//   fire        fire / lava use (element fire, lava / flint items, fire blocks placed)
import type { PlayerModel, StoredEvent } from "@liveforge/protocol";
import type { ScopedContext } from "../../module.js";
import { traitAt } from "../observer/view.js";
import { clamp, round2, str } from "./config.js";

export const HABITS = ["pillaring", "bow_heavy", "hiding", "melee_heavy", "kiting", "fire"] as const;
export type Habit = (typeof HABITS)[number];

export interface HabitRead {
  habit: Habit;
  /** 0-1 */
  score: number;
  evidence: string;
}

const RANGED = /bow|crossbow|sling|gun|staff|wand/i;
const FIRE = /fire|lava|flint|blaze|torch|burn|magma/i;
const WINDOW_MS = 20 * 60_000;

function traitScore(ctx: ScopedContext, model: PlayerModel | null, names: string[]): { score: number; name: string } {
  let best = { score: 0, name: "" };
  for (const n of names) {
    const s = model ? traitAt(model, n, ctx.now(), ctx.manifest) : 0;
    if (s > best.score) best = { score: s, name: n };
  }
  return best;
}

/** Strongest habits first (score >= 0.2). Deterministic for a given log + model. */
export function readHabits(ctx: ScopedContext, world: string, player: string): HabitRead[] {
  const now = ctx.now();
  let events: StoredEvent[] = [];
  try {
    events = ctx.events({ world, player, since: now - WINDOW_MS, limit: 3000 });
  } catch {
    events = [];
  }
  let model: PlayerModel | null = null;
  try {
    model = ctx.projections.get("observer.player_model", { world, player }) ?? null;
  } catch {
    model = null;
  }
  const c = { pillar: 0, pillarMax: 0, bow: 0, hid: 0, hidMax: 0, melee: 0, kite: 0, fire: 0 };
  for (const e of events) {
    const d = e.data;
    switch (e.type) {
      case "build.pillared":
        c.pillar++;
        c.pillarMax = Math.max(c.pillarMax, Number(d.height) || 0);
        break;
      case "combat.shot_bow":
        c.bow++;
        break;
      case "combat.hid":
        c.hid++;
        c.hidMax = Math.max(c.hidMax, Number(d.depth) || 0);
        break;
      case "combat.hit": {
        const w = str(d.weapon);
        if (RANGED.test(w)) c.bow++;
        else c.melee++;
        if (FIRE.test(str(d.element)) || FIRE.test(w)) c.fire++;
        break;
      }
      case "combat.dodged":
      case "movement.fled":
      case "combat.fled":
        c.kite++;
        break;
      case "combat.ability_used":
        if (FIRE.test(str(d.element)) || FIRE.test(str(d.ability))) c.fire++;
        break;
      case "block.placed":
        if (FIRE.test(str(d.block))) c.fire++;
        break;
      case "item.used":
      case "item.crafted":
        if (FIRE.test(str(d.item))) c.fire++;
        break;
      default:
        if (/^movement\.sprint/.test(e.type) || /kite/.test(e.type)) c.kite++;
    }
  }
  const sat = (n: number, k: number) => 1 - Math.exp(-n / k);
  const out: HabitRead[] = [];
  const add = (habit: Habit, fromSignals: number, evidence: string, trait: { score: number; name: string }) => {
    const score = round2(clamp(Math.max(fromSignals, trait.score * 0.9), 0, 1));
    if (score < 0.2) return;
    const ev = fromSignals >= trait.score * 0.9 || !trait.name ? evidence : `trait ${trait.name} ${trait.score.toFixed(2)}`;
    out.push({ habit, score, evidence: ev.slice(0, 120) });
  };
  add("pillaring", sat(c.pillar, 3), `pillared ${c.pillar}x${c.pillarMax ? ` (up to ${c.pillarMax} high)` : ""}`, traitScore(ctx, model, ["pillarer"]));
  add("bow_heavy", sat(c.bow, 8), `${c.bow} bow shots`, traitScore(ctx, model, ["archer", "ranged_camper"]));
  add("hiding", sat(c.hid, 2), `hid in a hole ${c.hid}x${c.hidMax ? ` (${c.hidMax} deep)` : ""}`, traitScore(ctx, model, ["hider", "turtle"]));
  add("melee_heavy", sat(c.melee, 12) * (c.melee > c.bow * 2 ? 1 : 0.6), `${c.melee} melee hits`, traitScore(ctx, model, ["berserker", "melee"]));
  add("kiting", sat(c.kite, 6), `${c.kite} sprints / dodges / escapes`, traitScore(ctx, model, ["speedrunner", "dodger", "kiter"]));
  add("fire", sat(c.fire, 3), `${c.fire} uses of fire or lava`, traitScore(ctx, model, ["pyro", "arsonist"]));
  return out.sort((a, b) => b.score - a.score || HABITS.indexOf(a.habit) - HABITS.indexOf(b.habit));
}

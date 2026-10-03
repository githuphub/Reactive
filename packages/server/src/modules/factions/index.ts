// Module "factions" - OWNER: K7. The village mind: one brain per faction (village).
// It folds village state (trust per player, damage, threats, mood, rumours, the world clock) into the
// `factions.mind` projection; a council (rules every 20 s and on important signals, upgraded by a short Haiku
// council when keyed) picks posture (calm / wary / hostile / festive), a price multiplier and guard posts; and the
// ask `faction.raid_plan` plans night raids that counter the player's habits. Docs: docs/factions.md.
//
// Manifest: factions[] {id, name, members?, home?, traits?, guards?, posts?, raid?: {mobs?, captains?, size?}}
// and `modules.factions: true` (opt-in). Trust is the World module's reputation (lf.world.reputation), not a copy.
//
// Module options (manifest modules.factions.options), all optional:
//   council (true)            LLM council upgrade on posture changes (fast tier, task "factions.council")
//   councilCooldownSec (30)   min seconds between two councils of one faction
//   postureMinSec (20)        a posture holds this long before it may calm down (escalation is immediate)
//   windowMin (10)            minutes of damage / threats the rules look at
//   directorTimeline (true)   also record decisions as lf.director.decision (Director timeline)
//   directives (true)         push custom.faction_posture / custom.guard_posts
//
// Events: lf.factions.decision, lf.factions.raid_plan, lf.factions.threat. Directives: custom.faction_posture
// {faction, posture, priceMult, announcement, previous?, stage}, custom.guard_posts {faction, posts:[{npc, post}]}.
import type { StoredEvent } from "@liveforge/protocol";
import { defineModule, type EventContext, type ModuleContext, type ScopedContext } from "../../module.js";
import { factionOfRef } from "./config.js";
import { evaluate } from "./council.js";
import { factionOfEvent, mindProjection } from "./mind.js";
import { raidPlanAsk } from "./raid.js";
import { factionRoutes } from "./routes.js";

export { mindOf, rulesDecision, planGuards } from "./council.js";
export { readHabits, HABITS, type Habit, type HabitRead } from "./habits.js";
export { COUNTER_TABLE, rulesRaid } from "./raid.js";
export { mindProjection, factionOfEvent } from "./mind.js";

/** Saved per game in init() so routes can reach the context. */
const contexts = new Map<string, ModuleContext>();

/** Signals that make the village think right away (instead of waiting for the 20 s tick). */
const IMPORTANT = [
  "world.property_damaged", "world.destroyed", "block.broken", "combat.killed", "economy.stole", "social.threatened",
  "social.gave", "world.helped", "quest.completed", "world.time",
  "lf.quests.completed", "lf.world.rumour", "lf.world.reputation", "lf.factions.threat",
];

/** Per game:world:faction: last evaluation time + a pending trailing run. */
const pace = new Map<string, { last: number; timer: ReturnType<typeof setTimeout> | null }>();
const MIN_GAP_MS = 1500;

function schedule(ctx: ScopedContext, faction: string, reason: string): void {
  const key = `${ctx.game}:${ctx.world}:${faction}`;
  const p = pace.get(key) ?? { last: 0, timer: null };
  pace.set(key, p);
  const run = () => {
    p.timer = null;
    p.last = Date.now();
    void evaluate(ctx, faction, reason).catch((e) => ctx.log.warn("village mind evaluation failed", { faction, error: (e as Error).message }));
  };
  const wait = MIN_GAP_MS - (Date.now() - p.last);
  if (wait <= 0 && !p.timer) run();
  else if (!p.timer) p.timer = setTimeout(run, Math.max(50, wait));
}

function affected(ctx: EventContext, ev: StoredEvent): string[] {
  const m = ctx.manifest;
  if (ev.type === "world.time" || ev.type === "lf.world.rumour") return m.factions.map((f) => f.id);
  if (ev.type === "lf.world.reputation" || ev.type === "lf.factions.threat") {
    const f = factionOfRef(m, ev.data.faction);
    return f ? [f] : [];
  }
  if (ev.type === "lf.quests.completed") {
    const f = factionOfRef(m, ev.data.giver);
    return f ? [f] : [];
  }
  const f = factionOfEvent(m, ev);
  return f ? [f] : [];
}

export default defineModule({
  id: "factions",
  description: "Village mind: per-faction posture, prices and guard posts from trust, damage, threats and mood; adaptive night raid plans.",
  projections: [mindProjection],
  signalHandlers: [
    {
      types: IMPORTANT,
      handle(ctx, ev) {
        if (!ctx.manifest.factions.length) return;
        for (const f of affected(ctx, ev)) schedule(ctx, f, ev.type);
      },
    },
  ],
  asks: { "faction.raid_plan": raidPlanAsk },
  ticks: [
    {
      name: "village-council",
      everyMs: 20_000,
      async run(ctx) {
        for (const f of ctx.manifest.factions) {
          try {
            await evaluate(ctx, f.id, "tick", { awaitCouncil: true });
          } catch (e) {
            ctx.log.warn("village council tick failed", { faction: f.id, error: (e as Error).message });
          }
        }
      },
    },
  ],
  routes: factionRoutes(contexts),
  init(ctx) {
    contexts.set(ctx.game, ctx);
    const m = ctx.manifest;
    if (!m.factions.length) ctx.log.warn("factions module is on but the manifest declares no factions");
    for (const f of m.factions) {
      const members = new Set([...(f.members ?? []), ...m.personas.filter((p) => p.faction === f.id).map((p) => p.id)]);
      if (!members.size) ctx.log.info("faction has no members: only home-zone signals will reach its mind", { faction: f.id });
    }
  },
});

// Module "quests" - OWNER: K2. Only edit files inside packages/server/src/modules/quests/.
// Quests: reactive quests, personal achievements, progression suggestions, dynamic objectives.
// Contract: docs/CONTRACTS.md. Asks owned here: quest.offer, achievement.check.
// Projections owned here: quests.log (player; QuestLog + offeredAt / personal / objectives / unlocks).
//
// Module options (manifest modules.quests.options), all optional:
//   questExpirySec (1800)          reactive quests expire this long after being offered / accepted
//   proactiveQuests (true)         push a `quest.offer` directive after a high-salience moment
//   proactiveSalience (0.7)        proactiveCooldownSec (300)
//   personalTraitMin (0.6)         trait score that earns a personal achievement
//   maxPersonalPending (6)         llmAchievements (true)  re-word personal achievements with the LLM when keyed
//   dynamicObjectives (true)       objectiveCooldownSec (45)
//   checkEveryMs (1000)            min interval between signal-driven achievement / unlock checks per player
import type { Moment, StoredEvent } from "@liveforge/protocol";
import { defineModule, type EventContext, type ModuleContext, type TickContext } from "../../module.js";
import { makeDslEnv } from "../world/dsl.js";
import { opt, personaById, scopeFor, throttle } from "../world/util.js";
import { questLogProjection } from "./log.js";
import { offerInstant, offerUpgrade } from "./offer.js";
import { expireTick, onQuestProgress } from "./progress.js";
import { achievementTick, checkAchievements, recentlyUnlocked } from "./achievements.js";
import { checkProgression } from "./progression.js";
import { objectiveTick, onObjectiveSource } from "./objectives.js";
import { questRoutes } from "./routes.js";

export { questLog, type QuestLogState, type DynamicObjective, type UnlockRecord } from "./log.js";
export { startObjective } from "./objectives.js";
export { suggestProgression, type ProgressionSuggestion } from "./progression.js";
export { checkAchievements, designerAchievements } from "./achievements.js";

const contexts = new Map<string, ModuleContext>();

/** Achievements + progression unlocks, throttled per player. */
function onCheck(ctx: EventContext, ev: StoredEvent): void {
  if (!ev.player || ev.type === "lf.directive" || ev.type.startsWith("lf.quests.") || ev.type.startsWith("lf.world.rumour")) return;
  if (!throttle(`quests:check:${ctx.game}:${ev.world}:${ev.player}`, opt(ctx, "checkEveryMs", 1000), ctx.now())) return;
  const env = makeDslEnv(ctx, ctx.world, ev.player);
  checkAchievements(ctx, ev.player, env);
  checkProgression(ctx, ev.player, env);
}

/** A high-salience moment makes a giver in the player's zone offer a quest (rules only, once per cooldown). */
function onProactive(ctx: EventContext, ev: StoredEvent): void {
  const player = ev.player;
  const mo = ev.data.moment as Moment | undefined;
  if (!player || !mo || opt(ctx, "proactiveQuests", true) === false) return;
  if ((mo.salience ?? 0.5) < opt(ctx, "proactiveSalience", 0.7)) return;
  const key = `proactive:${ctx.world}:${player}`;
  const now = ctx.now();
  if (now - (ctx.kv.get<number>(key) ?? 0) < opt(ctx, "proactiveCooldownSec", 300) * 1000) return;
  const res = offerInstant(ctx, player, {});
  if (!res.quest) return;
  ctx.kv.set(key, now);
  const giver = res.quest.giver && personaById(ctx.manifest, res.quest.giver) ? res.quest.giver : undefined;
  ctx.emit({
    kind: "quest.offer", target: giver ? `npc:${giver}` : "ui",
    args: { quest: res.quest, ...(giver ? { giver } : {}) },
    why: `${mo.kind} -> ${res.why}`.slice(0, 200),
  }, { player });
}

function checkTick(ctx: TickContext): void {
  for (const player of ctx.activePlayers.slice(0, 200)) {
    const sc = scopeFor(ctx, ctx.world, player);
    const env = makeDslEnv(sc, ctx.world, player);
    checkAchievements(sc, player, env);
    checkProgression(sc, player, env);
  }
}

export default defineModule({
  id: "quests",
  description: "Quests: reactive quests, personal achievements, progression suggestions, dynamic objectives.",
  projections: [questLogProjection],
  signalHandlers: [
    { types: ["combat.*", "economy.*", "social.*", "movement.*", "gear.*", "world.*", "quest.*", "item.*", "forge.*"], handle: onQuestProgress },
    { types: ["*"], handle: onCheck },
    { types: ["lf.observer.moment"], handle: onProactive },
    { types: ["lf.director.decision", "lf.observer.moment", "combat.*", "movement.*", "economy.*"], handle: onObjectiveSource },
  ],
  asks: {
    "quest.offer": {
      /** Rules template quest (recorded as offered); the AI upgrade rewrites it with giver dialogue. */
      instant(ctx, params) {
        const r = offerInstant(ctx, ctx.player!, params);
        return { result: { quest: r.quest }, why: r.why, ...(r.quest ? {} : { final: true }) };
      },
      async upgrade(ctx, params, instant) {
        const r = await offerUpgrade(ctx, instant.quest, params);
        return r ? { result: { quest: r.quest }, why: r.why } : null;
      },
      // Quests are personal and recorded per offer: never serve a cached quest to someone else.
      cacheKey: () => false,
      upgradeTimeoutMs: 25_000,
    },
    "achievement.check": {
      /** Evaluate now; returns new unlocks plus those from the last 10 minutes the client hasn't acknowledged. */
      instant(ctx, params) {
        const player = ctx.player!;
        const fresh = checkAchievements(ctx, player);
        const known = new Set(params.recent ?? []);
        const ids = new Set(fresh.map((a) => a.id));
        const recent = recentlyUnlocked(ctx, ctx.world, player).filter((a) => !known.has(a.id) && !ids.has(a.id));
        const unlocked = [...fresh, ...recent];
        return { result: { unlocked }, why: `${fresh.length} new, ${recent.length} recent`, final: true };
      },
    },
  },
  ticks: [
    { name: "achievements", everyMs: 60_000, run: achievementTick },
    { name: "checks", everyMs: 5000, run: checkTick },
    { name: "objectives", everyMs: 2000, run: objectiveTick },
    { name: "expiry", everyMs: 30_000, run: expireTick },
  ],
  routes: questRoutes(contexts),
  init(ctx) {
    contexts.set(ctx.game, ctx);
  },
});

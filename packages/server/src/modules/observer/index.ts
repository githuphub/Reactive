// Module "observer" - OWNER: K1. Only edit files inside packages/server/src/modules/observer/.
// Player model: built-in + designer traits (sliding windows, decay, evidence), moments, LLM profile.
// Contract: docs/CONTRACTS.md. Asks owned here: player.model.
// Projections owned here: observer.player_model (player scope; state shape PlayerModel in @liveforge/protocol).
//
// Options (manifest modules.observer.options): richGold, brokeGold, rangedDistance, speedQuestSec, profileEvery,
// designerHalfLifeMin, absurdMin, momentCooldownSec (see traits.ts ObserverOptions).
import { Hono } from "hono";
import { moduleOptions } from "@liveforge/manifest";
import { BUILTIN_MOMENTS } from "@liveforge/protocol";
import { defineModule, type LfEnv, type ModuleContext } from "../../module.js";
import { compileRule } from "../../dsl/index.js";
import { playerModelProjection, readModel } from "./model.js";
import { detectBuiltinMoments, evaluateDesignerRules, sweepNearDeath } from "./moments.js";
import { maybeRefreshProfile, refreshProfile, rulesProfile } from "./profile.js";
import { forPlayer } from "./scope.js";
import { BUILTIN_TRAITS, observerOptions } from "./traits.js";
import { viewModel } from "./view.js";

export { playerModelProjection, readModel, PLAYER_MODEL, OBS_EVENTS } from "./model.js";
export { viewModel, describePlayer, traitAt, gearTags, gearNames, type ModelView } from "./view.js";
export { fireMoment } from "./moments.js";
export { BUILTIN_TRAITS, BUILTIN_TRAIT_NAMES } from "./traits.js";
export { makeDslEnv, evalRule, compileRule } from "./dsl-env.js";
export { forPlayer } from "./scope.js";

/** Per-game init contexts (module routes only know the game id). */
const contexts = new Map<string, ModuleContext>();

const admin = new Hono<LfEnv>();
/** GET /admin/m/observer/traits - the trait + moment library for this game (built-in + designer, with rule errors). */
admin.get("/traits", (c) => {
  const m = contexts.get(c.get("game"))?.manifest;
  return c.json({
    builtin: Object.entries(BUILTIN_TRAITS).map(([name, t]) => ({ name, description: t.description, kind: t.kind, halfLifeMin: t.halfLifeMs / 60_000 })),
    designer: Object.entries(m?.traits ?? {}).map(([name, rule]) => ({ name, rule, error: compileRule(rule).error })),
    moments: {
      builtin: [...BUILTIN_MOMENTS],
      designer: Object.entries(m?.moments ?? {}).map(([name, rule]) => ({ name, rule, error: compileRule(rule).error })),
    },
    options: observerOptions(m ? moduleOptions(m, "observer") : {}),
  });
});

export default defineModule({
  id: "observer",
  description: "Player model: built-in + designer traits (sliding windows, decay, evidence), moments, LLM profile.",
  projections: [playerModelProjection],
  signalHandlers: [
    {
      types: ["*"],
      handle(ctx, ev) {
        if (!ctx.player || ev.type.startsWith("lf.") || ev.origin === "module") return;
        const o = observerOptions(ctx.options);
        detectBuiltinMoments(ctx, ev, o);
        evaluateDesignerRules(ctx, ev);
        maybeRefreshProfile(ctx, o.profileEvery);
      },
    },
  ],
  asks: {
    "player.model": {
      instant(ctx, params) {
        const model = readModel((n, s) => ctx.projections.get(n, s), ctx.world, ctx.player ?? "");
        const view = viewModel(model, ctx.now(), ctx.manifest, params.top ?? 5);
        if (!view.profile) view.profile = { text: rulesProfile(view), updatedAt: ctx.now(), eventCount: view.eventCount };
        return {
          result: view,
          why: view.top.length ? `top: ${view.top.map((t) => `${t.trait} ${t.score.toFixed(2)}`).join(", ")}` : "no strong traits yet",
          final: !params.refreshProfile,
        };
      },
      async upgrade(ctx, params) {
        if (!params.refreshProfile) return null;
        await refreshProfile(ctx, { signal: ctx.signal });
        const model = readModel((n, s) => ctx.projections.get(n, s), ctx.world, ctx.player ?? "");
        return { result: viewModel(model, ctx.now(), ctx.manifest, params.top ?? 5), why: "fresh profile" };
      },
      cacheKey: () => false,
    },
  },
  ticks: [
    {
      // Window-based designer rules expire without new events; pending near-death states resolve.
      name: "observer-sweep",
      everyMs: 10_000,
      run(ctx) {
        for (const player of ctx.activePlayers) {
          const pctx = forPlayer(ctx, player);
          sweepNearDeath(pctx);
          evaluateDesignerRules(pctx, null);
        }
      },
    },
  ],
  routes: { admin },
  init(ctx) {
    contexts.set(ctx.game, ctx);
    for (const [name, rule] of [...Object.entries(ctx.manifest.traits), ...Object.entries(ctx.manifest.moments)]) {
      const c = compileRule(rule);
      if (c.error) ctx.log.warn(`designer rule "${name}" does not compile: ${c.error}`);
    }
  },
});

// Canonical trait-rule DSL environment (CONTRACTS §7, owner K1). K2 (reactions, achievements, unlocks, dynamic
// objectives) imports from here:
//
//   import { makeDslEnv, evalRule } from "../observer/dsl-env.js";
//   const env = makeDslEnv(ctx, ctx.world, ctx.player);          // one env per evaluation pass
//   if (evalRule(rule.when, env)) { ... }                         // parse once (cached), evaluate fast
//
// Functions: count/sum/avg/max/rate/last/since/distinct over the event log (with {field=value} filters, e.g.
// count(combat.killed{target_type=goblin}, 10m)), trait, stat, moment, rep, attitude, has, min2, max2.
// Bare identifiers resolve to a trait score, else a player-model stat. Unknown things evaluate to 0 (never throw).
// The implementation lives in packages/server/src/dsl/ (shared server utility).
export {
  makeDslEnv, compileRule, evalRule, evalValue, ruleWatches,
  type DslEnvOptions, type DslHost, type LiveDslEnv, type CompiledRule,
} from "../../dsl/index.js";

// Shared trait-rule DSL utilities for server modules (owner K1). The grammar + parser live in @liveforge/protocol
// (dsl.ts) so the manifest validator and SDKs share them; this folder adds what a server needs:
//   - compileRule(src): parse once, cached by source string, evaluate fast many times
//   - evalRule(src, env): safe boolean evaluation (a bad rule logs once and evaluates false)
//   - makeDslEnv(ctx, world, player): the canonical environment (windows over the event log + player model)
//
//   import { makeDslEnv, evalRule } from "../../dsl/index.js";
//   const env = makeDslEnv(ctx, ctx.world, ctx.player);
//   if (evalRule("trait(rich) > 0.6 & stat(zone) == \"courtyard\"", env)) { ... }
import { checkDsl, compileDsl, dslSignalRefs, dslTruthy, parseDsl, type DslEnv, type DslExpr, type DslValue } from "@liveforge/protocol";

export { makeDslEnv, type DslEnvOptions, type DslHost, type LiveDslEnv } from "./env.js";
export {
  checkDsl, compileDsl, dslSignalRefs, dslTruthy, parseDsl, evalDsl, parseDslRef, matchDslFilter, DSL_FUNCTIONS, DslError,
  type DslEnv, type DslExpr, type DslValue, type DslRef, type DslFilterCond,
} from "@liveforge/protocol";

export interface CompiledRule {
  src: string;
  /** null when the source does not parse (see error). */
  run: ((env: DslEnv) => DslValue) | null;
  error: string | null;
  /** Signal types the rule reads through window functions (for "only re-evaluate on relevant events"). */
  refs: string[];
  /** true when the rule reads anything besides event windows (traits, stats, moments, rep ...): re-evaluate on every event. */
  readsState: boolean;
}

const compiled = new Map<string, CompiledRule>();
const WINDOW_FNS = new Set(["count", "sum", "avg", "max", "rate", "last", "since", "distinct"]);

/** Does an expression read anything other than event windows (traits, stats, moments, factions, memories)? */
function astReadsState(e: DslExpr): boolean {
  switch (e.k) {
    case "id": return true;
    case "call":
      if (!WINDOW_FNS.has(e.fn) && e.fn !== "min2" && e.fn !== "max2") return true;
      return e.args.some((a, i) => !(i === 0 && a.k === "id" && WINDOW_FNS.has(e.fn)) && astReadsState(a));
    case "un": return astReadsState(e.e);
    case "bin": return astReadsState(e.l) || astReadsState(e.r);
    default: return false;
  }
}

/** Parse + compile once per distinct source (cached for the process lifetime; rules come from manifests). */
export function compileRule(src: string): CompiledRule {
  let c = compiled.get(src);
  if (c) return c;
  const error = checkDsl(src);
  if (error) {
    c = { src, run: null, error, refs: [], readsState: false };
  } else {
    let refs: string[] = [];
    try { refs = dslSignalRefs(src); } catch { refs = []; }
    const readsState = astReadsState(parseDsl(src));
    c = { src, run: compileDsl(src), error: null, refs, readsState };
  }
  if (compiled.size > 2000) compiled.clear();
  compiled.set(src, c);
  return c;
}

/** Evaluate a rule to a value (0 when it does not compile or throws). */
export function evalValue(src: string, env: DslEnv): DslValue {
  const c = compileRule(src);
  if (!c.run) return 0;
  try {
    return c.run(env);
  } catch {
    return 0;
  }
}

/** Evaluate a rule as a condition (false when it does not compile or throws). Numbers are true at >= 0.5. */
export function evalRule(src: string, env: DslEnv): boolean {
  return dslTruthy(evalValue(src, env));
}

/** True when an event type is relevant to a rule (it reads that type via a window function, or reads state). */
export function ruleWatches(rule: CompiledRule, type: string): boolean {
  if (rule.readsState) return true;
  return rule.refs.some((r) => r === "*" || r === type || (r.endsWith(".*") && type.startsWith(r.slice(0, -1))));
}

// Thin DSL adapter for World + Quests over K1's canonical env (modules/observer/dsl-env.ts -> server/src/dsl).
// Adds a result shape with the compile error (for one-time warnings) and a 0-1 progress estimate for suggestions.
import { dslTruthy, evalDsl, parseDsl, type DslEnv, type DslExpr, type DslValue } from "@liveforge/protocol";
import { compileRule, makeDslEnv, type DslEnvOptions, type DslHost, type LiveDslEnv } from "../observer/dsl-env.js";

export { makeDslEnv, type DslEnvOptions, type DslHost };
/** The env World + Quests use (K1's LiveDslEnv: model, zone(), notBefore support). */
export type HostDslEnv = LiveDslEnv;

export interface ConditionResult {
  ok: boolean;
  value: DslValue;
  error?: string;
}

/** Evaluate a DSL condition with an env (compile errors -> ok:false + error, never throws). */
export function evalWith(env: DslEnv, src: string): ConditionResult {
  const c = compileRule(src);
  if (!c.run) return { ok: false, value: false, error: c.error ?? "does not compile" };
  try {
    const value = c.run(env);
    return { ok: dslTruthy(value), value };
  } catch (e) {
    return { ok: false, value: false, error: (e as Error).message };
  }
}

/** Evaluate a DSL condition for one player (fresh env). */
export function evalCondition(ctx: DslHost, world: string, player: string, src: string, opts?: DslEnvOptions): ConditionResult {
  return evalWith(makeDslEnv(ctx, world, player, opts), src);
}

/**
 * Rough 0-1 progress toward a condition (for progression suggestions): `a >= N` -> a/N, `&` -> min, `|` -> max,
 * anything else -> 1 when true, else 0.
 */
export function conditionProgress(env: DslEnv, src: string): number {
  let ast: DslExpr;
  try {
    ast = parseDsl(src);
  } catch {
    return 0;
  }
  const evalNode = (e: DslExpr): DslValue => {
    try {
      return evalDsl(e, env);
    } catch {
      return 0;
    }
  };
  const walk = (e: DslExpr): number => {
    if (e.k === "bin" && (e.op === "&" || e.op === "|")) {
      const l = walk(e.l);
      const r = walk(e.r);
      return e.op === "&" ? Math.min(l, r) : Math.max(l, r);
    }
    if (e.k === "bin" && (e.op === ">=" || e.op === ">")) {
      const l = Number(evalNode(e.l));
      const r = Number(evalNode(e.r));
      if (Number.isFinite(l) && Number.isFinite(r) && r > 0) return Math.max(0, Math.min(1, l / r));
    }
    return dslTruthy(evalNode(e)) ? 1 : 0;
  };
  return walk(ast);
}

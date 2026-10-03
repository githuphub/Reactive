// DSL adapter for World + Quests: one place that picks the DslEnv implementation and caches compiled conditions.
// When K1's canonical env lands, point the import below at it (same signature: makeDslEnv(ctx, world, player, opts)).
import { checkDsl, compileDsl, dslTruthy, evalDsl, parseDsl, type DslEnv, type DslExpr, type DslValue } from "@liveforge/protocol";
import { makeDslEnv, type DslEnvOptions, type DslHost, type HostDslEnv } from "./dsl-env-stub.js";

export { makeDslEnv, type DslEnvOptions, type DslHost, type HostDslEnv };

const compiled = new Map<string, ((env: DslEnv) => DslValue) | { error: string }>();

/** Compile once (bounded cache). Returns the error message instead of throwing. */
export function compileCached(src: string): ((env: DslEnv) => DslValue) | { error: string } {
  let c = compiled.get(src);
  if (!c) {
    const err = checkDsl(src);
    if (err) c = { error: err };
    else {
      try {
        c = compileDsl(src);
      } catch (e) {
        c = { error: (e as Error).message };
      }
    }
    if (compiled.size > 1000) compiled.clear();
    compiled.set(src, c);
  }
  return c;
}

export interface ConditionResult {
  ok: boolean;
  value: DslValue;
  error?: string;
}

/** Evaluate a DSL condition with an env (errors -> ok:false + error, never throws). */
export function evalWith(env: DslEnv, src: string): ConditionResult {
  const fn = compileCached(src);
  if (typeof fn !== "function") return { ok: false, value: false, error: fn.error };
  try {
    const value = fn(env);
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

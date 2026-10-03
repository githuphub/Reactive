// Trait-rule DSL: one small expression language for designer traits, moments, reaction rules, achievement and
// objective conditions (manifest strings). Parsed here (shared by the manifest validator, server modules and any
// SDK); evaluated against an environment the caller supplies (the Observer provides windows over the event log).
//
//   necromancer: count(magic.raise_dead, 10m) > 10
//   reaction:    rich & stat(zone) == "town"
//   achievement: count(combat.dodged, 2m) >= 30 and not count(combat.hurt, 2m)
//
// Grammar (precedence low -> high):
//   expr    := or
//   or      := and (("|" | "||" | "or") and)*
//   and     := not (("&" | "&&" | "and") not)*
//   not     := ("!" | "not") not | cmp
//   cmp     := sum (("==" | "!=" | ">" | ">=" | "<" | "<=") sum)?
//   sum     := term (("+" | "-") term)*
//   term    := unary (("*" | "/") unary)*
//   unary   := "-" unary | atom
//   atom    := number | duration | string | "true" | "false" | ident | call | "(" expr ")"
//   call    := ident "(" (expr ("," expr)*)? ")"
//   ident   := [A-Za-z_][A-Za-z0-9_.*]*      (dotted names = signal types / namespaces; "*" wildcard)
//   duration:= number ("ms" | "s" | "m" | "h" | "d")   -> milliseconds
//   string  := "..." | '...'
//
// Semantics: a bare identifier is resolved by env.ident (convention: trait name -> score 0-1, else a stat / flag).
// Bare identifiers used directly as call arguments are passed to the function as their NAME (a string), so
// count(magic.raise_dead, 10m) receives "magic.raise_dead". In boolean position numbers are true when >= 0.5
// (the trait threshold) - write `count(x, 1m) > 0` for "at least once".

export type DslValue = number | boolean | string;

export type DslExpr =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "id"; name: string }
  | { k: "call"; fn: string; args: DslExpr[] }
  | { k: "un"; op: "!" | "-"; e: DslExpr }
  | { k: "bin"; op: "|" | "&" | "==" | "!=" | ">" | ">=" | "<" | "<=" | "+" | "-" | "*" | "/"; l: DslExpr; r: DslExpr };

/** Built-in functions every evaluator environment should implement (windows are durations in ms). */
export const DSL_FUNCTIONS = {
  count: "count(signalType, window) - number of matching events in the window (signalType may end in .*)",
  sum: "sum(signalType.field, window) - sum of a numeric data field over the window",
  avg: "avg(signalType.field, window) - average of a numeric data field over the window",
  max: "max(signalType.field, window) - max of a numeric data field over the window",
  rate: "rate(signalType, window) - events per minute over the window",
  last: "last(signalType.field) - the field of the most recent matching event (0 / \"\" if none)",
  since: "since(signalType) - seconds since the most recent matching event (Infinity if none)",
  distinct: "distinct(signalType.field, window) - number of distinct values of a field",
  trait: "trait(name) - trait score 0-1",
  stat: "stat(name) - player-model stat (gold, kills, zone ...)",
  moment: "moment(kind, window) - number of moments of that kind in the window",
  rep: "rep(faction) - player reputation with a faction (-1..1)",
  attitude: "attitude(npc) - an NPC's attitude toward the player (-1..1)",
  has: "has(tag) - player has a gear / state tag",
  min2: "min2(a, b) - smaller of two numbers",
  max2: "max2(a, b) - larger of two numbers",
} as const;
export type DslFunction = keyof typeof DSL_FUNCTIONS;

export class DslError extends Error {
  constructor(message: string, public readonly pos: number) {
    super(message);
    this.name = "DslError";
  }
}

type Tok =
  | { t: "num"; v: number; p: number }
  | { t: "str"; v: string; p: number }
  | { t: "id"; v: string; p: number }
  | { t: "op"; v: string; p: number }
  | { t: "eof"; p: number };

const DUR: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const OPS = ["||", "&&", "==", "!=", ">=", "<=", "|", "&", "!", ">", "<", "+", "-", "*", "/", "(", ")", ","];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(\d+(?:\.\d+)?|\.\d+)(ms|s|m|h|d)?(?![A-Za-z0-9_])/.exec(src.slice(i));
      if (!m) throw new DslError(`bad number near "${src.slice(i, i + 8)}"`, i);
      out.push({ t: "num", v: parseFloat(m[1]) * (m[2] ? DUR[m[2]] : 1), p: i });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new DslError("unterminated string", i);
      out.push({ t: "str", v: src.slice(i + 1, end), p: i });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.*]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0], p: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new DslError(`unexpected character "${c}"`, i);
    out.push({ t: "op", v: op, p: i });
    i += op.length;
  }
  out.push({ t: "eof", p: src.length });
  return out;
}

/** Parse a DSL string to an AST. Throws DslError with a position. */
export function parseDsl(src: string): DslExpr {
  const toks = lex(src);
  let i = 0;
  const peek = () => toks[i];
  const isOp = (...v: string[]) => { const t = peek(); return t.t === "op" && v.includes(t.v); };
  const isWord = (...v: string[]) => { const t = peek(); return t.t === "id" && v.includes(t.v.toLowerCase()); };
  const expectOp = (v: string) => {
    if (!isOp(v)) throw new DslError(`expected "${v}"`, peek().p);
    i++;
  };

  function or(): DslExpr {
    let l = and();
    while (isOp("|", "||") || isWord("or")) { i++; l = { k: "bin", op: "|", l, r: and() }; }
    return l;
  }
  function and(): DslExpr {
    let l = not();
    while (isOp("&", "&&") || isWord("and")) { i++; l = { k: "bin", op: "&", l, r: not() }; }
    return l;
  }
  function not(): DslExpr {
    if (isOp("!") || isWord("not")) { i++; return { k: "un", op: "!", e: not() }; }
    return cmp();
  }
  function cmp(): DslExpr {
    const l = sum();
    if (isOp("==", "!=", ">", ">=", "<", "<=")) {
      const op = (toks[i++] as { v: string }).v as "==";
      return { k: "bin", op, l, r: sum() };
    }
    return l;
  }
  function sum(): DslExpr {
    let l = term();
    while (isOp("+", "-")) { const op = (toks[i++] as { v: string }).v as "+"; l = { k: "bin", op, l, r: term() }; }
    return l;
  }
  function term(): DslExpr {
    let l = unary();
    while (isOp("*", "/")) { const op = (toks[i++] as { v: string }).v as "*"; l = { k: "bin", op, l, r: unary() }; }
    return l;
  }
  function unary(): DslExpr {
    if (isOp("-")) { i++; return { k: "un", op: "-", e: unary() }; }
    return atom();
  }
  function atom(): DslExpr {
    const t = peek();
    if (t.t === "num") { i++; return { k: "num", v: t.v }; }
    if (t.t === "str") { i++; return { k: "str", v: t.v }; }
    if (t.t === "op" && t.v === "(") { i++; const e = or(); expectOp(")"); return e; }
    if (t.t === "id") {
      i++;
      const low = t.v.toLowerCase();
      if (low === "true" || low === "false") return { k: "bool", v: low === "true" };
      if (isOp("(")) {
        i++;
        const args: DslExpr[] = [];
        if (!isOp(")")) {
          args.push(or());
          while (isOp(",")) { i++; args.push(or()); }
        }
        expectOp(")");
        return { k: "call", fn: t.v, args };
      }
      return { k: "id", name: t.v };
    }
    throw new DslError(t.t === "eof" ? "unexpected end of expression" : `unexpected "${(t as { v: string }).v}"`, t.p);
  }

  const e = or();
  if (peek().t !== "eof") throw new DslError(`unexpected "${(peek() as { v: string }).v}" after expression`, peek().p);
  return e;
}

export interface DslCheckOptions {
  /** Extra functions the environment provides (beyond DSL_FUNCTIONS). */
  functions?: readonly string[];
}

/** Parse + check function names / arities. Returns null when valid, else a human-readable error. */
export function checkDsl(src: string, opts: DslCheckOptions = {}): string | null {
  try {
    const ast = parseDsl(src);
    const known = new Set<string>([...Object.keys(DSL_FUNCTIONS), ...(opts.functions ?? [])]);
    let err: string | null = null;
    const walk = (e: DslExpr) => {
      if (err) return;
      if (e.k === "call") {
        if (!known.has(e.fn)) err = `unknown function "${e.fn}" (known: ${[...known].join(", ")})`;
        e.args.forEach(walk);
      } else if (e.k === "un") walk(e.e);
      else if (e.k === "bin") { walk(e.l); walk(e.r); }
    };
    walk(ast);
    return err;
  } catch (e) {
    if (e instanceof DslError) return `${e.message} at column ${e.pos + 1}`;
    throw e;
  }
}

/** What an evaluator needs from its host (the Observer builds one per player over its windows). */
export interface DslEnv {
  ident(name: string): DslValue;
  call(fn: string, args: DslValue[]): DslValue;
}

export const dslTruthy = (v: DslValue): boolean => (typeof v === "number" ? v >= 0.5 : typeof v === "string" ? v.length > 0 : v);
const num = (v: DslValue): number => (typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : Number(v) || 0);

/** Evaluate an AST. Errors inside env calls propagate. */
export function evalDsl(e: DslExpr, env: DslEnv): DslValue {
  switch (e.k) {
    case "num": case "str": case "bool": return e.v;
    case "id": return env.ident(e.name);
    case "call": return env.call(e.fn, e.args.map((a) => (a.k === "id" ? a.name : evalDsl(a, env))));
    case "un": return e.op === "!" ? !dslTruthy(evalDsl(e.e, env)) : -num(evalDsl(e.e, env));
    case "bin": {
      if (e.op === "&") return dslTruthy(evalDsl(e.l, env)) && dslTruthy(evalDsl(e.r, env));
      if (e.op === "|") return dslTruthy(evalDsl(e.l, env)) || dslTruthy(evalDsl(e.r, env));
      const l = evalDsl(e.l, env);
      const r = evalDsl(e.r, env);
      switch (e.op) {
        case "==": return typeof l === "string" || typeof r === "string" ? String(l) === String(r) : num(l) === num(r);
        case "!=": return typeof l === "string" || typeof r === "string" ? String(l) !== String(r) : num(l) !== num(r);
        case ">": return num(l) > num(r);
        case ">=": return num(l) >= num(r);
        case "<": return num(l) < num(r);
        case "<=": return num(l) <= num(r);
        case "+": return num(l) + num(r);
        case "-": return num(l) - num(r);
        case "*": return num(l) * num(r);
        case "/": return num(r) === 0 ? 0 : num(l) / num(r);
      }
    }
  }
}

/** Parse once, evaluate many times. */
export function compileDsl(src: string): (env: DslEnv) => DslValue {
  const ast = parseDsl(src);
  return (env) => evalDsl(ast, env);
}

/** Collect signal types referenced as the first argument of window functions (for subscriptions / indexing). */
export function dslSignalRefs(src: string): string[] {
  const out = new Set<string>();
  const walk = (e: DslExpr) => {
    if (e.k === "call") {
      const a = e.args[0];
      if (a?.k === "id" && ["count", "sum", "avg", "max", "rate", "last", "since", "distinct"].includes(e.fn)) {
        out.add(["sum", "avg", "max", "last", "distinct"].includes(e.fn) ? a.name.split(".").slice(0, 2).join(".") : a.name);
      }
      e.args.forEach(walk);
    } else if (e.k === "un") walk(e.e);
    else if (e.k === "bin") { walk(e.l); walk(e.r); }
  };
  walk(parseDsl(src));
  return [...out];
}

// Bosses (spec §3.4): phase plans over the manifest's engine moves + invented moves from the move grammar, mapped
// to engine move ids where the game has a matching move; counters to the player's habits (K1 traits + signals) and
// gear tags; persona-voiced taunts. Instant = the keyless rules composer (Counterforge composeMove); upgrade = one
// structured LLM call that invents the move and writes the taunt in the boss's voice.
import {
  MOVE_SHAPES, clampMove, cleanText, composeMove, hashString, moveJsonSchema,
  type AskParams, type AskResult, type BossMovePlan, type EngineMoveRef, type MoveShape, type MoveSpec,
} from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";
import type { AskContext, ScopedContext } from "../../module.js";
import { readPlayer, type PlayerRead } from "./habits.js";
import { currentAggression } from "./difficulty.js";
import { directorOptions } from "./options.js";
import { directorState, recordDecision } from "./state.js";
import { libraryBossPhase } from "../world/reactions-lib/index.js";

type EngineMoveCfg = Manifest["moves"]["engine"][number];
type BossCfg = Manifest["bosses"][number];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r2 = (v: number) => Math.round(v * 100) / 100;

/** The boss config from the manifest, or an ad-hoc one (every engine move) for an undeclared boss id. */
export function bossConfig(m: Manifest, id: string): BossCfg {
  return m.bosses.find((b) => b.id === id) ?? {
    id, name: id.replace(/[_-]+/g, " "), description: "", phases: 3, moves: m.moves.engine.map((e) => e.id), counters: [], maxInvented: 3,
  };
}

/** Engine moves available to a boss (its declared ones, else all of the manifest's). */
export function bossEngineMoves(m: Manifest, boss: BossCfg): EngineMoveCfg[] {
  const all = m.moves.engine;
  const own = boss.moves.length ? all.filter((e) => boss.moves.includes(e.id)) : all;
  return own.length ? own : all;
}

/** Shapes that punish each habit label (mirrors composeMove's plan table). */
const HABIT_SHAPES: Record<string, MoveShape[]> = {
  range_long: ["grab", "spikes", "beam"], ranged_camper: ["grab", "spikes", "beam"],
  dodges_left: ["projectile", "spikes"], dodges_right: ["projectile", "spikes"], dodger: ["ring", "projectile", "meteor"],
  range_close: ["ring", "slam"], berserker: ["ring", "slam"], turtle: ["meteor", "grab"], blocker: ["meteor", "grab"],
  stationary: ["meteor", "beam"], jumper: ["spikes", "beam"], masher: ["slam", "ring"], cover: ["meteor", "summon"],
  glass_cannon: ["projectile", "summon"], speedrunner: ["summon", "spikes"], chatterbox: ["projectile", "beam"],
};

/** Nearest allowed shape when the manifest restricts grammar shapes (moves.shapes). */
const SHAPE_FALLBACK: Record<MoveShape, MoveShape[]> = {
  slam: ["meteor", "ring", "spikes"], beam: ["projectile", "spikes", "ring"], projectile: ["beam", "meteor", "spikes"],
  ring: ["slam", "spikes", "meteor"], spikes: ["projectile", "ring", "meteor"], meteor: ["slam", "projectile", "spikes"],
  grab: ["slam", "spikes", "projectile"], summon: ["projectile", "meteor", "ring"],
};

/** Clamp options for this manifest. */
export function moveClampOptions(m: Manifest) {
  return { elements: m.elements, damageScale: m.moves.damageScale, engineMoves: m.moves.engine.map((e) => e.id) };
}

/** Re-shape a move into the manifest's allowed shapes (moves.shapes), re-clamped. */
export function restrictShape(m: Manifest, move: MoveSpec): MoveSpec {
  const allowed = m.moves.shapes;
  if (!allowed?.length || allowed.includes(move.shape)) return move;
  const shape = SHAPE_FALLBACK[move.shape].find((s) => allowed.includes(s)) ?? allowed[0];
  return clampMove({ ...move, shape }, moveClampOptions(m)) ?? move;
}

/** Fit a grammar value onto an engine param's bounds by the param's name. */
function engineParam(name: string, b: { min: number; max: number; default?: number }, move: MoveSpec, aggression: number): number {
  const n = name.toLowerCase();
  let t: number; // 0-1 position inside the bounds
  if (/count|amount|number|waves|projectiles|bolts/.test(n)) t = (move.count - 1) / 7;
  else if (/radius|size|area|arc|width|scale|range/.test(n)) t = (move.size - 0.6) / 1.2;
  else if (/speed|rate|velocity/.test(n)) t = (move.speed - 0.6) / 1.2;
  else if (/telegraph|delay|windup|warn/.test(n)) t = (move.telegraph - 0.6) / 1.0;
  else if (/damage|power|dmg/.test(n)) t = 0.5 + (aggression - 0.5) * 0.6;
  else if (/duration|time|seconds/.test(n)) t = 0.3 + aggression * 0.5;
  else t = b.default !== undefined && b.max > b.min ? (b.default - b.min) / (b.max - b.min) : 0.5;
  const v = b.min + clamp(t, 0, 1) * (b.max - b.min);
  return Number.isInteger(b.min) && Number.isInteger(b.max) ? Math.round(v) : r2(v);
}

/**
 * Engine mapping for a grammar move: the boss's engine move of the same shape (else any manifest engine move of that
 * shape), with params fitted to the designer's bounds. Null when the game has no matching engine move.
 */
export function mapToEngine(m: Manifest, boss: BossCfg, move: MoveSpec, aggression: number): EngineMoveRef | null {
  const own = bossEngineMoves(m, boss);
  const hit = own.find((e) => e.shape === move.shape) ?? m.moves.engine.find((e) => e.shape === move.shape);
  if (!hit) return null;
  const params: Record<string, number | string | boolean> = {};
  for (const [k, b] of Object.entries(hit.params)) params[k] = engineParam(k, b, move, aggression);
  params.element = move.element;
  return { moveId: hit.id, params };
}

/** Tune an engine move's params for a phase / aggression (no grammar move involved). */
function tuneEngine(e: EngineMoveCfg, phase: number, phases: number, aggression: number): EngineMoveRef {
  const params: Record<string, number | string | boolean> = {};
  const p = phases > 1 ? (phase - 1) / (phases - 1) : 1;
  for (const [k, b] of Object.entries(e.params)) {
    const def = b.default ?? (b.min + b.max) / 2;
    const v = def + (b.max - def) * p * (0.5 + aggression * 0.5);
    params[k] = Number.isInteger(b.min) && Number.isInteger(b.max) ? Math.round(clamp(v, b.min, b.max)) : r2(clamp(v, b.min, b.max));
  }
  return { moveId: e.id, params };
}

/** Engine-move weights: base 0.4, raised for shapes that punish the player's current habits. */
function engineWeights(moves: EngineMoveCfg[], read: PlayerRead): Record<string, number> {
  const w: Record<string, number> = {};
  for (const e of moves) {
    let s = 0.4;
    read.labels.slice(0, 3).forEach((label, i) => {
      if (e.shape && HABIT_SHAPES[label]?.includes(e.shape)) s += 0.35 / (i + 1);
    });
    w[e.id] = r2(clamp(s, 0.05, 1));
  }
  return w;
}

/** Counters in force: the boss's allowed counters that match the player's habits / traits / gear tags. */
function countersFor(boss: BossCfg, read: PlayerRead): string[] {
  const have = new Set([...read.labels, ...read.gear, ...(read.topElement ? [read.topElement.toLowerCase()] : [])].map((x) => x.toLowerCase()));
  const allowed = boss.counters.length ? boss.counters : [...have];
  return allowed.filter((c) => have.has(c.toLowerCase())).slice(0, 6);
}

const seedOf = (p: { seed?: number }, ...material: unknown[]) => (typeof p.seed === "number" ? p.seed >>> 0 : hashString(JSON.stringify(material)));

export interface Invented { move: MoveSpec; habit: string; engine: EngineMoveRef | null }

/** Compose one invented move with the rules composer (deterministic for the seed). */
function invent(ctx: ScopedContext, boss: BossCfg, phase: number, read: PlayerRead, existing: string[], attune: string | null, seed: number, aggression: number): Invented {
  const m = ctx.manifest;
  const { move: raw, habit } = composeMove({ phase, habits: read.habits, existing, attune, seed }, moveClampOptions(m));
  const move = restrictShape(m, raw);
  const engine = mapToEngine(m, boss, move, aggression);
  return { move, habit, engine };
}

/** Rotation after adding `added` (oldest invented moves drop beyond the boss's maxInvented). */
function rotation(prev: MoveSpec[], added: MoveSpec[], max: number): MoveSpec[] {
  const names = new Set(added.map((a) => a.name.toLowerCase()));
  return [...prev.filter((p) => !names.has(p.name.toLowerCase())), ...added].slice(-Math.max(0, max));
}

const PHASE_TAUNTS = [
  "You fight like a pattern. Patterns break.",
  "I have watched you long enough.",
  "Again? Then let us change the rules.",
  "Your habits are showing.",
];

// ------------------------------------------------------------------------------------------------ boss_phase

export interface PhasePlan {
  result: AskResult<"director.boss_phase">;
  why: string;
  invented: Invented[];
}

/** Keyless phase plan (and its side effects: rotation event, timeline, boss.move_added + boss.adapt directives). */
export function bossPhaseRules(ctx: AskContext, p: AskParams<"director.boss_phase">): PhasePlan {
  const m = ctx.manifest;
  const boss = bossConfig(m, p.boss);
  const phase = clamp(p.phase, 1, boss.phases);
  const read = readPlayer(ctx, ctx.player, p.habits, p.gear);
  const st = directorState(ctx).bosses[boss.id];
  const prev = st?.invented ?? [];
  const existing = [...new Set([...(p.existing ?? []), ...prev.map((x) => x.name), ...bossEngineMoves(m, boss).map((e) => e.name)])];
  const base = currentAggression(ctx);
  const hpPush = typeof p.hp === "number" && p.hp < 0.3 ? 0.05 : 0;
  const d = m.clamps.difficulty;
  const aggression = r2(clamp(base + 0.05 * (phase - 1) + hpPush, d.aggressionMin, d.aggressionMax));
  const attune = read.topElement;
  const seed = seedOf(p, boss.id, phase, ctx.player, read.labels);
  const opts = directorOptions(m, ctx.options);
  const invented: Invented[] = [];
  if (m.moves.grammar && boss.maxInvented > 0) {
    // phase 1 earns one move; later phases add inventPerPhase (rotation capped at maxInvented)
    const n = Math.min(boss.maxInvented, Math.max(1, opts.inventPerPhase));
    for (let i = 0; i < n; i++) {
      const inv = invent(ctx, boss, phase, read, [...existing, ...invented.map((x) => x.move.name)], attune, (seed + i * 7919) >>> 0, aggression);
      invented.push(inv);
    }
  }
  const engines = bossEngineMoves(m, boss);
  const weights = engineWeights(engines, read);
  const moves: BossMovePlan[] = engines.map((e) => ({ engine: tuneEngine(e, phase, boss.phases, aggression), weight: weights[e.id] }));
  const rot = rotation(prev, invented.map((x) => x.move), boss.maxInvented);
  for (const mv of rot) {
    const isNew = invented.find((x) => x.move.name === mv.name);
    const engine = isNew?.engine ?? mapToEngine(m, boss, mv, aggression);
    moves.push({ grammar: mv, ...(engine ? { engine } : {}), weight: isNew ? 0.9 : 0.6 });
  }
  const counters = countersFor(boss, read);
  const lead = invented[0];
  // Reaction Library (R1): boss_attempt_memory taunts by attempt count; flawless_secret_phase adds the secret move
  const lib = libraryBossPhase(ctx, boss.id);
  if (lib.secret) {
    const engine = mapToEngine(m, boss, lib.secret, aggression);
    moves.push({ grammar: lib.secret, ...(engine ? { engine } : {}), weight: 1 });
    if (!counters.includes("flawless")) counters.push("flawless");
  }
  const taunt = lib.taunt ?? (lead ? lead.move.taunt : PHASE_TAUNTS[seed % PHASE_TAUNTS.length]);
  const result: AskResult<"director.boss_phase"> = { boss: boss.id, phase, moves, aggression, counters, attune, taunt };
  const why = [
    lib.why ?? "",
    lib.secret ? `secret move ${lib.secret.name} (flawless_secret_phase)` : "",
    lead ? `invented ${lead.move.name} (${lead.move.shape}/${lead.move.pattern}) vs ${lead.habit}` : "engine moves only",
    counters.length ? `counters ${counters.join(", ")}` : "",
    attune ? `attuned to ${attune}` : "",
    read.evidence.length ? `read: ${read.evidence.join("; ")}` : "",
  ].filter(Boolean).join(" | ");
  return { result, why, invented };
}

/** Persist + announce a phase plan (rotation, timeline, directives). */
export function commitPhase(ctx: AskContext, plan: AskResult<"director.boss_phase">, added: Invented[], why: string, source: "rules" | "ai", replaces: string[] = []): void {
  const boss = bossConfig(ctx.manifest, plan.boss);
  const gone = new Set(replaces.map((r) => r.toLowerCase()));
  const prev = (directorState(ctx).bosses[boss.id]?.invented ?? []).filter((p) => !gone.has(p.name.toLowerCase()));
  const rot = rotation(prev, added.map((a) => a.move), boss.maxInvented);
  ctx.record("lf.director.boss", { boss: boss.id, phase: plan.phase, invented: rot, attune: plan.attune ?? null });
  recordDecision(ctx, {
    kind: "boss_phase", source, summary: `${boss.name} phase ${plan.phase}: ${added.map((a) => a.move.name).join(", ") || "rotation tuned"}`,
    why, data: { boss: boss.id, phase: plan.phase, counters: plan.counters, aggression: plan.aggression },
  });
  for (const a of added) {
    ctx.emit({ kind: "boss.move_added", target: `boss:${boss.id}`, args: { boss: boss.id, move: a.move, ...(a.engine ? { engineMove: a.engine } : {}) }, why: `${a.move.name} punishes ${a.habit}${replaces.length ? ` (replaces ${replaces.join(", ")})` : ""}`.slice(0, 200) });
  }
  const weights: Record<string, number> = {};
  for (const mv of plan.moves) {
    const key = mv.grammar?.name ?? mv.engine?.moveId;
    if (key) weights[key] = mv.weight;
  }
  ctx.emit({
    kind: "boss.adapt", target: `boss:${boss.id}`,
    args: { boss: boss.id, aggression: plan.aggression, attune: plan.attune ? plan.attune.slice(0, 24) : null, weights, ...(plan.taunt ? { taunt: plan.taunt } : {}) },
    why: why.slice(0, 200) || "phase plan",
  });
}

// ------------------------------------------------------------------------------------------------ boss_move

/** Keyless single invented move (+ engine mapping). */
export function bossMoveRules(ctx: AskContext, p: AskParams<"director.boss_move">): { result: AskResult<"director.boss_move">; why: string; inv: Invented } {
  const m = ctx.manifest;
  const boss = bossConfig(m, p.boss);
  const read = readPlayer(ctx, ctx.player, p.habits);
  const prev = directorState(ctx).bosses[boss.id]?.invented ?? [];
  const existing = [...new Set([...(p.existing ?? []), ...prev.map((x) => x.name)])];
  const aggression = currentAggression(ctx);
  const attune = p.attune === undefined ? read.topElement : p.attune;
  const inv = invent(ctx, boss, clamp(p.phase, 1, 9), read, existing, attune ?? null, seedOf(p, boss.id, p.phase, ctx.player, existing), aggression);
  const result: AskResult<"director.boss_move"> = { boss: boss.id, move: inv.move, ...(inv.engine ? { engineMove: inv.engine } : {}) };
  return { result, inv, why: `${inv.move.name} (${inv.move.shape}/${inv.move.pattern}, ${inv.move.element}) punishes ${inv.habit}${read.evidence.length ? ` | read: ${read.evidence.join("; ")}` : ""}` };
}

/** Persist + announce a single invented move. */
export function commitMove(ctx: AskContext, bossId: string, phase: number, inv: Invented, why: string, source: "rules" | "ai", replaces?: string): void {
  const boss = bossConfig(ctx.manifest, bossId);
  const st = directorState(ctx).bosses[boss.id];
  const prev = (st?.invented ?? []).filter((x) => x.name !== replaces);
  ctx.record("lf.director.boss", { boss: boss.id, phase: st?.phase ?? phase, invented: rotation(prev, [inv.move], boss.maxInvented), attune: st?.attune ?? null });
  recordDecision(ctx, { kind: "boss_move", source, summary: `${boss.name} learns ${inv.move.name}`, why, data: { boss: boss.id, move: inv.move.name, shape: inv.move.shape } });
  ctx.emit({ kind: "boss.move_added", target: `boss:${boss.id}`, args: { boss: boss.id, move: inv.move, ...(inv.engine ? { engineMove: inv.engine } : {}) }, why: `${inv.move.name} punishes ${inv.habit}${replaces ? ` (replaces ${replaces})` : ""}`.slice(0, 200) });
}

// ------------------------------------------------------------------------------------------------ AI upgrade

/** Structured schema for the Director's move invention (manifest elements / shapes / engine ids). */
export function directorMoveSchema(m: Manifest, engineIds: string[]) {
  const move = moveJsonSchema(m.elements.length ? m.elements : undefined);
  const shapes = m.moves.shapes?.length ? m.moves.shapes : [...MOVE_SHAPES];
  const moveSchema = { ...move, properties: { ...move.properties, shape: { type: "string", enum: shapes } } };
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      read: { type: "string" },
      taunt: { type: "string" },
      attune: { type: "string", enum: [...m.elements, "none"] },
      move: moveSchema,
      weights: {
        type: "array",
        items: { type: "object", additionalProperties: false, properties: { moveId: engineIds.length ? { type: "string", enum: engineIds } : { type: "string" }, weight: { type: "number" } }, required: ["moveId", "weight"] },
      },
    },
    required: ["read", "taunt", "attune", "move", "weights"],
  };
}

const SYSTEM_CACHE = new WeakMap<Manifest, Map<string, string>>();

/** Stable per-boss system prompt (lore, tone, persona voice, grammar, engine moves, safety). */
export function directorSystem(m: Manifest, bossId: string): string {
  let byBoss = SYSTEM_CACHE.get(m);
  if (!byBoss) SYSTEM_CACHE.set(m, (byBoss = new Map()));
  const hit = byBoss.get(bossId);
  if (hit) return hit;
  const boss = bossConfig(m, bossId);
  const persona = boss.persona ? m.personas.find((p) => p.id === boss.persona) : undefined;
  const engines = bossEngineMoves(m, boss);
  const shapes = m.moves.shapes?.length ? m.moves.shapes : [...MOVE_SHAPES];
  const s = `You are the Director of "${m.game.name}", voicing the boss ${boss.name}${boss.description ? ` (${boss.description})` : ""}. You adapt the boss to how the player fights: you invent ONE new attack that punishes the player's strongest habit, re-weight the boss's engine moves, and write one taunt.
WORLD: ${m.lore.bible.slice(0, 1600)}
TONE: ${m.lore.tone}.${persona ? `\nVOICE: the taunt is spoken as ${persona.name} (${persona.role}): ${persona.personality} Style: ${persona.voice.style ?? "their own"}.` : ""}
SAFETY: rating ${m.safety.rating}. Never cruel about real people, never hateful or sexual.
The user message is JSON: {phase, hp, habits, read (habit / trait labels), gear (tags), counters (what this boss may counter), existing (move names: never repeat one), attune, engineMoves}. habits: range shares close/mid/long, dodgeLeft (0.5 balanced), dodgeRate and jumpRate per minute, blockRate, stationary, spam (attacks / s), coverShare, playerHp, deaths.
MOVE GRAMMAR (the engine runs only this): name (2-3 evocative words, max 32 chars); taunt (max 90 chars, names the habit it punishes); shape: ${shapes.join(", ")} (slam = pounds circles; beam = low sweeping laser; projectile = bolts; ring = expanding shockwaves to jump; spikes = ground spikes in sequence; meteor = marked circles from the sky; grab = lunge grab; summon = small minions); element: ${m.elements.join(", ")}; pattern: single, fan, line, spiral, burst, ring; count 1-8; telegraph 0.6-1.6 s (never unreadable); speed / size 0.6-1.8; damage_budget per hit (the server clamps it to a budget); status: none, burning, chilled, charged, wet, oiled, poisoned, slowed; bias: none, left, right (lean a fan toward the side the player dodges to).
Punish the strongest habit: ranged camping -> grab or a fast spikes line; one-sided dodging -> a fan biased to that side; close range -> rings; blocking -> meteors; standing still -> spiral meteors; jumping -> spikes; mashing -> slam burst; hiding in cover -> meteors. Higher phases: more count, more speed.
ENGINE MOVES the boss already has (weights 0-1 favour the ones that punish the player): ${engines.map((e) => `${e.id} (${e.name}${e.shape ? `, ${e.shape}` : ""})`).join("; ") || "none"}.
taunt (the phase taunt, max 140 chars) and read (a short factual read of the playstyle, max 120 chars). attune: the element to resist (the player's favourite) or none. Output only the JSON object.`;
  byBoss.set(bossId, s);
  return s;
}

export interface AiMove { move: MoveSpec; taunt: string; read: string; attune: string | null; weights: Record<string, number> }

/** One LLM call -> clamped move + taunt + weights; null on any failure (rules answer stands). */
export async function aiMove(ctx: AskContext, bossId: string, user: Record<string, unknown>, existing: string[]): Promise<AiMove | null> {
  if (!ctx.llm) return null;
  const m = ctx.manifest;
  const boss = bossConfig(m, bossId);
  const engineIds = bossEngineMoves(m, boss).map((e) => e.id);
  let raw: unknown;
  try {
    const r = await ctx.llm.json(directorMoveSchema(m, engineIds), directorSystem(m, bossId), JSON.stringify(user), {
      tier: "fast", maxTokens: 450, signal: ctx.signal, task: ctx.kind,
    });
    raw = r.value;
  } catch (e) {
    ctx.log.debug("director llm failed, keeping rules answer", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const clamped = clampMove(o.move, moveClampOptions(m));
  if (!clamped || existing.some((n) => n.toLowerCase() === clamped.name.toLowerCase())) return null;
  const move = restrictShape(m, clamped);
  const check = async (t: string) => {
    if (!t) return t;
    const v = await ctx.moderation.check(t, { direction: "output", manifest: m });
    return v.ok ? t : "";
  };
  move.taunt = (await check(move.taunt)) || `Behold: ${move.name}.`;
  const weights: Record<string, number> = {};
  if (Array.isArray(o.weights)) {
    for (const w of o.weights) {
      if (w && typeof w === "object" && engineIds.includes(String((w as Record<string, unknown>).moveId))) {
        weights[String((w as Record<string, unknown>).moveId)] = r2(clamp(Number((w as Record<string, unknown>).weight) || 0, 0.05, 1));
      }
    }
  }
  const attuneRaw = typeof o.attune === "string" ? o.attune : "none";
  return {
    move,
    taunt: await check(cleanText(o.taunt, 200)),
    read: cleanText(o.read, 120),
    attune: m.elements.find((e) => e.toLowerCase() === attuneRaw.toLowerCase()) ?? null,
    weights,
  };
}

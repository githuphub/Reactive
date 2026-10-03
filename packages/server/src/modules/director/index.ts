// Module "director" - OWNER: K3. Only edit files inside packages/server/src/modules/director/.
// Director: boss move grammar + phase plans, squad tactics, pacing / tension, difficulty - every decision with a why.
// Contract: docs/CONTRACTS.md. Asks owned here: director.boss_phase, director.boss_move, director.encounter, director.pacing.
// Projections owned here: director.state (world; DirectorState).
//
// How it works (spec §3.4):
//  - director.boss_phase / boss_move: invented moves through the move grammar (instant: the keyless composeMove rules
//    composer; upgrade: one LLM call in the boss persona's voice), mapped onto the manifest's engine moves
//    (moves.engine) with params fitted to the designer bounds; counters to habits (Observer traits + combat signals)
//    and gear tags; `boss.move_added` + `boss.adapt` directives.
//  - director.encounter: squad tactics per unit + counter elite modifiers (options.tactics / options.eliteModifiers).
//  - director.pacing: tension curve (build -> peak -> relax) -> spawn.wave / pacing.breather / loot.drop directives
//    within clamps.pacing. The "pacing" tick samples tension for active players (and drives pacing on its own when
//    options.autoPacing is true) and adapts difficulty.
//  - difficulty: aggression within clamps.difficulty, modes hidden / assist / off (POST /v1/m/director/assist,
//    POST /admin/m/director/difficulty). Every decision lands on the director.state timeline with its `why`.
import { Hono } from "hono";
import type { AskResult, LooseDirectiveDraft } from "@liveforge/protocol";
import { defineModule, type LfEnv, type ModuleContext, type ScopedContext } from "../../module.js";
import { aiMove, bossConfig, bossEngineMoves, bossMoveRules, bossPhaseRules, commitMove, commitPhase, mapToEngine } from "./boss.js";
import { encounterAi, encounterRules } from "./encounter.js";
import { pacingDecision, measureIntensity, stepTension } from "./pacing.js";
import { adaptDifficulty, currentAggression, currentMode, setDifficulty, type DifficultyMode } from "./difficulty.js";
import { directorOptions } from "./options.js";
import { directorState, directorStateProjection, recordDecision } from "./state.js";
import { readPlayer } from "./habits.js";

const contexts = new Map<string, ModuleContext>();

/** A world/player-scoped view of a module context (for routes). */
function scoped(ctx: ModuleContext, world: string, player: string | null): ScopedContext {
  return {
    ...ctx,
    world, player, session: null,
    emit: (d, s) => ctx.emit(d, { world: s?.world ?? world, player: s && "player" in s ? s.player ?? null : player }),
    record: (t, data, s) => ctx.record(t, data, { world: s?.world ?? world, player: s && "player" in s ? s.player ?? null : player }),
  } as ScopedContext;
}

/** Push the pacing result's directives (validated by the core; rejected drafts are logged and skipped). */
function emitAll(ctx: ScopedContext, drafts: LooseDirectiveDraft[], player: string | null) {
  for (const d of drafts) ctx.emit(d, { world: ctx.world, player });
}

const errBody = (code: string, message: string) => ({ error: { code, message } });
const WORLD_RE = /^[A-Za-z0-9_\-.:]{1,64}$/;

const admin = new Hono<LfEnv>();
/** POST /admin/m/director/difficulty {world, mode?: hidden|assist|off, aggression?: 0-1, why?} */
admin.post("/difficulty", async (c) => {
  const ctx = contexts.get(c.get("game"));
  if (!ctx) return c.json(errBody("module_disabled", "director is not enabled for this game"), 404);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof b.world !== "string" || !WORLD_RE.test(b.world)) return c.json(errBody("bad_request", "world is required"), 400);
  const sc = scoped(ctx, b.world, null);
  const mode = (["hidden", "assist", "off"].includes(String(b.mode)) ? b.mode : currentMode(sc)) as DifficultyMode;
  const aggression = typeof b.aggression === "number" ? b.aggression : currentAggression(sc);
  const applied = setDifficulty(sc, { aggression, mode, why: typeof b.why === "string" && b.why ? b.why.slice(0, 200) : `designer set ${mode}` });
  return c.json({ world: b.world, mode, aggression: applied });
});

const pub = new Hono<LfEnv>();
/** POST /v1/m/director/assist {world, player, on} - the player's explicit assist toggle (spec: explicit assist mode). */
pub.post("/assist", async (c) => {
  const ctx = contexts.get(c.get("game"));
  if (!ctx) return c.json(errBody("module_disabled", "director is not enabled for this game"), 404);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof b.world !== "string" || !WORLD_RE.test(b.world)) return c.json(errBody("bad_request", "world is required"), 400);
  const player = typeof b.player === "string" && WORLD_RE.test(b.player) ? b.player : null;
  const sc = scoped(ctx, b.world, player);
  const on = b.on !== false;
  const d = ctx.manifest.clamps.difficulty;
  const mode: DifficultyMode = on ? "assist" : ctx.manifest.clamps.difficulty.mode === "assist" ? "hidden" : ctx.manifest.clamps.difficulty.mode;
  const aggression = on ? d.aggressionMin : (d.aggressionMin + d.aggressionMax) / 2;
  const applied = setDifficulty(sc, { aggression, mode, why: on ? "player turned assist on" : "player turned assist off", player: null });
  return c.json({ world: b.world, mode, aggression: applied });
});

export default defineModule({
  id: "director",
  description: "Director: boss move grammar + phase plans, squad tactics, pacing / tension, difficulty - every decision with a why.",
  projections: [directorStateProjection],
  signalHandlers: [],
  asks: {
    "director.boss_phase": {
      instant(ctx, p) {
        const plan = bossPhaseRules(ctx, p);
        commitPhase(ctx, plan.result, plan.invented, plan.why, "rules");
        // remembered for the upgrade (which replaces the rules-invented moves); only when an upgrade can run
        if (ctx.llm && plan.invented.length) ctx.kv.set(`ask:${ctx.askId}`, plan.invented.map((x) => x.move.name));
        return { result: plan.result, why: plan.why.slice(0, 300), source: "rules" };
      },
      async upgrade(ctx, p, instant) {
        const m = ctx.manifest;
        const replaced = ctx.kv.get<string[]>(`ask:${ctx.askId}`) ?? [];
        ctx.kv.delete(`ask:${ctx.askId}`);
        if (!m.moves.grammar || !replaced.length) return null;
        const boss = bossConfig(m, p.boss);
        const read = readPlayer(ctx, ctx.player, p.habits, p.gear);
        const prev = directorState(ctx).bosses[boss.id]?.invented ?? [];
        const existing = [...new Set([...(p.existing ?? []), ...prev.map((x) => x.name).filter((n) => !replaced.includes(n)), ...bossEngineMoves(m, boss).map((e) => e.name)])];
        const ai = await aiMove(ctx, boss.id, {
          phase: instant.phase, hp: p.hp ?? null, habits: read.habits, read: read.labels, gear: read.gear, counters: instant.counters,
          existing, attune: instant.attune ?? null, engineMoves: bossEngineMoves(m, boss).map((e) => e.id),
        }, existing);
        if (!ai) return null;
        const engine = mapToEngine(m, boss, ai.move, instant.aggression);
        const moves = instant.moves
          .filter((mv) => !(mv.grammar && replaced.includes(mv.grammar.name)))
          .map((mv) => (mv.engine && !mv.grammar && ai.weights[mv.engine.moveId] !== undefined ? { ...mv, weight: ai.weights[mv.engine.moveId] } : mv));
        moves.push({ grammar: ai.move, ...(engine ? { engine } : {}), weight: 0.9 });
        const result: AskResult<"director.boss_phase"> = {
          ...instant, moves, attune: ai.attune ?? instant.attune ?? null, taunt: ai.taunt || ai.move.taunt,
        };
        const why = `AI: ${ai.move.name} (${ai.move.shape}/${ai.move.pattern})${ai.read ? ` | read: ${ai.read}` : ""}`;
        commitPhase(ctx, result, [{ move: ai.move, habit: ai.read || "your habits", engine }], why, "ai", replaced);
        return { result, why: why.slice(0, 300) };
      },
      cacheKey: () => false,
    },
    "director.boss_move": {
      instant(ctx, p) {
        const { result, why, inv } = bossMoveRules(ctx, p);
        commitMove(ctx, p.boss, p.phase, inv, why, "rules");
        return { result, why: why.slice(0, 300), source: "rules" };
      },
      async upgrade(ctx, p, instant) {
        const m = ctx.manifest;
        if (!m.moves.grammar) return null;
        const boss = bossConfig(m, p.boss);
        const read = readPlayer(ctx, ctx.player, p.habits);
        const prev = directorState(ctx).bosses[boss.id]?.invented ?? [];
        const existing = [...new Set([...(p.existing ?? []), ...prev.map((x) => x.name).filter((n) => n !== instant.move.name)])];
        const ai = await aiMove(ctx, boss.id, {
          phase: p.phase, habits: read.habits, read: read.labels, gear: read.gear, counters: boss.counters, existing,
          attune: p.attune ?? read.topElement ?? null, engineMoves: bossEngineMoves(m, boss).map((e) => e.id),
        }, existing);
        if (!ai) return null;
        const engine = mapToEngine(m, boss, ai.move, currentAggression(ctx));
        const why = `AI: ${ai.move.name} (${ai.move.shape}/${ai.move.pattern})${ai.read ? ` | read: ${ai.read}` : ""}`;
        commitMove(ctx, boss.id, p.phase, { move: ai.move, habit: ai.read || "your habits", engine }, why, "ai", instant.move.name);
        return { result: { boss: boss.id, move: ai.move, ...(engine ? { engineMove: engine } : {}) }, why: why.slice(0, 300) };
      },
      cacheKey: () => false,
    },
    "director.encounter": {
      instant(ctx, p) {
        const { result, why } = encounterRules(ctx, p);
        recordDecision(ctx, { kind: "encounter", source: "rules", summary: `${p.units.length} units${p.encounter ? ` (${p.encounter})` : ""}: ${[...new Set(result.assignments.map((a) => a.tactic))].join(", ")}`, why, data: { modifiers: result.modifiers } });
        return { result, why: why.slice(0, 300), source: "rules" };
      },
      async upgrade(ctx, p, instant) {
        const out = await encounterAi(ctx, p, instant);
        if (!out) return null;
        recordDecision(ctx, { kind: "encounter", source: "ai", summary: `${p.units.length} units: ${[...new Set(out.result.assignments.map((a) => a.tactic))].join(", ")}`, why: out.why, data: { modifiers: out.result.modifiers } });
        return { result: out.result, why: out.why.slice(0, 300) };
      },
      cacheKey: () => false,
    },
    "director.pacing": {
      instant(ctx, p) {
        const { result, why } = pacingDecision(ctx, p, ctx.player);
        emitAll(ctx, result.directives, ctx.player);
        return { result, why: why.slice(0, 300), source: "rules", final: true };
      },
      cacheKey: () => false,
    },
  },
  ticks: [
    {
      name: "pacing",
      everyMs: 5000,
      run(ctx) {
        const opts = directorOptions(ctx.manifest, ctx.options);
        for (const player of ctx.activePlayers.slice(0, 64)) {
          if (opts.autoPacing) {
            const { result } = pacingDecision(ctx, {}, player);
            emitAll(ctx, result.directives, player);
          } else {
            stepTension(ctx, player, measureIntensity(ctx, player, {}).value);
          }
        }
        adaptDifficulty(ctx, ctx.activePlayers);
      },
    },
  ],
  routes: { admin, public: pub },
  init(ctx) {
    contexts.set(ctx.game, ctx);
  },
});

export { bossPhaseRules, bossMoveRules, mapToEngine, restrictShape } from "./boss.js";
export { encounterRules } from "./encounter.js";
export { pacingDecision } from "./pacing.js";
export { directorOptions, type DirectorOptions, type EliteModifier } from "./options.js";

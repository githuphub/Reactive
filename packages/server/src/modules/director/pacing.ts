// Pacing (spec §3.4): a tension curve projected from intensity signals, driving a build -> peak -> relax cycle
// (the classic AI-director loop) that turns into spawn / breather / loot directives, always inside the manifest's
// budgets (clamps.pacing: maxSpawnPerMin, maxWaveSize, breatherSec, lootPerMin). Rules only: this is a real-time
// control loop, so the answer is final (no LLM upgrade).
import type { AskParams, AskResult, LooseDirectiveDraft } from "@liveforge/protocol";
import type { ScopedContext } from "../../module.js";
import { currentAggression } from "./difficulty.js";
import { directorOptions } from "./options.js";
import { recordDecision } from "./state.js";
import { forgeEnv } from "../forge/env.js";
import { forgeLootRules } from "../forge/items.js";

type Phase = "build" | "peak" | "relax";

/** Per (world, player) pacing memory (module kv; not rebuilt from the log). */
interface PacingMemory {
  tension: number;
  ts: number;
  phase: Phase;
  phaseSince: number;
  /** relax ends at this time (ms). */
  relaxUntil: number;
  spawns: { ts: number; n: number }[];
  loots: number[];
  lastSample: number;
  lastSampleValue: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r2 = (v: number) => Math.round(v * 100) / 100;
const PEAK = 0.75;
const CALM = 0.3;

/**
 * Intensity 0-1 of the last 30 s for a player from combat signals: damage taken, hits, kills, low HP, plus the
 * game's enemiesAlive. A game that measures intensity itself passes `intensity` instead.
 */
export function measureIntensity(ctx: ScopedContext, player: string | null, p: { enemiesAlive?: number; playerHp?: number }): { value: number; hp: number } {
  if (!player) return { value: clamp((p.enemiesAlive ?? 0) * 0.08, 0, 1), hp: p.playerHp ?? 1 };
  const now = ctx.now();
  let hurt = 0, hits = 0, kills = 0, hp = p.playerHp ?? 1;
  for (const e of ctx.events({ world: ctx.world, player, type: "combat.*", since: now - 30_000, limit: 300 })) {
    if (e.type === "combat.hurt") { hurt++; if (p.playerHp === undefined && typeof e.data.hp === "number") hp = e.data.hp; }
    else if (e.type === "combat.hit") hits++;
    else if (e.type === "combat.killed") kills++;
  }
  const value = clamp(hurt * 0.07 + hits * 0.02 + kills * 0.06 + (p.enemiesAlive ?? 0) * 0.06 + (1 - clamp(hp, 0, 1)) * 0.35, 0, 1);
  return { value, hp };
}

/** EWMA toward the intensity: fast attack (tau 6 s), slow decay (tau 18 s). */
function follow(prev: number, target: number, dtMs: number): number {
  const tau = target > prev ? 6000 : 18000;
  return prev + (target - prev) * (1 - Math.exp(-Math.max(0, dtMs) / tau));
}

function memoryKey(ctx: ScopedContext, player: string | null) {
  return `pacing:${ctx.world}:${player ?? "_world"}`;
}

/** Advance the tension curve for a player (recording a sample when it moved). Returns the memory. */
export function stepTension(ctx: ScopedContext, player: string | null, intensity: number): PacingMemory {
  const now = ctx.now();
  const key = memoryKey(ctx, player);
  const mem: PacingMemory = ctx.kv.get<PacingMemory>(key) ?? {
    tension: intensity * 0.5, ts: now, phase: "build", phaseSince: now, relaxUntil: 0, spawns: [], loots: [], lastSample: 0, lastSampleValue: -1,
  };
  mem.tension = r2(clamp(follow(mem.tension, intensity, now - mem.ts), 0, 1));
  mem.ts = now;
  if (Math.abs(mem.tension - mem.lastSampleValue) >= 0.03 || now - mem.lastSample > 15_000) {
    ctx.record("lf.director.tension", { value: mem.tension, ...(player ? { player } : {}) }, { world: ctx.world, player });
    mem.lastSample = now;
    mem.lastSampleValue = mem.tension;
  }
  ctx.kv.set(key, mem);
  return mem;
}

/** Spawn table for a zone (director options spawnTable[zone] -> default -> "minion"). */
function spawnTypes(ctx: ScopedContext, zone: string | undefined): string[] {
  const t = directorOptions(ctx.manifest, ctx.options).spawnTable;
  return (zone && t[zone]) || t.default || ["minion"];
}

/**
 * One pacing decision. Phases: build (spawn waves while tension < 0.75, within the per-minute spawn budget; long calm
 * -> escalate), peak (hold up to peakSec, or until HP < 25 %), relax (a breather of breatherSec scaled by how hard the
 * peak was, a loot drop if the loot budget allows), then build again once tension < 0.3.
 */
export function pacingDecision(ctx: ScopedContext, p: AskParams<"director.pacing">, player: string | null): { result: AskResult<"director.pacing">; why: string } {
  const m = ctx.manifest;
  const c = m.clamps.pacing;
  const opts = directorOptions(m, ctx.options);
  const now = ctx.now();
  const measured = measureIntensity(ctx, player, p);
  const intensity = p.intensity ?? measured.value;
  const hp = p.playerHp ?? measured.hp;
  const mem = stepTension(ctx, player, intensity);
  const aggression = currentAggression(ctx);
  mem.spawns = mem.spawns.filter((s) => now - s.ts < 60_000);
  mem.loots = mem.loots.filter((t) => now - t < 60_000);
  const spawnedLastMin = mem.spawns.reduce((a, s) => a + s.n, 0);
  const directives: LooseDirectiveDraft[] = [];
  let action: AskResult<"director.pacing">["action"] = "hold";
  let why = "";
  const enter = (ph: Phase) => { mem.phase = ph; mem.phaseSince = now; };

  if (mem.phase === "build" && (mem.tension >= PEAK || hp < 0.25)) enter("peak");
  if (mem.phase === "peak" && (now - mem.phaseSince > opts.peakSec * 1000 || hp < 0.25)) {
    enter("relax");
    const [lo, hi] = c.breatherSec;
    const hard = clamp((mem.tension - 0.5) * 2 + (hp < 0.25 ? 0.4 : 0), 0, 1);
    const seconds = Math.round(lo + (hi - lo) * hard);
    mem.relaxUntil = now + seconds * 1000;
    const loot = mem.loots.length < Math.floor(c.lootPerMin) || (c.lootPerMin > 0 && mem.loots.length === 0);
    directives.push({ kind: "pacing.breather", target: player ? "player" : "world", args: { seconds: Math.max(1, seconds), loot }, why: `tension peaked at ${mem.tension.toFixed(2)}${hp < 0.25 ? `, hp ${Math.round(hp * 100)}%` : ""}: ${seconds}s breather` });
    action = "breather";
    why = `peak over (${mem.tension.toFixed(2)}${hp < 0.25 ? `, low hp` : ""}) -> ${seconds}s breather`;
    if (loot && c.lootPerMin > 0) {
      const env = forgeEnv(m, {});
      const items = forgeLootRules(env, { zone: p.zone }, 1, (now >>> 0) ^ 0x5f3759df);
      directives.push({ kind: "loot.drop", target: player ? "player" : "world", args: { items, from: "director" }, why: "breather reward" });
      mem.loots.push(now);
    }
  } else if (mem.phase === "relax") {
    if (now >= mem.relaxUntil && mem.tension < CALM) {
      enter("build");
    } else {
      action = "hold";
      why = `relaxing (${Math.max(0, Math.round((mem.relaxUntil - now) / 1000))}s left, tension ${mem.tension.toFixed(2)})`;
    }
  } else if (mem.phase === "peak") {
    action = "hold";
    why = `at peak (${mem.tension.toFixed(2)}) for ${Math.round((now - mem.phaseSince) / 1000)}s`;
  }

  if (mem.phase === "build" && action === "hold" && !why) {
    const budget = c.maxSpawnPerMin - spawnedLastMin;
    const lastSpawn = mem.spawns.length ? mem.spawns[mem.spawns.length - 1].ts : 0;
    const gapMs = 4000 + (1 - aggression) * 8000; // aggressive directors spawn more often
    if (budget > 0 && now - lastSpawn > gapMs && (p.enemiesAlive ?? 0) < c.maxWaveSize) {
      const calmFor = now - mem.phaseSince;
      const escalate = mem.tension < 0.15 && calmFor > 45_000;
      const size = Math.max(1, Math.min(c.maxWaveSize, budget, Math.round(1 + aggression * 3 + (1 - mem.tension) * 2 + (escalate ? 2 : 0))));
      const types = spawnTypes(ctx, p.zone);
      const units: { type: string; count: number; elite?: boolean }[] = [];
      let left = size;
      for (let i = 0; left > 0 && i < types.length; i++) {
        const n = i === types.length - 1 ? left : Math.max(1, Math.round(left / (types.length - i)));
        units.push({ type: types[i], count: Math.min(n, left), ...(escalate && i === 0 ? { elite: true } : {}) });
        left -= n;
      }
      directives.push({ kind: "spawn.wave", target: p.zone ? `spawner:${p.zone}` : "world", args: { ...(p.zone ? { zone: p.zone } : {}), units }, why: `tension ${mem.tension.toFixed(2)} < ${PEAK}: wave of ${size}${escalate ? " (escalating: player cruising)" : ""}` });
      mem.spawns.push({ ts: now, n: size });
      action = escalate ? "escalate" : "spawn";
      why = `building: tension ${mem.tension.toFixed(2)}, wave ${size} (${spawnedLastMin + size}/${c.maxSpawnPerMin} per min)`;
    } else {
      why = budget <= 0 ? `spawn budget used (${spawnedLastMin}/${c.maxSpawnPerMin} per min)` : `building: tension ${mem.tension.toFixed(2)}, next wave soon`;
    }
  }
  ctx.kv.set(memoryKey(ctx, player), mem);
  if (action !== "hold") {
    recordDecision(ctx, { kind: "pacing", source: "rules", summary: `${action} (tension ${mem.tension.toFixed(2)})`, why: why || action, data: { tension: mem.tension, phase: mem.phase, intensity: r2(intensity) } });
  }
  return { result: { tension: mem.tension, action, directives, aggression }, why: why || `${mem.phase}: tension ${mem.tension.toFixed(2)}` };
}

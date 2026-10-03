// Moment detection (spec §3.1): built-in detectors over the event stream + designer moments / traits from the
// manifest DSL. A moment is recorded as "lf.observer.moment" (folded into the player model) and pushed to the
// player as a `moment` directive. Detectors run in signal handlers / ticks (they may read the log and kv).
import { hashString, type Moment, type PersonaMemories, type StoredEvent } from "@liveforge/protocol";
import { moduleOptions } from "@liveforge/manifest";
import type { EventContext, ScopedContext } from "../../module.js";
import { compileRule, evalRule, makeDslEnv, ruleWatches, type LiveDslEnv } from "../../dsl/index.js";
import { OBS_EVENTS, readModel } from "./model.js";
import { observerOptions, type ObserverOptions } from "./traits.js";
import { traitAt } from "./view.js";

type Ctx = ScopedContext;

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** kv keys (module-private, per world + player). */
const K = {
  nearDeath: (w: string, p: string) => `nd:${w}:${p}`,
  cooldown: (w: string, p: string, k: string) => `mcd:${w}:${p}:${k}`,
  designer: (w: string, p: string) => `dsl:${w}:${p}`,
};

interface NearDeath { ts: number; hp: number; source: string }

export interface FireOptions {
  evidence: string[];
  salience: number;
  why: string;
  data?: Record<string, unknown>;
  /** Cooldown key suffix (default: kind). */
  cooldownKey?: string;
  /** Override the cooldown in seconds (0 = none). */
  cooldownSec?: number;
  /** Seed for the moment id (default: now). */
  seed?: string | number;
}

/**
 * Record + push a moment for the context's player (respecting the per-kind cooldown). Returns the moment, or
 * null when it was suppressed by the cooldown.
 */
export function fireMoment(ctx: Ctx, kind: string, o: FireOptions): Moment | null {
  const player = ctx.player;
  if (!player) return null;
  const opts = observerOptions(moduleOptions(ctx.manifest, "observer"));
  const now = ctx.now();
  const cdKey = K.cooldown(ctx.world, player, o.cooldownKey ?? kind);
  const cdSec = o.cooldownSec ?? opts.momentCooldownSec;
  if (cdSec > 0) {
    const last = ctx.kv.get<number>(cdKey);
    if (last && now - last < cdSec * 1000) return null;
  }
  ctx.kv.set(cdKey, now);
  const moment: Moment = {
    id: `m_${hashString(`${ctx.world}:${player}:${kind}:${o.seed ?? now}`).toString(36)}`,
    kind: kind.slice(0, 48),
    ts: now,
    evidence: o.evidence.map((e) => e.slice(0, 160)).slice(0, 5),
    salience: Math.min(1, Math.max(0, o.salience)),
    ...(o.data ? { data: o.data } : {}),
  };
  ctx.record(OBS_EVENTS.moment, { moment }, { world: ctx.world, player });
  ctx.emit({ kind: "moment", target: "player", args: { moment }, why: o.why.slice(0, 200) }, { world: ctx.world, player });
  ctx.log.debug("moment", { kind, player, why: o.why });
  return moment;
}

// ---------------------------------------------------------------- built-in detectors

const ABANDON = /abandon|gave up|give up|refus|ignor|betray|declin|timeout|time out|expired|walked away|broke/i;

function npcAttitude(ctx: Ctx, npc: string): { attitude: number; friendly: boolean } {
  try {
    const mem = ctx.projections.get<PersonaMemories>("persona.memories", { world: ctx.world, player: ctx.player });
    const m = mem?.npcs?.[npc];
    if (!m) return { attitude: 0, friendly: false };
    const since = ctx.now() - 30 * 60_000;
    const kindness = m.entries.some((e) => (e.kind === "gift" || /helped|gave|saved/i.test(e.text)) && e.ts >= since);
    return { attitude: m.attitude, friendly: kindness || m.attitude >= 0.3 };
  } catch {
    return { attitude: 0, friendly: false };
  }
}

/** Run every built-in detector for one event (projections have already folded it). */
export function detectBuiltinMoments(ctx: EventContext, ev: StoredEvent, o: ObserverOptions): void {
  const player = ctx.player;
  if (!player) return;
  const d = ev.data as Record<string, unknown>;
  const world = ctx.world;
  const model = readModel((n, s) => ctx.projections.get(n, s), world, player);

  // near_death_escape: hp <= 15% and then still alive a while later (or fled)
  const ndKey = K.nearDeath(world, player);
  const pending = ctx.kv.get<NearDeath>(ndKey);
  if (ev.type === "combat.died") {
    if (pending) ctx.kv.delete(ndKey);
  } else if (ev.type === "combat.hurt" && num(d.hp, 1) <= 0.15 && !pending) {
    ctx.kv.set(ndKey, { ts: ev.ts, hp: num(d.hp), source: str(d.source_type) || str(d.source) } satisfies NearDeath);
  } else if (pending) {
    checkNearDeath(ctx, pending, ev.type === "movement.fled" ? "fled" : ev.type === "combat.killed" ? `killed ${str(d.target_type) || str(d.target)}` : null);
  }

  // comeback: a boss / elite kill (or phase win) shortly after being nearly dead
  const isPhaseWin = /(^|\.)phase_cleared$/.test(ev.type) || ev.type === "boss.defeated";
  if ((ev.type === "combat.killed" && (d.boss === true || d.elite === true)) || isPhaseWin) {
    const hurts = ctx.events({ world, player, type: "combat.hurt", since: ev.ts - 90_000, limit: 200 });
    const minHp = hurts.reduce((m, e) => Math.min(m, num((e.data as { hp?: unknown }).hp, 1)), 1);
    if (minHp <= 0.25) {
      fireMoment(ctx, "comeback", {
        evidence: [`hp fell to ${Math.round(minHp * 100)}%`, ev.type === "combat.killed" ? `then killed ${str(d.target_type) || str(d.target)}` : `then cleared phase ${str(d.phase)}`],
        salience: d.boss === true || isPhaseWin ? 0.85 : 0.65,
        why: `won at ${Math.round(minHp * 100)}% hp`,
        data: { minHp, target: str(d.target) || str(d.boss) },
        seed: ev.seq,
      });
      if (pending) ctx.kv.delete(ndKey);
    }
  }

  // flawless_phase: a phase cleared without taking damage
  if (isPhaseWin) {
    const prev = ctx.events({ world, player, type: ev.type, desc: true, limit: 2 }).find((e) => e.seq !== ev.seq);
    const start = Math.max(prev?.ts ?? 0, ev.ts - 5 * 60_000);
    const hurts = ctx.events({ world, player, type: "combat.hurt", since: start, limit: 50 }).filter((e) => e.ts <= ev.ts);
    const hits = ctx.events({ world, player, type: "combat.*", since: start, limit: 50 }).length;
    if (d.flawless === true || (hurts.length === 0 && hits >= 3)) {
      fireMoment(ctx, "flawless_phase", {
        evidence: [`cleared ${str(d.boss) || "a boss"} phase ${str(d.phase) || "?"} without a scratch`],
        salience: 0.8,
        why: "phase cleared with no damage taken",
        data: { boss: str(d.boss), phase: num(d.phase) },
        cooldownKey: `flawless:${str(d.boss)}:${str(d.phase)}`,
        seed: ev.seq,
      });
    }
  }

  // first_kill_of_type
  if (ev.type === "combat.killed") {
    const type = str(d.target_type) || "enemy";
    if (num(model.stats[`kills:${type}`]) === 1) {
      fireMoment(ctx, "first_kill_of_type", {
        evidence: [`first ${type} killed${d.weapon ? ` with ${str(d.weapon)}` : ""}`],
        salience: d.boss === true ? 0.8 : d.elite === true ? 0.55 : 0.3,
        why: `first ${type} kill`,
        data: { targetType: type, target: str(d.target) },
        cooldownKey: `first_kill:${type}`,
        cooldownSec: 0,
        seed: ev.seq,
      });
    }
  }

  // betrayal: harming an NPC who trusted the player / whom the player just helped
  const victim =
    ev.type === "combat.hit" || ev.type === "combat.killed" ? str(d.target)
    : ev.type === "economy.stole" ? str(d.from)
    : ev.type === "social.threatened" ? str(d.target)
    : ev.type === "social.lied" ? str(d.to)
    : "";
  if (victim && ctx.manifest.personas.some((p) => p.id === victim)) {
    const { attitude, friendly } = npcAttitude(ctx, victim);
    if (friendly) {
      const verb = ev.type === "combat.killed" ? "killed" : ev.type === "combat.hit" ? "attacked" : ev.type === "economy.stole" ? "stole from" : ev.type === "social.lied" ? "lied to" : "threatened";
      fireMoment(ctx, "betrayal", {
        evidence: [`${verb} ${victim} (attitude ${attitude.toFixed(2)})`],
        salience: ev.type === "combat.killed" ? 0.95 : ev.type === "social.lied" ? 0.5 : 0.75,
        why: `${verb} a friendly NPC`,
        data: { npc: victim, act: ev.type },
        cooldownKey: `betrayal:${victim}`,
        cooldownSec: 300,
        seed: ev.seq,
      });
    }
  }

  // absurd_purchase: far above the player's usual spend, or most of their gold
  if (ev.type === "economy.bought") {
    const price = num(d.price);
    if (price >= o.absurdMin) {
      const prev = ctx.events({ world, player, type: "economy.bought", since: ev.ts - 24 * 3_600_000, limit: 200 }).filter((e) => e.seq !== ev.seq);
      const prices = prev.map((e) => num((e.data as { price?: unknown }).price)).filter((x) => x > 0);
      const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
      const gold = typeof model.stats.gold === "number" ? model.stats.gold : null;
      const vsAvg = prices.length >= 2 && price >= avg * 4;
      const vsGold = gold !== null && price >= 0.6 * Math.max(gold + price, 1);
      if (vsAvg || vsGold) {
        fireMoment(ctx, "absurd_purchase", {
          evidence: [`bought ${str(d.item) || "something"} for ${Math.round(price)}${vsAvg ? ` (usual ~${Math.round(avg)})` : ""}`],
          salience: Math.min(0.9, 0.45 + (vsAvg ? Math.min(0.3, price / Math.max(1, avg) / 40) : 0) + (vsGold ? 0.15 : 0)),
          why: vsAvg ? `price ${Math.round(price / Math.max(1, avg))}x the usual` : "spent most of their gold at once",
          data: { item: str(d.item), price, vendor: str(d.vendor) },
          seed: ev.seq,
        });
      }
    }
  }

  // broken_promise: a quest taken from someone, then abandoned / failed
  if (ev.type === "quest.failed") {
    const q = str(d.quest);
    const accepted = ctx.events({ world, player, type: "quest.accepted", desc: true, limit: 100 }).find((e) => str((e.data as { quest?: unknown }).quest) === q);
    const giver = str((accepted?.data as { giver?: unknown } | undefined)?.giver);
    const reason = str(d.reason);
    if (giver || ABANDON.test(reason)) {
      fireMoment(ctx, "broken_promise", {
        evidence: [`${giver ? `promised ${giver} ` : ""}${q || "a quest"}, then ${reason || "failed it"}`],
        salience: giver ? 0.6 : 0.4,
        why: giver ? `let ${giver} down` : "abandoned a quest",
        data: { quest: q, giver, reason },
        cooldownKey: `broken_promise:${q}`,
        seed: ev.seq,
      });
    }
  }
}

/** Fire near_death_escape when the pending low-hp state has resolved in the player's favour. */
export function checkNearDeath(ctx: Ctx, pending: NearDeath, how: string | null): void {
  if (!ctx.player) return;
  const now = ctx.now();
  if (!how && now - pending.ts < 8000) return;
  if (now - pending.ts > 5 * 60_000) { ctx.kv.delete(K.nearDeath(ctx.world, ctx.player)); return; }
  const died = ctx.events({ world: ctx.world, player: ctx.player, type: "combat.died", since: pending.ts, limit: 1 }).length > 0;
  ctx.kv.delete(K.nearDeath(ctx.world, ctx.player));
  if (died) return;
  fireMoment(ctx, "near_death_escape", {
    evidence: [`hp ${Math.round(pending.hp * 100)}%${pending.source ? ` after ${pending.source}` : ""}`, how ?? "survived"],
    salience: pending.hp <= 0.05 ? 0.8 : 0.6,
    why: `survived at ${Math.round(pending.hp * 100)}% hp`,
    data: { hp: pending.hp, source: pending.source },
    seed: pending.ts,
  });
}

/** Tick helper: resolve a pending near-death for a player with no new events. */
export function sweepNearDeath(ctx: Ctx): void {
  if (!ctx.player) return;
  const pending = ctx.kv.get<NearDeath>(K.nearDeath(ctx.world, ctx.player));
  if (pending) checkNearDeath(ctx, pending, null);
}

// ---------------------------------------------------------------- designer traits + moments (manifest DSL)

interface DesignerState { t: Record<string, boolean>; m: Record<string, boolean> }

/**
 * Evaluate designer traits + moments. With `ev`, only rules that watch that event type (or read state) are
 * evaluated; without (ticks) every rule is, so window-based rules can expire.
 */
export function evaluateDesignerRules(ctx: Ctx, ev: StoredEvent | null, existingEnv?: LiveDslEnv): void {
  const player = ctx.player;
  if (!player) return;
  const m = ctx.manifest;
  const traits = Object.entries(m.traits);
  const moments = Object.entries(m.moments);
  if (!traits.length && !moments.length) return;
  const key = K.designer(ctx.world, player);
  const st = ctx.kv.get<DesignerState>(key) ?? { t: {}, m: {} };
  let env = existingEnv;
  let dirty = false;
  const now = ctx.now();

  for (const [name, src] of traits) {
    const rule = compileRule(src);
    if (!rule.run || (ev && !ruleWatches(rule, ev.type))) continue;
    env ??= makeDslEnv(ctx, ctx.world, player, { now });
    const on = evalRule(src, env);
    const was = st.t[name] ?? false;
    if (on !== was) { st.t[name] = on; dirty = true; }
    if (on && (!was || traitAt(env.model, name, now, m) < 0.8)) {
      ctx.record(OBS_EVENTS.trait, { trait: name, score: 1, evidence: [`${src}${ev ? ` (after ${ev.type})` : ""}`] }, { world: ctx.world, player });
    }
  }
  for (const [name, src] of moments) {
    const rule = compileRule(src);
    if (!rule.run || (ev && !ruleWatches(rule, ev.type))) continue;
    env ??= makeDslEnv(ctx, ctx.world, player, { now });
    const on = evalRule(src, env);
    const was = st.m[name] ?? false;
    if (on !== was) { st.m[name] = on; dirty = true; }
    if (on && !was) {
      fireMoment(ctx, name, { evidence: [src], salience: 0.6, why: `designer moment ${name}`, data: ev ? { trigger: ev.type } : undefined, seed: ev?.seq });
    }
  }
  if (dirty) ctx.kv.set(key, st);
}

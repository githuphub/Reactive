// Recipes 11-13: boss_attempt_memory, dodge_bait, flawless_secret_phase. Bosses speak through boss.adapt taunts
// (voiced by the boss persona when the manifest names one) and change the fight through boss.move_added; every
// decision also lands on the Director timeline (lf.director.decision) with the recipe + facets in its why.
import { clampMove, cleanHabits, composeMove, hashString, type MoveSpec, type StoredEvent } from "@liveforge/protocol";
import type { RecipeDef, RecipeRun } from "../kit.js";
import { whyOf } from "../kit.js";
import { LIB_EVENTS, type LedgerState } from "../state.js";
import { bossConfig, mapToEngine, moveClampOptions, restrictShape } from "../../../director/boss.js";
import { recordDecision } from "../../../director/state.js";
import { buildSituation } from "../facets.js";
import { personaById } from "../../util.js";

const str = (v: unknown) => (typeof v === "string" ? v : "");
type BossMem = LedgerState["bosses"][string];

function decision(run: RecipeRun, boss: string, summary: string, reason: string, data: Record<string, unknown>): void {
  const sit = buildSituation(run.ctx, run.world, run.player, boss, run.l);
  recordDecision(run.ctx, { kind: "reaction", source: "rules", summary: summary.slice(0, 200), why: whyOf(run.id, reason, sit.facets), data: { recipe: run.id, boss, fingerprint: sit.fingerprint, facets: sit.facets.slice(0, 8).map((f) => `${f.kind}:${f.key}`), ...data } });
}

// ------------------------------------------------------------------ 11 boss_attempt_memory

/** Which line the boss should use after this attempt (and a hint when the player is stuck). */
export function bossMood(run: RecipeRun, boss: string, b: BossMem): { pool: string; hint?: string } {
  if (b.lastResult === "won") return { pool: "defeated" };
  if (b.lastResult === "fled") return { pool: "fled" };
  const hintAfter = run.num("hintAfter", 3);
  if (b.lastResult === "died" && b.deaths >= hintAfter && (b.deaths - hintAfter) % 2 === 0) {
    const cfg = bossConfig(run.m, boss);
    const voice = cfg.persona ? personaById(run.m, cfg.persona) : undefined;
    const hints = [...run.list("hints"), ...(voice?.secrets ?? [])];
    const hint = hints.length ? hints[b.deaths % hints.length] : "";
    return hint ? { pool: "hint", hint } : { pool: "hint_generic" };
  }
  if (b.attempts >= run.num("respectAfter", 5)) return { pool: "respect" };
  return { pool: b.attempts <= 1 ? "first" : "gloat" };
}

export const bossAttemptMemory: RecipeDef = {
  id: "boss_attempt_memory",
  cooldownSec: 5,
  relevant: ["status"],
  pools: {
    first: [
      "Another challenger. How quaint.", "You'll learn, {name}. Everyone does.", "First time? It shows.",
      "Welcome. You won't enjoy your stay.", "So you're the one they keep talking about.", "Is that all you brought?",
    ],
    gloat: [
      "Back again, {name}? That's attempt {attempt}.", "{deaths} times you've fallen here. Shall we make it {next}?", "Do you never tire of dying?",
      "I remember you. You died exactly the same way last time.", "Attempt {attempt}. I'm keeping count, you know.", "Again? Your persistence is almost touching.",
    ],
    respect: [
      "{attempt} attempts. Most give up long before this.", "You keep coming back. I respect that, {name}.", "Stubborn. I could almost like you.",
      "You've learned. I can see it. So have I.", "Attempt {attempt}. Very well. No more games.", "Few have the spine to try this often.",
    ],
    hint: [
      "You fall again. Perhaps remember this: {hint}", "Since you insist on dying, a clue: {hint}", "Pathetic. Fine. {hint}",
      "{deaths} deaths. Let me spare you a few more: {hint}", "I'll tell you once, since it won't help you: {hint}", "Listen, for once. {hint}",
    ],
    hint_generic: [
      "You attack exactly when I want you to. Think about that.", "Watch my hands, fool. Not my eyes.", "Patience. You have none, and it shows.",
      "Every time I wind up, you panic. Don't.", "You stand where I can reach you. Stop it.", "{deaths} deaths and you still rush in. Wait for the opening.",
    ],
    defeated: [
      "Impossible... after {attempt} tries...", "You... actually did it.", "Well fought, {name}. Well fought.",
      "This isn't over. Nothing is ever over.", "I underestimated you. Never again.", "Remember this day. I certainly will.",
    ],
    fled: [
      "Running? I'll be here when you return.", "Flee, then. The door's always open.", "Coward! Come back and finish this!",
      "Run along, {name}. I'll keep your seat warm.", "Leaving so soon? We'd only just begun.", "Yes, run. They always run.",
    ],
  },
  on: {
    "combat.boss_attempt"(run, ev) {
      const boss = str(ev.data.boss);
      const b = run.l.bosses[boss];
      if (!boss || !b || !run.ready(boss)) return;
      const mood = bossMood(run, boss, b);
      const vars = { attempt: b.attempts, deaths: b.deaths, next: b.deaths + 1, hint: mood.hint };
      const said = run.say(boss, mood.pool, { vars, reason: `attempt ${b.attempts}, ${b.deaths} deaths, ${b.lastResult}`, effect: { effect: "boss_line", target: `boss:${boss}`, payload: { boss, attempt: b.attempts, deaths: b.deaths, mood: mood.pool, ...(mood.hint ? { hint: mood.hint } : {}) } } });
      if (said) decision(run, boss, `${run.name(boss)}: ${mood.pool} line after attempt ${b.attempts}`, `${b.deaths} deaths`, { attempt: b.attempts, mood: mood.pool });
    },
  },
  note(run, npc) {
    const b = run.l.bosses[npc];
    return b ? `This challenger has fought you ${b.attempts} times (${b.deaths} deaths, ${b.wins} wins).` : null;
  },
};

// ------------------------------------------------------------------ 12 dodge_bait

/** Dominant dodge direction for a boss from the ledger (null below the thresholds). */
export function dominantDodge(b: BossMem | undefined, minShare: number, minDodges: number): { dir: "left" | "right" | "back" | "fwd"; share: number; total: number; leftShare: number } | null {
  if (!b) return null;
  const d = b.dodge;
  const total = d.left + d.right + d.back + d.fwd;
  if (total < minDodges) return null;
  const [dir, n] = (Object.entries(d) as ["left" | "right" | "back" | "fwd", number][]).sort((a, c) => c[1] - a[1])[0];
  const share = n / total;
  return share >= minShare ? { dir, share, total, leftShare: d.left + d.right > 0 ? d.left / (d.left + d.right) : 0.5 } : null;
}

function baitMove(run: RecipeRun, boss: string, dir: string, leftShare: number, phase: number): MoveSpec | null {
  const opts = moveClampOptions(run.m);
  const seed = hashString(`${run.player}:${boss}:${dir}:${run.l.bosses[boss]?.attempts ?? 0}`);
  if (dir === "left" || dir === "right") {
    const habits = cleanHabits({ dodgeLeft: dir === "left" ? Math.max(0.8, leftShare) : Math.min(0.2, leftShare), dodgeRate: 30 });
    const { move } = composeMove({ phase: Math.max(1, phase), habits, existing: [], attune: null, seed }, opts);
    return restrictShape(run.m, move);
  }
  const raw = dir === "back"
    ? { name: "Long Reach", taunt: "Backing away? I reach further.", shape: "grab", element: run.m.elements[0] ?? "physical", pattern: "line", count: 2, telegraph: 0.9, speed: 1.4, size: 1.3, damage_budget: 14, status: "slowed", bias: "none" }
    : { name: "Closing Ring", taunt: "Always rushing in. Then come closer.", shape: "ring", element: run.m.elements[0] ?? "physical", pattern: "ring", count: 2, telegraph: 0.8, speed: 1.2, size: 0.9, damage_budget: 14, status: "none", bias: "none" };
  const m = clampMove(raw, opts);
  return m ? restrictShape(run.m, m) : null;
}

function bait(run: RecipeRun, ev: StoredEvent): void {
  const boss = str(ev.data.boss) || str(ev.data.source);
  if (!boss || !run.m.bosses.some((b) => b.id === boss)) return;
  const b = run.l.bosses[boss];
  const dd = dominantDodge(b, run.num("minShare", 0.45), run.num("minDodges", 6));
  if (!dd || !run.ready(boss, run.num("cooldownSec", 90))) return;
  const move = baitMove(run, boss, dd.dir, dd.leftShare, b.lastPhase || 1);
  if (!move) return;
  const cfg = bossConfig(run.m, boss);
  const engine = mapToEngine(run.m, cfg, move, 0.6);
  const pct = Math.round(dd.share * 100);
  const reason = `dodges ${dd.dir} ${pct}% of ${dd.total}`;
  run.say(boss, `bait_${dd.dir}`, {
    vars: { pct, move: move.name }, reason,
    effect: { effect: "dodge_bait", target: `boss:${boss}`, payload: { boss, direction: dd.dir, share: Math.round(dd.share * 100) / 100, bias: move.bias, move } },
    also: [
      { kind: "boss.move_added", target: `boss:${boss}`, args: { boss, move, ...(engine ? { engineMove: engine } : {}) }, why: "" },
      ...(dd.dir === "left" || dd.dir === "right" ? [{ kind: "boss.adapt", target: `boss:${boss}`, args: { boss, weights: { [`bias_${dd.dir}`]: Math.round(dd.share * 100) / 100 } }, why: "" }] : []),
    ],
  });
  decision(run, boss, `${run.name(boss)} baits your ${dd.dir} dodge with ${move.name}`, reason, { dir: dd.dir, share: dd.share, move: move.name });
}

export const dodgeBait: RecipeDef = {
  id: "dodge_bait",
  cooldownSec: 90,
  relevant: [],
  pools: {
    bait_left: [
      "Always left, {name}. Always left. Let's see you dodge THIS.", "{pct} percent of the time, you go left. I've noticed.", "Left again? I'm already there.",
      "Your left foot betrays you every time.", "Go on, dodge left. I dare you.", "Predictable. Left, left, left.",
    ],
    bait_right: [
      "Always right, {name}. Let's fix that.", "{pct} percent to the right. You're a creature of habit.", "Right again? I thought so.",
      "Your right side's getting crowded.", "Dodge right one more time. Please.", "Predictable. Right, right, right.",
    ],
    bait_back: [
      "Backing away again? My reach is longer than your courage.", "Every time I swing, you retreat. Not this time.", "{pct} percent of your dodges go backwards. Cowardly geometry.",
      "Back, back, back. There's a wall behind you, you know.", "Step back. Go on. Right into it.", "Retreat all you like. I'll follow.",
    ],
    bait_fwd: [
      "Always rushing in, {name}. Come closer, then.", "You dodge straight at me. Bold. Foolish.", "{pct} percent forward. Let's see you hug this.",
      "In my face again? I've prepared for that.", "You love it close. So do I.", "Forward, always forward. Into the fire.",
    ],
  },
  on: { "combat.boss_attempt": bait, "combat.dodged": bait },
};

// ------------------------------------------------------------------ 13 flawless_secret_phase

export const flawlessSecretPhase: RecipeDef = {
  id: "flawless_secret_phase",
  cooldownSec: 30,
  relevant: [],
  pools: {
    secret: [
      "Not a scratch? Then you leave me no choice. Behold my true form.", "Flawless... No one has ever... Very well. No more holding back.",
      "You think you've won? I have one lecture left. {move}!", "Untouched, {name}? Let's change that. {move}!",
      "Perfect, are we? Perfection invites desperation.", "You force my hand. Phase {secret_phase} was never meant for students.",
    ],
  },
  on: {
    "combat.phase_flawless"(run, ev) {
      const boss = str(ev.data.boss);
      const phase = Math.max(1, Math.round(Number(ev.data.phase) || 1));
      if (!boss) return;
      const b = run.l.bosses[boss];
      if (run.params.once !== false && b?.secret) return;
      const cfg = bossConfig(run.m, boss);
      const opts = moveClampOptions(run.m);
      const { move: base } = composeMove({ phase: Math.min(5, phase + 2), habits: cleanHabits({ dodgeRate: 20, blockRate: 0.5 }), existing: [], attune: null, seed: hashString(`${run.player}:${boss}:secret:${phase}`) }, opts);
      const name = `Last ${base.name}`.slice(0, 32);
      const move = clampMove({ ...base, name, taunt: "This was never meant for students.", count: base.count + 2, speed: base.speed * 1.25, size: base.size * 1.25, telegraph: base.telegraph - 0.2 }, opts) ?? base;
      const secret = restrictShape(run.m, move);
      const engine = mapToEngine(run.m, cfg, secret, 0.9);
      run.ctx.record(LIB_EVENTS.secret, { boss, move: secret }, { player: run.player });
      const aggression = run.m.clamps.difficulty.aggressionMax;
      run.say(boss, "secret", {
        vars: { move: secret.name, secret_phase: Math.min(9, cfg.phases + 1) }, reason: `flawless phase ${phase}`,
        effect: { effect: "secret_phase", target: `boss:${boss}`, payload: { boss, name: secret.name, afterPhase: phase, secretPhase: Math.min(9, cfg.phases + 1), move: secret, ...(engine ? { engineMove: engine } : {}) } },
        also: [
          { kind: "boss.move_added", target: `boss:${boss}`, args: { boss, move: secret, ...(engine ? { engineMove: engine } : {}) }, why: "" },
          { kind: "boss.adapt", target: `boss:${boss}`, args: { boss, aggression }, why: "" },
        ],
      });
      decision(run, boss, `${run.name(boss)} unlocks a secret phase: ${secret.name}`, `flawless phase ${phase}`, { move: secret.name, afterPhase: phase });
    },
  },
};

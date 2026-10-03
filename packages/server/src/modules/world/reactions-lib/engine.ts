// Reaction Library runtime (R1): the recipe registry, the signal handler + tick that run event-driven recipes, and
// the hooks other modules call so the same facets reach every voice:
//  - Persona npc.bark: libraryBark() -> the best-scoring recipe line for this NPC right now (combination weighting)
//  - Persona npc.reply: libraryReplyInstant() (rules promise / claim detection + reply line), libraryContext()
//    (context sentence + recipe notes + do-not-repeat lines for the AI upgrade), recordLlmClaim()
//  - Director: libraryHabits() (dodge directions from boss attempts), libraryBossPhase() (attempt-aware taunt +
//    the secret flawless move)
import type { MoveHabits, MoveSpec, ReactionInfo, StoredEvent } from "@liveforge/protocol";
import type { EventContext, ModuleContext, ScopedContext, TickContext } from "../../../module.js";
import { combinationScore, doNotRepeatBlock, facetId } from "../../../core/combination/index.js";
import { personaById, scopeFor } from "../util.js";
import { libraryOf, libraryOn, paramsOf, pNum, recipeOn } from "./config.js";
import { buildSituation, type Situation } from "./facets.js";
import { RecipeRun, type RecipeDef } from "./kit.js";
import { canonicalType, LIB_EVENTS, ledgerOf } from "./state.js";
import { appearanceState, deedNicknames, outfitComments } from "./recipes/npc.js";
import { companionGrief, contradiction, cowardRumour, liesCaught, promisesRemembered, townMood } from "./recipes/social.js";
import { brokeSupport, collectorInterest, haggleMemory, richAttention } from "./recipes/economy.js";
import { bossAttemptMemory, bossMood, dodgeBait, dominantDodge, flawlessSecretPhase } from "./recipes/boss.js";
import { absenceRecap, avoidedArea, innRegular, propertyDamage, timeWeatherBarks } from "./recipes/world.js";

/** The 20 shipped recipes, in catalogue order. */
export const RECIPES: RecipeDef[] = [
  outfitComments, appearanceState, deedNicknames, liesCaught, promisesRemembered, townMood, richAttention, brokeSupport,
  collectorInterest, haggleMemory, bossAttemptMemory, dodgeBait, flawlessSecretPhase, cowardRumour, companionGrief,
  timeWeatherBarks, innRegular, absenceRecap, propertyDamage, avoidedArea,
];
const BY_ID = new Map(RECIPES.map((r) => [r.id as string, r]));

/** Enabled recipe defs with their params. */
function enabled(m: ModuleContext["manifest"]): { def: RecipeDef; params: Record<string, unknown> }[] {
  const out: { def: RecipeDef; params: Record<string, unknown> }[] = [];
  for (const [id, params] of libraryOf(m)) {
    const def = BY_ID.get(id);
    if (def) out.push({ def, params });
  }
  return out;
}

function safely(ctx: ModuleContext | ScopedContext, recipe: string, fn: () => void): void {
  try {
    fn();
  } catch (e) {
    ctx.log.warn("reaction recipe failed", { recipe, error: e as Error });
  }
}

/** Events the library ignores (core bookkeeping, its own records, other modules' internals). */
function ignored(type: string): boolean {
  if (type === "lf.directive") return true;
  if (type === LIB_EVENTS.claim || type === LIB_EVENTS.promise || type === "lf.observer.moment") return false;
  return type.startsWith("lf.");
}

/** Signal handler: run every enabled recipe that reacts to this (canonical) event type. */
export function onLibraryEvent(ctx: EventContext, ev: StoredEvent): void {
  const m = ctx.manifest;
  if (!ev.player || ignored(ev.type) || !libraryOn(m)) return;
  const type = canonicalType(ev.type);
  for (const { def, params } of enabled(m)) {
    const handler = def.on?.[type];
    if (!handler) continue;
    safely(ctx, def.id, () => {
      const run = new RecipeRun(def, ctx, ev.player!, params, ev);
      if (run.gate()) handler(run, ev);
    });
  }
}

/** Tick: recipes with timed behaviour (promise reminders, debts, rich / broke checks, theft, avoided areas). */
export function libraryTick(ctx: TickContext): void {
  const m = ctx.manifest;
  if (!libraryOn(m)) return;
  const ticking = enabled(m).filter((x) => x.def.tick);
  if (!ticking.length) return;
  for (const player of ctx.activePlayers.slice(0, 100)) {
    const sc = scopeFor(ctx, ctx.world, player);
    for (const { def, params } of ticking) {
      safely(ctx, def.id, () => {
        const run = new RecipeRun(def, sc, player, params);
        if (run.gate()) def.tick!(run);
      });
    }
  }
}

// ------------------------------------------------------------------ Persona hooks

export interface LibraryLine {
  text: string;
  emote?: string;
  info: ReactionInfo;
  why: string;
}

const BARK_TRIGGERS = new Set(["approach", "greeting", "idle", "gear", "moment", "rumour", "time", "weather"]);

/**
 * npc.bark instant: every enabled recipe offers a line for this NPC; each is scored by combination weighting (base
 * priority + facets of the current situation it actually uses) and the best one whose bark cooldown has passed is
 * spoken (novelty-checked variant). null = no recipe has anything to say (Persona falls back to its own buckets).
 */
export function libraryBark(ctx: ScopedContext, npc: string, trigger: string): LibraryLine | null {
  const m = ctx.manifest;
  const player = ctx.player;
  if (!player || !libraryOn(m) || !personaById(m, npc) || !BARK_TRIGGERS.has(trigger)) return null;
  let sit: Situation | null = null;
  let best: { run: RecipeRun; offer: NonNullable<ReturnType<NonNullable<RecipeDef["offer"]>>>; score: number; key: string } | null = null;
  for (const { def, params } of enabled(m)) {
    if (!def.offer) continue;
    const run = new RecipeRun(def, ctx, player, params);
    const key = `${def.id}|bark|${npc}`;
    if (!run.ready(npc, Math.max(45, run.cooldownSec() / 2), key)) continue;
    let offer = null;
    try { offer = run.gate() ? def.offer(run, npc, trigger) : null; } catch (e) { ctx.log.warn("reaction offer failed", { recipe: def.id, error: e as Error }); }
    if (!offer) continue;
    sit ??= buildSituation(ctx, ctx.world, player, npc, run.l);
    const score = combinationScore(offer.base, sit.facets, def.relevant);
    if (!best || score > best.score) best = { run, offer, score, key };
  }
  if (!best) return null;
  const spoken = best.run.say(npc, best.offer.pool, { vars: best.offer.vars, extra: best.offer.extra, emote: best.offer.emote, reason: best.offer.reason, silent: true, cooldownKey: best.key });
  if (!spoken) return null;
  const f = spoken.situation.facets.slice(0, 4).map(facetId).join(", ");
  return { text: spoken.text, ...(best.offer.emote ? { emote: best.offer.emote } : {}), info: spoken.info, why: `reaction ${best.run.id}: ${best.offer.reason}${f ? ` · ${f}` : ""} (score ${best.score.toFixed(2)})`.slice(0, 300) };
}

/** Record a line Persona said itself, so the novelty ledger covers every voice (library lines never echo it). */
export function noteLine(ctx: ScopedContext, speaker: string, line: string, recipe = "persona"): void {
  if (!ctx.player || !libraryOn(ctx.manifest)) return;
  ctx.record(LIB_EVENTS.line, { speaker, line: line.slice(0, 300), recipe }, { player: ctx.player });
}

export interface LibraryContext {
  sentence: string;
  fingerprint: string;
  facets: string[];
  notes: string[];
  recent: string[];
  /** Ready-made prompt block (context sentence + notes + do-not-repeat). Empty when the library is off. */
  block: string;
}

/** For AI upgrades (bark / reply): the context sentence, what each recipe knows, and the lines not to repeat. */
export function libraryContext(ctx: ScopedContext, npc: string): LibraryContext | null {
  const m = ctx.manifest;
  const player = ctx.player;
  if (!player || !libraryOn(m)) return null;
  const l = ledgerOf(ctx, ctx.world, player);
  const sit = buildSituation(ctx, ctx.world, player, npc, l);
  const notes: string[] = [];
  for (const { def, params } of enabled(m)) {
    if (!def.note) continue;
    safely(ctx, def.id, () => {
      const n = def.note!(new RecipeRun(def, ctx, player, params), npc);
      if (n) notes.push(n);
    });
  }
  const recent = (l.ledger[npc] ?? []).map((x) => x.line).slice(-8);
  const block = [
    `Situation right now: ${sit.sentence}`,
    notes.length ? `Things you know:\n${notes.slice(0, 8).map((n) => `- ${n}`).join("\n")}` : "",
    l.nickname ? `Their nickname around town: "${l.nickname.name}".` : "",
    doNotRepeatBlock(recent),
  ].filter(Boolean).join("\n");
  return { sentence: sit.sentence, fingerprint: sit.fingerprint, facets: sit.facets.map(facetId), notes, recent, block };
}

const PROMISE_RX = /\b(i promise|i swear|i give you my word|you have my word|i'?ll be back|i will be back|i will (bring|pay|return|fetch|find|help|get)|i'?ll (bring|pay|return|fetch|find|help|get))\b/i;
const CLAIM_RX = /\b(i (never|didn'?t|did not|haven'?t|wasn'?t)\b|i'?m (broke|poor|rich|innocent|not)\b|i have no (gold|money|coin)|i (killed|beat|defeated|slew)\b|it wasn'?t me|i'?m telling the truth)/i;

function dueFromText(text: string): number | undefined {
  const m = /\bin (\d{1,3}) ?(min|minute|minutes|hour|hours|h)\b/i.exec(text);
  if (!m) return /\b(tonight|by nightfall)\b/i.test(text) ? 1800 : /\btomorrow\b/i.test(text) ? 3600 : undefined;
  return Number(m[1]) * (/^h/i.test(m[2]) ? 3600 : 60);
}

/**
 * npc.reply instant: spot a promise or a checkable claim in what the player said (rules), record it (as the
 * internal stand-in for social.promise / social.claim), and return an in-character line for the reply when the
 * library has something to say (acknowledge the promise, call out a contradicted claim).
 */
export function libraryReplyInstant(ctx: ScopedContext, npc: string, text: string, askId: string): LibraryLine | null {
  const m = ctx.manifest;
  const player = ctx.player;
  if (!player || !libraryOn(m) || !personaById(m, npc)) return null;
  if ((recipeOn(m, "promises_remembered") || recipeOn(m, "broke_support")) && PROMISE_RX.test(text)) {
    const due = dueFromText(text);
    ctx.kv.set(`replyLib:${askId}`, "promise");
    ctx.record(LIB_EVENTS.promise, { to: npc, text: text.slice(0, 200), ref: `p_${askId}`.slice(0, 64), ...(due ? { due } : {}), via: "reply" }, { player });
    if (!recipeOn(m, "promises_remembered")) return null;
    const run = new RecipeRun(promisesRemembered, ctx, player, paramsOf(m, "promises_remembered"));
    const spoken = run.say(npc, "made", { vars: { promise: text.slice(0, 60) }, emote: "nod", reason: "promise in conversation", silent: true, cooldownKey: `promises_remembered|reply|${npc}` });
    return spoken ? { text: spoken.text, emote: "nod", info: spoken.info, why: `reaction promises_remembered: promise noted (due ${due ? `${Math.round(due / 60)} min` : "default"})` } : null;
  }
  if (recipeOn(m, "lies_caught") && CLAIM_RX.test(text)) {
    ctx.kv.set(`replyLib:${askId}`, "claim");
    ctx.record(LIB_EVENTS.claim, { to: npc, text: text.slice(0, 200), truth: null, via: "reply" }, { player });
    const run = new RecipeRun(liesCaught, ctx, player, paramsOf(m, "lies_caught"));
    const reason = contradiction(run, npc, text);
    if (!reason) return null;
    const spoken = run.say(npc, "callout_rumour", { vars: { claim: text.slice(0, 60) }, emote: "narrow_eyes", reason, silent: true, cooldownKey: `lies_caught|reply|${npc}` });
    return spoken ? { text: spoken.text, emote: "narrow_eyes", info: spoken.info, why: `reaction lies_caught: ${reason}`.slice(0, 300) } : null;
  }
  return null;
}

/** npc.reply upgrade: whether the rules already caught a promise / claim in this ask (so the LLM's is not doubled). */
export function replyLibSeen(ctx: ScopedContext, askId: string): string | null {
  const v = ctx.kv.get<string>(`replyLib:${askId}`) ?? null;
  if (v) ctx.kv.delete(`replyLib:${askId}`);
  return v;
}

/** True when the reply upgrade should classify promises / claims (the schema field is only added then). */
export const wantsClaimField = (m: ModuleContext["manifest"]): boolean => recipeOn(m, "lies_caught") || recipeOn(m, "promises_remembered");

/** Record what the reply LLM classified (promise or claim with truth) as the internal library event. */
export function recordLlmClaim(ctx: ScopedContext, npc: string, c: { kind: string; text: string; truth: string }, askId: string): void {
  const player = ctx.player;
  if (!player || !wantsClaimField(ctx.manifest) || !personaById(ctx.manifest, npc)) return;
  const text = c.text.trim().slice(0, 200);
  if (!text) return;
  if (c.kind === "promise" && recipeOn(ctx.manifest, "promises_remembered")) {
    const due = dueFromText(text);
    ctx.record(LIB_EVENTS.promise, { to: npc, text, ref: `p_${askId}`.slice(0, 64), ...(due ? { due } : {}), via: "reply", source: "ai" }, { player });
  } else if (c.kind === "claim" && recipeOn(ctx.manifest, "lies_caught")) {
    ctx.record(LIB_EVENTS.claim, { to: npc, text, truth: c.truth === "true" ? true : c.truth === "false" ? false : null, via: "reply", source: "ai" }, { player });
  }
}

// ------------------------------------------------------------------ Director hooks

/** Habit overrides from the library (dodge directions summed over boss attempts). Empty when dodge_bait is off. */
export function libraryHabits(ctx: ScopedContext, player: string | null, boss?: string): Partial<MoveHabits> {
  const m = ctx.manifest;
  if (!player || !recipeOn(m, "dodge_bait")) return {};
  const p = paramsOf(m, "dodge_bait");
  const l = ledgerOf(ctx, ctx.world, player);
  const ids = boss ? [boss] : Object.keys(l.bosses);
  let best: ReturnType<typeof dominantDodge> = null;
  for (const id of ids) {
    const d = dominantDodge(l.bosses[id], pNum(p, "minShare", 0.45), pNum(p, "minDodges", 6));
    if (d && (!best || d.total > best.total)) best = d;
  }
  if (!best || (best.dir !== "left" && best.dir !== "right")) return {};
  return { dodgeLeft: best.leftShare, dodgeRate: Math.max(8, Math.min(30, best.total)) };
}

/** director.boss_phase: an attempt-aware taunt (boss_attempt_memory) and the secret move (flawless_secret_phase). */
export function libraryBossPhase(ctx: ScopedContext, boss: string): { taunt?: string; why?: string; secret?: MoveSpec } {
  const m = ctx.manifest;
  const player = ctx.player;
  if (!player || !libraryOn(m)) return {};
  const l = ledgerOf(ctx, ctx.world, player);
  const b = l.bosses[boss];
  if (!b) return {};
  const out: { taunt?: string; why?: string; secret?: MoveSpec } = {};
  if (recipeOn(m, "flawless_secret_phase") && b.secret) out.secret = b.secret;
  if (recipeOn(m, "boss_attempt_memory") && b.attempts > 0) {
    const run = new RecipeRun(bossAttemptMemory, ctx, player, paramsOf(m, "boss_attempt_memory"));
    const key = `boss_attempt_memory|phase|${boss}`;
    if (run.ready(boss, 20, key)) {
      const mood = bossMood(run, boss, b);
      const spoken = run.say(boss, mood.pool, { vars: { attempt: b.attempts, deaths: b.deaths, next: b.deaths + 1, hint: mood.hint }, reason: `phase taunt, attempt ${b.attempts}`, silent: true, cooldownKey: key });
      if (spoken) {
        out.taunt = spoken.text.slice(0, 200);
        out.why = `boss_attempt_memory: ${mood.pool} (attempt ${b.attempts}, ${b.deaths} deaths) · ${spoken.info.facets.slice(0, 3).join(", ")}`;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ dashboard

/** Admin view: enabled recipes, and per player the ledger, fired reactions and live fingerprints per NPC. */
export function libraryState(ctx: ModuleContext, world: string, player?: string | null) {
  const m = ctx.manifest;
  const library = [...libraryOf(m)].map(([recipe, params]) => ({ recipe, params }));
  const players: Record<string, unknown> = {};
  const list = player ? [player] : ctx.projections.all<unknown>("world.reaction_ledger", world).map((x) => x.player).slice(0, 20);
  for (const p of list) {
    const sc = scopeFor(ctx, world, p);
    const l = ledgerOf(ctx, world, p);
    const speakers = [...new Set([...m.personas.map((x) => x.id), ...Object.keys(l.ledger)])].slice(0, 24);
    players[p] = {
      nickname: l.nickname,
      mood: l.mood,
      time: l.time,
      appearance: l.appearance,
      session: l.session,
      fired: l.fired.slice(-40).reverse(),
      npcs: speakers.map((npc) => {
        const sit = buildSituation(sc, world, p, npc, l);
        return { npc, name: sit.speakerName, fingerprint: sit.fingerprint, facets: sit.facets.map(facetId), sentence: sit.sentence, ledger: (l.ledger[npc] ?? []).slice().reverse() };
      }),
    };
  }
  return { library, engine: m.reactions.engine, players };
}

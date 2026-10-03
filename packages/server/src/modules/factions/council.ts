// The village council: rules pick posture, price multiplier and guard posts from trust, damage, threats and mood
// (instant, every 20 s and on important signals); with an LLM, a short Haiku "council" may upgrade the decision
// (clamped to one posture step from the rules, the faction's price range and the declared guards / posts).
// Every change: lf.factions.decision event, custom.faction_posture + custom.guard_posts directives, a Director
// timeline entry and a Brain entry.
import {
  FACTION_POSTURES, cleanText, councilJsonSchema, isObj,
  type BrainDraft, type FactionMind, type FactionMindState, type FactionPosture, type GuardPost,
} from "@liveforge/protocol";
import type { ScopedContext } from "../../module.js";
import { isReplayModel, modelBadge } from "../../providers/cassette.js";
import { clamp, factionsOptions, humanise, personaName, pickBy, resolveFactions, round2, type ResolvedFaction } from "./config.js";
import { freshMind } from "./mind.js";

const MIN = 60_000;

/** Push a Brain entry (source "factions") to this world's feed; best-effort. */
export function brain(ctx: ScopedContext, entry: BrainDraft): void {
  try {
    ctx.brain(entry, { world: ctx.world });
  } catch (e) {
    ctx.log.debug("brain entry dropped", { error: (e as Error).message });
  }
}
const BASE_PRICE: Record<FactionPosture, number> = { calm: 1, wary: 1.25, hostile: 1.6, festive: 0.85 };
const SEVERITY: Record<FactionPosture, number> = { festive: -1, calm: 0, wary: 1, hostile: 2 };

/** Read one faction's mind (fresh defaults when the projection has none yet). */
export function mindOf(ctx: Pick<ScopedContext, "projections">, world: string, faction: string): FactionMind {
  try {
    const s = ctx.projections.get<FactionMindState>("factions.mind", { world });
    return s?.factions?.[faction] ?? freshMind(faction);
  } catch {
    return freshMind(faction);
  }
}

export interface CouncilDecisionDraft {
  posture: FactionPosture;
  priceMult: number;
  guards: GuardPost[];
  announcement: string;
  why: string;
  /** Short fact list for prompts / Brain data. */
  facts: Record<string, unknown>;
  worstPlayer: string | null;
  hotspot: string | null;
}

/** What the village sees right now (decayed to `now`). */
export function readMind(mind: FactionMind, rf: ResolvedFaction, now: number, windowMin: number) {
  const since = now - windowMin * MIN;
  const active = Object.entries(mind.seen).filter(([, ts]) => ts >= now - 30 * MIN).map(([p]) => p);
  const pool = active.length ? active : Object.keys(mind.trust);
  let worstPlayer: string | null = null;
  let trustWorst = rf.cfg.attitude ?? 0;
  for (const p of pool) {
    const t = mind.trust[p] ?? rf.cfg.attitude ?? 0;
    if (worstPlayer === null || t < trustWorst) {
      trustWorst = t;
      worstPlayer = p;
    }
  }
  const recent = mind.damage.recent.filter((x) => x.ts >= since);
  const damageValue = recent.reduce((n, x) => n + (x.value ?? 0), 0);
  let threat = 0;
  let threatNote = "";
  for (const t of mind.threats) {
    const lvl = t.level * Math.pow(0.5, Math.max(0, now - t.ts) / (5 * MIN));
    if (lvl > threat) {
      threat = lvl;
      threatNote = t.note ?? `${t.kind} (${t.source})`;
    }
  }
  const mood = clamp(mind.mood * Math.pow(0.5, Math.max(0, now - (mind.moodTs || now)) / (10 * MIN)), -1, 1);
  const owners = new Map<string, number>();
  for (const x of recent) if (x.owner) owners.set(x.owner, (owners.get(x.owner) ?? 0) + 1);
  const hotspot = [...owners.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { trustWorst, worstPlayer, recent, damageValue, threat, threatNote, mood, hotspot, night: mind.phase === "night" || mind.phase === "dusk" };
}

/** Rules: posture, price, guards, announcement and why from the folded mind. */
export function rulesDecision(ctx: ScopedContext, rf: ResolvedFaction, mind: FactionMind): CouncilDecisionDraft {
  const m = ctx.manifest;
  const o = factionsOptions(ctx);
  const now = ctx.now();
  const r = readMind(mind, rf, now, o.windowMin);
  const reasons: string[] = [];
  const who = r.worstPlayer ? ` (${r.worstPlayer})` : "";
  const dmg = r.recent.length;
  const where = r.hotspot ? ` at ${personaName(m, r.hotspot)}'s` : "";

  let posture: FactionPosture = "calm";
  if (r.trustWorst <= -0.6 || r.threat >= 0.8 || r.damageValue >= 120 || dmg >= 10) {
    posture = "hostile";
    if (r.threat >= 0.8) reasons.push(`threat: ${r.threatNote}`);
    if (dmg >= 10 || r.damageValue >= 120) reasons.push(`${dmg} things broken${where} in ${o.windowMin} min`);
    if (r.trustWorst <= -0.6) reasons.push(`trust ${r.trustWorst.toFixed(2)}${who}`);
  } else if (r.trustWorst <= -0.25 || r.threat >= 0.35 || dmg >= 2 || r.mood <= -0.3) {
    posture = "wary";
    if (dmg >= 2) reasons.push(`${dmg} things broken${where} in ${o.windowMin} min`);
    if (r.trustWorst <= -0.25) reasons.push(`trust ${r.trustWorst.toFixed(2)}${who}`);
    if (r.threat >= 0.35) reasons.push(`threat: ${r.threatNote}`);
    if (r.mood <= -0.3) reasons.push(`mood ${r.mood.toFixed(2)}`);
  } else if (r.mood >= 0.45 && r.trustWorst >= 0.3 && dmg === 0 && r.threat < 0.2) {
    posture = "festive";
    reasons.push(`mood +${r.mood.toFixed(2)}, trust ${r.trustWorst.toFixed(2)}${who}, nothing broken`);
  } else {
    reasons.push(dmg ? `only ${dmg} thing(s) broken` : "nothing broken", `trust ${r.trustWorst.toFixed(2)}${who}`);
  }

  // hysteresis: escalate at once, calm down only after postureMinSec
  if (SEVERITY[posture] < SEVERITY[mind.posture] && mind.postureSince && now - mind.postureSince < o.postureMinSec * 1000) {
    reasons.unshift(`still ${mind.posture} (holds ${o.postureMinSec}s)`);
    posture = mind.posture;
  }

  const priceMult = clampPrice(BASE_PRICE[posture] * (1 - 0.3 * clamp(r.trustWorst, -1, 1)), rf);
  const guards = planGuards(rf, posture, r.hotspot, r.worstPlayer, r.night);
  const announcement = announce(rf, posture, r, mind, r.hotspot ? personaName(m, r.hotspot) : null);
  const why = `${humanise(posture)}: ${reasons.join("; ")} → prices x${priceMult}`.slice(0, 200);
  return {
    posture, priceMult, guards, announcement, why, worstPlayer: r.worstPlayer, hotspot: r.hotspot,
    facts: {
      trustWorst: round2(r.trustWorst), worstPlayer: r.worstPlayer, damage10: dmg, damageValue: Math.round(r.damageValue),
      threat: round2(r.threat), threatNote: r.threatNote || undefined, mood: round2(r.mood), hotspot: r.hotspot, phase: mind.phase,
    },
  };
}

export function clampPrice(v: number, rf: ResolvedFaction): number {
  const [lo, hi] = rf.priceRange;
  return Math.round(clamp(v, lo, hi) * 20) / 20;
}

/** Guard posts by posture: festive -> square, calm -> spread (night: posts), wary -> gate + trouble spot, hostile -> confront. */
export function planGuards(rf: ResolvedFaction, posture: FactionPosture, hotspot: string | null, worst: string | null, night: boolean): GuardPost[] {
  const g = rf.guards;
  if (!g.length) return [];
  const posts = rf.posts.length ? rf.posts : ["gate", "square"];
  const spot = hotspot ? `home:${hotspot}` : posts[0];
  return g.map((npc, i) => {
    switch (posture) {
      case "festive":
        return { npc, post: posts.includes("square") ? "square" : posts[0] };
      case "hostile":
        return { npc, post: i === 0 ? spot : worst ? `player:${worst}` : posts[i % posts.length] };
      case "wary":
        return { npc, post: i === 0 ? posts[0] : i === 1 ? spot : posts[i % posts.length] };
      default:
        return { npc, post: night ? posts[i % posts.length] : posts[(i + 1) % posts.length] };
    }
  });
}

const ANNOUNCE: Record<FactionPosture, string[]> = {
  calm: ["{name} breathes easy again. Fair prices today.", "The shutters of {name} are open. Business as usual.", "{name} settles down. Trade is fair again."],
  wary: ["{name} is on edge: {cause}. Prices are up.", "Doors are bolted in {name}. {Cause}, so prices rise.", "{name} keeps a wary eye out. {Cause}."],
  hostile: ["{name} calls out the guards! {Cause}. Outsiders pay dearly.", "{name} has had enough: {cause}. Guards, to your posts!", "No more! {Cause}. {name} closes ranks."],
  festive: ["{name} is celebrating! Discounts at every stall.", "Music in the square: {name} is in a festive mood. Cheaper prices today!", "{name} cheers its friends. Everything is cheaper today."],
};

function announce(rf: ResolvedFaction, posture: FactionPosture, r: ReturnType<typeof readMind>, mind: FactionMind, owner: string | null): string {
  const cause = r.threat >= 0.35 && r.threatNote ? r.threatNote
    : r.recent.length >= 2 ? (owner ? `someone keeps breaking ${owner}'s house` : "someone keeps breaking things")
    : r.trustWorst <= -0.25 ? "strangers are not trusted"
    : r.mood <= -0.3 ? "the gossip is grim"
    : "times are uncertain";
  const tpl = pickBy(ANNOUNCE[posture], `${rf.id}:${posture}:${mind.history.length}`);
  const cap = cause.charAt(0).toUpperCase() + cause.slice(1);
  return tpl.replace(/\{name\}/g, rf.name).replace(/\{Cause\}/g, cap).replace(/\{cause\}/g, cause).slice(0, 200);
}

const sameGuards = (a: GuardPost[], b: GuardPost[]) => a.length === b.length && a.every((x, i) => x.npc === b[i].npc && x.post === b[i].post);

/** Apply a decision: record, directives, Director timeline, Brain. */
function commit(ctx: ScopedContext, rf: ResolvedFaction, prev: FactionMind, d: CouncilDecisionDraft, meta: { source: string; model: string | null; ms?: number; reason: string }): void {
  const o = factionsOptions(ctx);
  const summary = `${rf.name}: ${d.posture}, prices x${d.priceMult}${d.guards.length ? `, guards ${d.guards.map((g) => `${g.npc}@${g.post}`).join(" ")}` : ""}`.slice(0, 200);
  ctx.record("lf.factions.decision", {
    faction: rf.id, posture: d.posture, priceMult: d.priceMult, guards: d.guards, announcement: d.announcement, why: d.why, summary,
    source: meta.source, model: meta.model, reason: meta.reason, previous: prev.posture, facts: d.facts,
  }, { player: null });
  if (o.directives) {
    if (d.posture !== prev.posture || Math.abs(d.priceMult - prev.priceMult) >= 0.05 || meta.source !== "rules") {
      ctx.emit({
        kind: "custom.faction_posture", target: "world",
        args: { faction: rf.id, posture: d.posture, priceMult: d.priceMult, announcement: d.announcement, previous: prev.posture, stage: meta.source === "rules" ? "rules" : "ai" },
        why: d.why.slice(0, 200),
      }, { player: null });
    }
    if (!sameGuards(d.guards, prev.guards) && d.guards.length) {
      ctx.emit({ kind: "custom.guard_posts", target: "world", args: { faction: rf.id, posts: d.guards }, why: `${d.posture}: ${d.guards.map((g) => `${g.npc} -> ${g.post}`).join(", ")}`.slice(0, 200) }, { player: null });
    }
  }
  if (o.directorTimeline) {
    ctx.record("lf.director.decision", {
      decision: { ts: ctx.now(), kind: "faction_posture", summary, why: (meta.source === "replay" ? `${d.why} (replay)` : d.why).slice(0, 300), source: meta.source === "rules" ? "rules" : "ai", data: { faction: rf.id, posture: d.posture, priceMult: d.priceMult, model: meta.model } },
    }, { player: null });
  }
  brain(ctx, {
    source: "factions", actor: rf.id, kind: "decision",
    text: `${rf.name} → ${d.posture} (prices x${d.priceMult}). ${d.announcement}`,
    data: { faction: rf.id, posture: d.posture, priceMult: d.priceMult, guards: d.guards, why: d.why, facts: d.facts, previous: prev.posture },
    model: meta.source === "rules" ? "rules" : modelBadge(meta.model),
    ...(meta.ms !== undefined ? { ms: meta.ms } : {}),
  });
}

/** In-process council cooldowns (game:world:faction -> ts). */
const lastCouncil = new Map<string, number>();

/**
 * Re-evaluate one faction. Commits (and pushes directives) only when something changed or `force` is set.
 * Returns the committed rules decision, or null when nothing changed. With an LLM the council upgrade runs in
 * the background (awaited when `awaitCouncil`).
 */
export async function evaluate(ctx: ScopedContext, factionId: string, reason: string, opts: { force?: boolean; awaitCouncil?: boolean } = {}): Promise<CouncilDecisionDraft | null> {
  const rf = resolveFactions(ctx.manifest).get(factionId);
  if (!rf) return null;
  const prev = mindOf(ctx, ctx.world, factionId);
  const d = rulesDecision(ctx, rf, prev);
  const changed = d.posture !== prev.posture || Math.abs(d.priceMult - prev.priceMult) >= 0.05 || !sameGuards(d.guards, prev.guards);
  if (!changed && !opts.force) return null;
  commit(ctx, rf, prev, d, { source: "rules", model: null, reason });
  const postureChanged = d.posture !== prev.posture;
  const o = factionsOptions(ctx);
  const key = `${ctx.game}:${ctx.world}:${factionId}`;
  if (ctx.llm && o.council && (postureChanged || opts.force) && ctx.now() - (lastCouncil.get(key) ?? 0) >= o.councilCooldownSec * 1000 && ctx.budgets.check(null).ok) {
    lastCouncil.set(key, ctx.now());
    const p = council(ctx, rf, prev, d).catch((e) => ctx.log.warn("council upgrade failed; rules decision stands", { faction: factionId, error: (e as Error).message }));
    if (opts.awaitCouncil) await p;
  }
  return d;
}

const ALLOWED: Record<FactionPosture, FactionPosture[]> = {
  calm: ["calm", "wary", "festive"],
  wary: ["calm", "wary", "hostile"],
  hostile: ["wary", "hostile"],
  festive: ["calm", "festive"],
};

/** The Haiku council: may adjust posture by one step, prices within range, guard posts and the announcement. */
async function council(ctx: ScopedContext, rf: ResolvedFaction, prev: FactionMind, rules: CouncilDecisionDraft): Promise<void> {
  const m = ctx.manifest;
  const llm = ctx.llm;
  if (!llm) return;
  const posts = [...new Set([...rf.posts, ...(rules.hotspot ? [`home:${rules.hotspot}`] : []), ...(rules.worstPlayer ? [`player:${rules.worstPlayer}`] : [])])];
  const traits = Object.entries(rf.cfg.traits ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ");
  const members = rf.members.map((id) => {
    const p = m.personas.find((x) => x.id === id);
    return `- ${p?.name ?? id} (${id}): ${p?.role ?? "villager"}${rf.guards.includes(id) ? " [guard]" : ""}`;
  }).join("\n");
  const system = [
    `You are the council of ${rf.name}, a village in this world. Decide how the village treats outsiders right now.`,
    `World lore:\n${m.lore.bible.slice(0, 3000)}`,
    `Tone: ${m.lore.tone}. Content rating ${m.safety.rating}; stay in the world.`,
    rf.cfg.description ? `About ${rf.name}: ${rf.cfg.description}` : "",
    traits ? `Village character: ${traits}.` : "",
    `Members:\n${members}`,
    `Rules: posture is one of ${FACTION_POSTURES.join(", ")}. priceMult between ${rf.priceRange[0]} and ${rf.priceRange[1]}. ` +
      `guardPosts: one entry per guard, posts from: ${posts.join(", ")} ("home:<npc>" = that member's house, "player:<id>" = shadow that player). ` +
      `announcement: one short in-world sentence (max 140 characters) a villager shouts. why: max 160 characters, cite the facts.`,
  ].filter(Boolean).join("\n\n");
  const f = rules.facts;
  const user = [
    `Facts: worst trust ${f.trustWorst}${f.worstPlayer ? ` (player ${f.worstPlayer})` : ""}; ${f.damage10} things broken recently${f.hotspot ? ` (mostly ${personaName(m, String(f.hotspot))}'s house)` : ""}; threat ${f.threat}${f.threatNote ? ` (${f.threatNote})` : ""}; mood ${f.mood}; time ${f.phase ?? "unknown"}.`,
    `Previous posture: ${prev.posture}. The rules suggest: ${rules.posture}, prices x${rules.priceMult}, guards ${rules.guards.map((g) => `${g.npc}@${g.post}`).join(", ") || "none"}.`,
    `Allowed postures now: ${ALLOWED[rules.posture].join(", ")}. Decide.`,
  ].join("\n");
  const started = Date.now();
  const r = await llm.json<Record<string, unknown>>(councilJsonSchema(rf.guards, posts), system, user, { tier: "fast", task: "factions.council", maxTokens: 400, player: null });
  const v = r.value;
  if (!isObj(v)) return;
  const posture = (ALLOWED[rules.posture] as string[]).includes(String(v.posture)) ? (v.posture as FactionPosture) : rules.posture;
  const priceMult = typeof v.priceMult === "number" ? clampPrice(v.priceMult, rf) : rules.priceMult;
  const seen = new Set<string>();
  const guards: GuardPost[] = [];
  for (const g of Array.isArray(v.guardPosts) ? v.guardPosts : []) {
    if (!isObj(g)) continue;
    const npc = String(g.npc ?? "");
    const post = String(g.post ?? "");
    if (!rf.guards.includes(npc) || seen.has(npc) || !(posts.includes(post) || /^home:[a-z0-9_-]+$/.test(post) && rf.members.includes(post.slice(5)))) continue;
    seen.add(npc);
    guards.push({ npc, post });
  }
  for (const g of rules.guards) if (!seen.has(g.npc)) guards.push(g);
  let announcement = cleanText(v.announcement, 160) || rules.announcement;
  const mod = await ctx.moderation.check(announcement, { direction: "output", manifest: m });
  if (!mod.ok) announcement = rules.announcement;
  const why = (cleanText(v.why, 160) || rules.why).slice(0, 200);
  const source = isReplayModel(r.model) ? "replay" : "ai";
  // the rules decision is already committed; read the mind again so the "previous" state is the rules one
  const now = mindOf(ctx, ctx.world, rf.id);
  commit(ctx, rf, now, { ...rules, posture, priceMult, guards, announcement, why: `council: ${why}` }, { source, model: r.model, ms: r.ms || Date.now() - started, reason: "council" });
}

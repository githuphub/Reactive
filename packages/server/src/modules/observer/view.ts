// Read-side view of the player model: trait scores decayed to "now" (behaviour traits fade when the player stops
// doing the thing; state traits like rich/broke don't), sorted top traits, and a compact text summary for prompts.
import type { PlayerModel, TraitScore } from "@liveforge/protocol";
import { moduleOptions, type Manifest } from "@liveforge/manifest";
import { BUILTIN_TRAITS, observerOptions } from "./traits.js";
import type { ModelState } from "./model.js";

/** Score of one trait decayed to `now`. */
export function decayedScore(name: string, ts: TraitScore, now: number, designerHalfLifeMs: number): number {
  const info = BUILTIN_TRAITS[name];
  const half = info ? info.halfLifeMs : designerHalfLifeMs;
  if (!half) return ts.score;
  const dt = Math.max(0, now - ts.updatedAt);
  return Math.round(ts.score * Math.pow(0.5, dt / half) * 1000) / 1000;
}

export interface ModelView extends PlayerModel {
  top: { trait: string; score: number }[];
}

/** The public model at `now` (no private accumulators). */
export function viewModel(model: ModelState | PlayerModel, now: number, manifest: Manifest, topN = 5): ModelView {
  const o = observerOptions(moduleOptions(manifest, "observer"));
  const traits: Record<string, TraitScore> = {};
  for (const [name, ts] of Object.entries(model.traits ?? {})) {
    traits[name] = { ...ts, evidence: [...(ts.evidence ?? [])], score: decayedScore(name, ts, now, o.designerHalfLifeMin * 60_000) };
  }
  const top = Object.entries(traits)
    .filter(([, t]) => t.score >= 0.2)
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, topN)
    .map(([trait, t]) => ({ trait, score: t.score }));
  return {
    player: model.player,
    traits,
    moments: [...(model.moments ?? [])],
    profile: model.profile ?? null,
    stats: { ...(model.stats ?? {}) },
    eventCount: model.eventCount ?? 0,
    ...(model.lastSeen !== undefined ? { lastSeen: model.lastSeen } : {}),
    top,
  };
}

/** Trait score at `now` (0 when unknown). */
export function traitAt(model: ModelState | PlayerModel, name: string, now: number, manifest: Manifest): number {
  const ts = model.traits?.[name];
  if (!ts) return 0;
  const o = observerOptions(moduleOptions(manifest, "observer"));
  return decayedScore(name, ts, now, o.designerHalfLifeMin * 60_000);
}

/** Gear tags currently equipped (from gear.equipped tags). */
export function gearTags(model: PlayerModel): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(model.stats ?? {})) if (k.startsWith("tags:") && typeof v === "string") for (const t of v.split(",")) if (t) out.add(t);
  return [...out];
}

/** Equipped item names by slot. */
export function gearNames(model: PlayerModel): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(model.stats ?? {})) if (k.startsWith("gear:") && typeof v === "string" && v) out[k.slice(5)] = v;
  return out;
}

/**
 * Compact plain-text description of a player for prompts (Persona, Director, Quests): top traits with one piece of
 * evidence, notable stats, recent moments and the profile.
 */
export function describePlayer(view: ModelView, opts: { maxMoments?: number } = {}): string {
  const lines: string[] = [];
  if (view.top.length) {
    lines.push("Traits: " + view.top.map((t) => `${t.trait} ${t.score.toFixed(2)}${view.traits[t.trait]?.evidence[0] ? ` (${view.traits[t.trait].evidence[0]})` : ""}`).join("; "));
  }
  const s = view.stats;
  const facts: string[] = [];
  if (typeof s.gold === "number") facts.push(`gold ${Math.round(s.gold)}`);
  if (typeof s.zone === "string") facts.push(`in ${s.zone}`);
  if (typeof s.kills === "number") facts.push(`${s.kills} kills`);
  if (typeof s.deaths === "number") facts.push(`${s.deaths} deaths`);
  if (typeof s.quests_completed === "number") facts.push(`${s.quests_completed} quests done`);
  const gear = gearNames(view);
  if (Object.keys(gear).length) facts.push("wearing " + Object.entries(gear).map(([slot, n]) => `${n} (${slot})`).join(", "));
  if (facts.length) lines.push("Facts: " + facts.join(", "));
  const moments = view.moments.slice(0, opts.maxMoments ?? 3);
  if (moments.length) lines.push("Recent moments: " + moments.map((m) => `${m.kind}${m.evidence[0] ? ` (${m.evidence[0]})` : ""}`).join("; "));
  if (view.profile?.text) lines.push("Profile: " + view.profile.text);
  return lines.join("\n") || "Nothing notable known about this player yet.";
}

// Context facets for one (speaker, player) situation: active traits above threshold, recent moments, outfit / gear /
// appearance, time + weather, location, rumours this speaker knows about the player, nickname, attitude and the
// library's own statuses (regular, debtor, coward, returning ...). -> fingerprint + context sentence.
import type { PlayerModel } from "@liveforge/protocol";
import type { ModuleContext } from "../../../module.js";
import { contextSentence, fingerprintOf, rankFacets, uniqFacets, type Facet } from "../../../core/combination/index.js";
import { traitAt } from "../../observer/view.js";
import { knownRumours } from "../rumours.js";
import { attitudeOf } from "../factions.js";
import { humanise, nameOf, personaById, playerLabel, safeProjection } from "../util.js";
import { paramsOf, pNum, recipeOn } from "./config.js";
import type { LedgerState } from "./state.js";

export type FacetHost = Pick<ModuleContext, "projections" | "manifest" | "options" | "now">;

export interface Situation {
  facets: Facet[];
  fingerprint: string;
  sentence: string;
  /** How rules text addresses the player (nickname if one stuck, else the label). */
  address: string;
  label: string;
  speakerName: string;
}

const APPEARANCE_WORDS: Record<string, string> = { bloodied: "bloodied", wet: "soaked through", burnt: "scorched", muddy: "caked in mud" };
const WEATHER_WORDS: Record<string, string> = { rain: "in the rain", storm: "in the storm", snow: "in the snow", fog: "in the fog", heat: "in the heat" };

const SLOT_RANK = ["body", "chest", "back", "head", "weapon", "offhand", "legs", "hands", "feet", "trinket"];

/** Speaker display name: persona, boss or "the town". */
export function speakerName(m: ModuleContext["manifest"], speaker: string): string {
  if (!speaker || speaker === "world") return "The town";
  return personaById(m, speaker)?.name ?? m.bosses.find((b) => b.id === speaker)?.name ?? nameOf(m, speaker);
}

/** The most notable outfit pieces (body / back / head first, then weapon). */
export function outfitPieces(l: LedgerState): { slot: string; name: string; tags: string[]; colors: string[]; id: string }[] {
  const slots = Object.entries(l.outfit?.slots ?? {});
  slots.sort((a, b) => (SLOT_RANK.indexOf(a[0]) + 99) % 99 - (SLOT_RANK.indexOf(b[0]) + 99) % 99);
  return slots.map(([slot, v]) => ({ slot, ...v }));
}

export function buildSituation(ctx: FacetHost, world: string, player: string, speaker: string, l: LedgerState, extra: Facet[] = []): Situation {
  const m = ctx.manifest;
  const now = ctx.now();
  const eng = m.reactions.engine;
  const facets: Facet[] = [...extra];

  // ---- player model: traits + moments
  const model = safeProjection<PlayerModel>(ctx, "observer.player_model", { world, player });
  if (model) {
    const traits = Object.keys(model.traits ?? {})
      .map((k) => [k, traitAt(model, k, now, m)] as const)
      .filter(([, v]) => v >= eng.traitThreshold)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
    for (const [k, v] of traits) facets.push({ kind: "trait", key: k, text: humanise(k), weight: v });
    for (const mo of (model.moments ?? []).filter((x) => now - x.ts < eng.momentMinutes * 60_000).slice(0, 2)) {
      facets.push({ kind: "moment", key: mo.kind, text: humanise(mo.kind), weight: Math.max(0.3, mo.salience ?? 0.5) });
    }
  }

  // ---- outfit + appearance
  const pieces = outfitPieces(l);
  for (const p of pieces.slice(0, 2)) facets.push({ kind: "gear", key: p.id.toLowerCase().slice(0, 40), text: `wearing ${p.name}`, weight: 0.55 });
  const colour = pieces.find((p) => p.colors.length)?.colors[0];
  if (colour) facets.push({ kind: "color", key: colour.toLowerCase(), text: `all in ${colour.toLowerCase()}`, weight: 0.4 });
  for (const t of [...(l.outfit?.styleTags ?? []), ...(pieces[0]?.tags ?? [])].slice(0, 2)) facets.push({ kind: "style", key: t.toLowerCase(), text: `${t.toLowerCase()} look`, weight: 0.35 });
  const threshold = recipeOn(m, "appearance_state") ? pNum(paramsOf(m, "appearance_state"), "threshold", 0.5) : 0.5;
  for (const k of ["bloodied", "wet", "burnt", "muddy"] as const) {
    const v = l.appearance[k];
    if (v >= threshold) facets.push({ kind: "appearance", key: k, text: APPEARANCE_WORDS[k], weight: v });
  }

  // ---- clock, weather, place
  if (l.time) {
    if (l.time.phase !== "day") facets.push({ kind: "time", key: l.time.phase, text: l.time.phase === "night" ? "at night" : `at ${l.time.phase}`, weight: l.time.phase === "night" ? 0.5 : 0.35 });
    if (l.time.weather && l.time.weather !== "clear") facets.push({ kind: "weather", key: l.time.weather, text: WEATHER_WORDS[l.time.weather] ?? `in the ${l.time.weather}`, weight: l.time.weather === "storm" ? 0.6 : 0.45 });
  }
  const zone = l.zone || (typeof model?.stats?.zone === "string" ? model.stats.zone : "");
  if (zone) facets.push({ kind: "zone", key: zone, text: `in ${nameOf(m, zone)}`, weight: 0.15 });

  // ---- speaker-specific: rumours, attitude
  const persona = personaById(m, speaker);
  if (persona) {
    for (const r of knownRumours(ctx, world, speaker, { player, limit: 3 }).filter((x) => x.about?.player === player).slice(0, 2)) {
      facets.push({ kind: "rumour", key: r.id, text: `"${r.content.slice(0, 90)}"`, weight: Math.max(0.3, r.heat) });
    }
    const a = attitudeOf(ctx, world, player, speaker);
    if (a <= -0.15) facets.push({ kind: "attitude", key: "cold", text: a <= -0.5 ? "can't stand them" : "is wary of them", weight: Math.min(1, Math.abs(a)) });
    else if (a >= 0.15) facets.push({ kind: "attitude", key: "warm", text: a >= 0.5 ? "is fond of them" : "likes them", weight: Math.min(1, a) });
  }

  // ---- library statuses
  if (l.nickname) facets.push({ kind: "nickname", key: l.nickname.name, text: `called "${l.nickname.name}"`, weight: 0.7 });
  if (l.mood.turned !== "neutral") facets.push({ kind: "status", key: `town_${l.mood.turned}`, text: l.mood.turned === "warm" ? "the town is fond of them" : "the town has soured on them", weight: 0.4 });
  const open = l.promises.find((p) => p.status === "open" && p.to === speaker);
  if (open) facets.push({ kind: "status", key: open.debt ? "debtor" : "owes_promise", text: open.debt ? `owes ${Math.round(open.debt)} gold` : `promised "${open.text.slice(0, 60)}"`, weight: 0.6 });
  if (l.claims.some((c) => c.caught && c.to === speaker && now - c.ts < 60 * 60_000)) facets.push({ kind: "status", key: "caught_lying", text: "was caught lying to them", weight: 0.65 });
  const flees = l.flees.filter((f) => now - f.ts < 30 * 60_000).length;
  if (flees >= 3) facets.push({ kind: "status", key: "coward", text: "known to run from fights", weight: 0.5 });
  const grief = l.companions.find((c) => now - c.ts < 30 * 60_000);
  if (grief) facets.push({ kind: "status", key: "grieving", text: `mourning ${nameOf(m, grief.companion)}`, weight: 0.7 });
  if (l.session.absenceMs >= 3_600_000 && now - l.session.startedAt < 10 * 60_000) {
    facets.push({ kind: "status", key: "returning", text: `back after ${Math.round(l.session.absenceMs / 3_600_000)} hours away`, weight: 0.55 });
  }
  for (const [place, v] of Object.entries(l.visits)) {
    if (v.kind !== "zone" && v.sessions >= 3 && (persona?.zone === place || speaker === place)) facets.push({ kind: "status", key: `regular_${place}`, text: `a regular at ${nameOf(m, place)}`, weight: 0.5 });
  }
  const boss = l.bosses[speaker];
  if (boss && boss.attempts) {
    const bucket = boss.attempts >= 6 ? "many" : boss.attempts >= 3 ? "several" : boss.attempts === 1 ? "first" : "few";
    facets.push({ kind: "status", key: `attempts_${bucket}`, text: `${boss.attempts} attempts, ${boss.deaths} deaths against ${speakerName(m, speaker)}`, weight: 0.6 });
  }

  const ranked = rankFacets(uniqFacets(facets)).slice(0, 14);
  const label = playerLabel(ctx, world, player);
  const address = l.nickname?.name ?? label;
  const name = speakerName(m, speaker);
  return {
    facets: ranked,
    fingerprint: fingerprintOf(ranked),
    sentence: contextSentence(ranked, { speaker: name, player: label }),
    address,
    label,
    speakerName: name,
  };
}

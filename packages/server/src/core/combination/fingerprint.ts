// Context fingerprints (Reaction Library combination engine, R1). A fingerprint is the set of facets that describe
// one (speaker, player) situation right now: active traits, recent moments, gear / appearance tags, time and
// weather, location, rumours the speaker knows, nickname, attitude ... Facets are bucketed (no raw numbers), so the
// same situation always hashes to the same fingerprint, and a new combination hashes to a new one.
import { hashString } from "@liveforge/protocol";

export interface Facet {
  /** trait | moment | gear | color | style | appearance | time | weather | zone | rumour | attitude | nickname | status | deed | ... */
  kind: string;
  /** Bucketed key inside the kind ("rich", "rain", "bloodied", "crimson"). */
  key: string;
  /** Human words for the context sentence ("soaked through", "wearing a crimson cloak"). */
  text: string;
  /** 0-1 how strongly it colours the situation (drives ordering + combination weighting). */
  weight: number;
}

export const facetId = (f: Pick<Facet, "kind" | "key">): string => `${f.kind}:${f.key}`;

/** Strongest first; ties by id so the order is stable. */
export function rankFacets(facets: Facet[]): Facet[] {
  return [...facets].sort((a, b) => b.weight - a.weight || facetId(a).localeCompare(facetId(b)));
}

/** De-duplicate by id (keeps the heaviest). */
export function uniqFacets(facets: Facet[]): Facet[] {
  const out = new Map<string, Facet>();
  for (const f of facets) {
    const id = facetId(f);
    const prev = out.get(id);
    if (!prev || prev.weight < f.weight) out.set(id, f);
  }
  return [...out.values()];
}

/** Stable short hash of the facet set (order-independent). */
export function fingerprintOf(facets: Facet[]): string {
  const ids = [...new Set(facets.map(facetId))].sort();
  return ids.length ? hashString(ids.join("|")).toString(36).padStart(7, "0") : "0000000";
}

/** How many of the facets belong to the given kinds (or exact ids "kind:key"). */
export function overlap(facets: Facet[], wanted: string[]): number {
  let n = 0;
  for (const f of facets) if (wanted.includes(f.kind) || wanted.includes(facetId(f))) n++;
  return n;
}

const GROUP_ORDER = ["nickname", "time", "weather", "zone", "appearance", "gear", "color", "style", "trait", "moment", "deed", "status", "rumour", "attitude"];

/**
 * A readable sentence for prompts and the dashboard, e.g.
 * `Pell sees the newcomer (called "Titanbreaker") at dusk, in the rain, in The Courtyard: soaked through; wearing a
 * crimson cloak; known as rich, dodger; lately: flawless phase; has heard "..."; feels warm toward them.`
 */
export function contextSentence(facets: Facet[], opts: { speaker?: string; player: string }): string {
  const by = new Map<string, Facet[]>();
  for (const f of rankFacets(facets)) by.set(f.kind, [...(by.get(f.kind) ?? []), f]);
  const parts: string[] = [];
  const take = (kind: string, n = 3) => (by.get(kind) ?? []).slice(0, n).map((f) => f.text);
  const nick = take("nickname", 1)[0];
  const setting = [...take("time", 1), ...take("weather", 1), ...take("zone", 1)].join(", ");
  const head = `${opts.speaker ? `${opts.speaker} sees ` : ""}${opts.player}${nick ? ` (${nick})` : ""}${setting ? ` ${setting}` : ""}`;
  const looks = [...take("appearance", 2), ...take("gear", 2), ...take("color", 1), ...take("style", 1)];
  if (looks.length) parts.push(looks.join("; "));
  const traits = take("trait", 4);
  if (traits.length) parts.push(`known as ${traits.join(", ")}`);
  const recent = [...take("moment", 2), ...take("deed", 2)];
  if (recent.length) parts.push(`lately: ${recent.join(", ")}`);
  const status = take("status", 3);
  if (status.length) parts.push(status.join("; "));
  const rumours = take("rumour", 2);
  if (rumours.length) parts.push(`has heard ${rumours.join(" and ")}`);
  const att = take("attitude", 1);
  if (att.length) parts.push(att[0]);
  for (const [kind, list] of by) if (!GROUP_ORDER.includes(kind)) parts.push(list.slice(0, 2).map((f) => f.text).join(", "));
  return `${head}${parts.length ? `: ${parts.join("; ")}` : ""}.`.slice(0, 400);
}

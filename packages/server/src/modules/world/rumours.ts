// Rumours: created from moments, notable signals and persona memories; spread NPC -> NPC on a tick by
// proximity (zones), factions and relationships; drift a little with every retelling (rules templates, or an
// LLM-flavoured retelling as a budgeted upgrade); heat decays over time. Projection "world.rumours".
import type { Moment, Rumour, RumourState, StoredEvent } from "@liveforge/protocol";
import type { EventContext, ModuleContext, Projection, ScopedContext, TickContext } from "../../module.js";
import {
  clamp, clip, factionRelation, humanise, loreSystem, moderateOut, nameOf, neighbours, numOr, opt, personaById, personaCard,
  personasInZone, pick, playerLabel, rngFrom, round3, safeProjection, shortId, shuffle, str, type Persona,
} from "./util.js";
import { makeDslEnv } from "./dsl.js";

/** Extra per-rumour data kept beside the canonical RumourState (not part of the wire Rumour). */
export interface RumourMeta {
  /** -1..1: how it reflects on whoever it is about (drives NPC attitudes). */
  sentiment: number;
  /** Dedupe key ("killed:forge_titan"). */
  key: string;
}
export type WorldRumourState = RumourState & { meta: Record<string, RumourMeta> };

const MAX_RUMOURS = 80;
const MAX_EDGES = 400;
const MAX_HISTORY = 6;

// ------------------------------------------------------------------ projection

export const rumoursProjection: Projection<WorldRumourState> = {
  name: "world.rumours",
  scope: "world",
  version: 1,
  types: ["lf.world.rumour", "lf.world.rumour_spread", "lf.world.rumour_mutated", "lf.world.rumour_decay"],
  init: () => ({ rumours: [], spread: [], meta: {} }),
  apply(s, ev) {
    s.meta ??= {};
    const d = ev.data;
    switch (ev.type) {
      case "lf.world.rumour": {
        const r = d.rumour as Rumour | undefined;
        if (!r?.id) return;
        const i = s.rumours.findIndex((x) => x.id === r.id);
        if (i >= 0) s.rumours[i] = { ...s.rumours[i], ...r, knownBy: [...new Set([...s.rumours[i].knownBy, ...(r.knownBy ?? [])])] };
        else s.rumours.push({ ...r, knownBy: [...new Set(r.knownBy ?? [])], mutations: r.mutations ?? 0 });
        s.meta[r.id] = { sentiment: numOr(d.sentiment, 0), key: str(d.key) || r.id };
        if (s.rumours.length > MAX_RUMOURS) {
          const drop = [...s.rumours].sort((a, b) => a.heat - b.heat || a.createdAt - b.createdAt).slice(0, s.rumours.length - MAX_RUMOURS).map((x) => x.id);
          s.rumours = s.rumours.filter((x) => !drop.includes(x.id));
          for (const id of drop) delete s.meta[id];
        }
        return;
      }
      case "lf.world.rumour_spread": {
        const r = s.rumours.find((x) => x.id === d.rumourId);
        if (!r) return;
        const to = str(d.to);
        if (to && !r.knownBy.includes(to)) r.knownBy.push(to);
        s.spread.push({ rumourId: r.id, from: str(d.from), to, ts: ev.ts });
        if (s.spread.length > MAX_EDGES) s.spread.splice(0, s.spread.length - MAX_EDGES);
        if (typeof d.heat === "number") r.heat = clamp(d.heat, 0, 1);
        mutate(r, d);
        return;
      }
      case "lf.world.rumour_mutated": {
        const r = s.rumours.find((x) => x.id === d.rumourId);
        if (r) mutate(r, d);
        return;
      }
      case "lf.world.rumour_decay": {
        const heat = (d.heat ?? {}) as Record<string, number>;
        for (const r of s.rumours) if (typeof heat[r.id] === "number") r.heat = clamp(heat[r.id], 0, 1);
        const drop = Array.isArray(d.drop) ? (d.drop as string[]) : [];
        if (drop.length) {
          s.rumours = s.rumours.filter((x) => !drop.includes(x.id));
          s.spread = s.spread.filter((e) => !drop.includes(e.rumourId));
          for (const id of drop) delete s.meta[id];
        }
        return;
      }
    }
  },
};

function mutate(r: Rumour, d: Record<string, unknown>): void {
  const content = str(d.content);
  if (!content || content === r.content) return;
  r.history = [r.content, ...(r.history ?? [])].slice(0, MAX_HISTORY);
  r.content = content.slice(0, 280);
  r.mutations = (r.mutations ?? 0) + 1;
  if (typeof d.truthfulness === "number") r.truthfulness = clamp(d.truthfulness, 0, 1);
}

// ------------------------------------------------------------------ reads (for other modules: K1 barks / replies)

/** Rumour state of a world (empty when the world module is disabled). */
export function rumourState(ctx: Pick<ModuleContext, "projections">, world: string): WorldRumourState {
  const s = safeProjection<WorldRumourState>(ctx, "world.rumours", { world });
  return s ? { ...s, meta: s.meta ?? {} } : { rumours: [], spread: [], meta: {} };
}

/**
 * Rumours an NPC knows, hottest first; rumours about `player` (when given) rank above others.
 * This is the read K1's barks / replies use to let NPCs repeat gossip.
 */
export function knownRumours(ctx: Pick<ModuleContext, "projections">, world: string, npc: string, opts: { player?: string | null; limit?: number } = {}): Rumour[] {
  const s = rumourState(ctx, world);
  const about = (r: Rumour) => (opts.player && r.about?.player === opts.player ? 1 : 0);
  return s.rumours
    .filter((r) => r.knownBy.includes(npc))
    .sort((a, b) => about(b) - about(a) || b.heat - a.heat)
    .slice(0, opts.limit ?? 5);
}

// ------------------------------------------------------------------ creation

export interface RumourDraft {
  key: string;
  content: string;
  heat: number;
  sentiment: number;
  truthfulness?: number;
  origin: Rumour["origin"];
  about?: Rumour["about"];
  /** NPCs that learn it first (witnesses). Empty -> NPCs in the player's zone, else one nearby NPC. */
  knownBy?: string[];
}

/** Witnesses: explicit ids + NPCs in the player's zone, else the NPC the event mentions, else one seeded NPC. */
function witnesses(ctx: ScopedContext, player: string | null, explicit: string[], mentioned: string[]): string[] {
  const m = ctx.manifest;
  const out = new Set(explicit.filter((id) => personaById(m, id)));
  for (const id of mentioned) if (personaById(m, id)) out.add(id);
  if (player) {
    const zone = makeDslEnv(ctx, ctx.world, player).zone();
    for (const p of personasInZone(m, zone)) out.add(p.id);
  }
  if (!out.size && m.personas.length) out.add(pick(m.personas, rngFrom(`${ctx.world}:${player}:${ctx.now()}`))!.id);
  return [...out].slice(0, 6);
}

/** Create (record) a rumour, unless the same key was created for this player recently. Returns it or null. */
export function createRumour(ctx: ScopedContext, draft: RumourDraft, opts: { player?: string | null; mentioned?: string[]; explicitWitnesses?: string[] } = {}): Rumour | null {
  const player = opts.player ?? draft.about?.player ?? null;
  if (!ctx.manifest.personas.length) return null;
  const cooldownMs = opt(ctx, "rumourCooldownSec", 120) * 1000;
  const kvKey = `rc:${ctx.world}:${player ?? "-"}:${draft.key}`;
  const last = ctx.kv.get<number>(kvKey) ?? 0;
  const now = ctx.now();
  if (now - last < cooldownMs) return null;
  ctx.kv.set(kvKey, now);

  const knownBy = draft.knownBy?.length ? draft.knownBy.filter((id) => personaById(ctx.manifest, id)) : witnesses(ctx, player, opts.explicitWitnesses ?? [], opts.mentioned ?? []);
  const rumour: Rumour = {
    id: shortId("rum", `${ctx.world}:${player}:${draft.key}:${now}`),
    content: clip(draft.content, 280),
    truthfulness: clamp(draft.truthfulness ?? 1, 0, 1),
    heat: clamp(draft.heat, 0.05, 1),
    origin: draft.origin,
    ...(draft.about ? { about: draft.about } : {}),
    knownBy,
    createdAt: now,
    mutations: 0,
  };
  ctx.record("lf.world.rumour", { rumour, sentiment: clamp(draft.sentiment, -1, 1), key: draft.key }, { player });
  for (const npc of knownBy.slice(0, 3)) {
    ctx.emit({ kind: "rumour.heard", target: `npc:${npc}`, args: { npc, rumourId: rumour.id, content: rumour.content, heat: rumour.heat }, why: `${nameOf(ctx.manifest, npc)} witnessed it` }, { player: null });
  }
  return rumour;
}

/** Built-in moment kinds -> rumour wording. `{p}` = player label. */
const MOMENT_TEXT: Record<string, (p: string, mo: Moment, n: (id: string) => string) => { text: string; sentiment: number }> = {
  near_death_escape: (p, mo, n) => ({ text: `${p} escaped death by a hair${mo.data?.source ? ` against ${n(str(mo.data.source))}` : ""}.`, sentiment: 0.2 }),
  flawless_phase: (p, mo, n) => ({ text: `${p} fought ${mo.data?.boss ? n(str(mo.data.boss)) : "a boss"} without taking a single scratch.`, sentiment: 0.5 }),
  comeback: (p) => ({ text: `${p} turned a lost fight around at the last moment.`, sentiment: 0.4 }),
  betrayal: (p, mo, n) => ({ text: `${p} betrayed ${mo.data?.npc ? n(str(mo.data.npc)) : "someone who trusted them"}.`, sentiment: -0.7 }),
  absurd_purchase: (p, mo) => ({ text: `${p} paid ${mo.data?.price ? `${mo.data.price} gold` : "a fortune"} for ${mo.data?.item ? humanise(str(mo.data.item)) : "something ridiculous"}.`, sentiment: 0 }),
  first_kill_of_type: (p, mo) => ({ text: `${p} killed their first ${humanise(str(mo.data?.type ?? mo.data?.target_type ?? "beast"))}.`, sentiment: 0.2 }),
  broken_promise: (p, mo, n) => ({ text: `${p} broke a promise${mo.data?.npc ? ` to ${n(str(mo.data.npc))}` : ""}.`, sentiment: -0.5 }),
};

/** Notable signals -> rumour drafts (without the Observer). */
function signalDraft(ctx: ScopedContext, ev: StoredEvent, p: string): { draft: Omit<RumourDraft, "origin">; mentioned: string[] } | null {
  const m = ctx.manifest;
  const d = ev.data;
  const n = (id: string) => nameOf(m, id);
  const bigPurchase = opt(ctx, "bigPurchase", 500);
  switch (ev.type) {
    case "combat.killed": {
      const target = str(d.target);
      if (personaById(m, target)) return { draft: { key: `killed:${target}`, content: `${p} killed ${n(target)}!`, heat: 1, sentiment: -0.9 }, mentioned: [] };
      if (d.boss === true || m.bosses.some((b) => b.id === target)) return { draft: { key: `boss:${target}`, content: `${p} brought down ${n(target)}.`, heat: 0.85, sentiment: 0.6 }, mentioned: [] };
      if (d.elite === true) return { draft: { key: `elite:${str(d.target_type) || target}`, content: `${p} slew an elite ${humanise(str(d.target_type) || target)}.`, heat: 0.45, sentiment: 0.3 }, mentioned: [] };
      return null;
    }
    case "combat.died": {
      const killer = str(d.killer) || str(d.killer_type);
      if (!killer || !(m.bosses.some((b) => b.id === killer) || d.killer_type === "boss")) return null;
      return { draft: { key: `died:${killer}`, content: `${p} was beaten by ${n(killer)}.`, heat: 0.45, sentiment: -0.1 }, mentioned: [] };
    }
    case "economy.bought": {
      const price = numOr(d.price, 0);
      if (price < bigPurchase) return null;
      return { draft: { key: `bought:${str(d.item)}`, content: `${p} spent ${Math.round(price)} gold on ${humanise(str(d.item) || "something")}.`, heat: clamp(0.4 + price / (bigPurchase * 10), 0.4, 0.8), sentiment: 0 }, mentioned: [str(d.vendor)] };
    }
    case "economy.stole": {
      if (d.seen === false) return null;
      const from = str(d.from);
      return { draft: { key: `stole:${from}`, content: `${p} was seen stealing${d.item ? ` ${humanise(str(d.item))}` : ""} from ${n(from || "a stall")}.`, heat: 0.7, sentiment: -0.6 }, mentioned: [from] };
    }
    case "social.threatened": {
      const t = str(d.target);
      return { draft: { key: `threat:${t}`, content: `${p} threatened ${n(t || "someone")}.`, heat: 0.6, sentiment: -0.5 }, mentioned: [t] };
    }
    case "social.gave": {
      const to = str(d.to);
      const gold = numOr(d.gold, 0);
      if (!d.item && gold < 25) return null;
      const what = d.item ? humanise(str(d.item)) : `${Math.round(gold)} gold`;
      return { draft: { key: `gave:${to}`, content: `${p} gave ${what} to ${n(to || "a stranger")}.`, heat: 0.4, sentiment: 0.5 }, mentioned: [to] };
    }
    case "social.lied": {
      const to = str(d.to);
      return { draft: { key: `lied:${to}`, content: `${p} lied to ${n(to || "someone")}${d.about ? ` about ${humanise(str(d.about))}` : ""}.`, heat: 0.35, sentiment: -0.3, knownBy: personaById(m, to) ? [to] : undefined }, mentioned: [to] };
    }
    case "world.destroyed": {
      const obj = humanise(str(d.object) || "something");
      return { draft: { key: `destroyed:${str(d.object)}`, content: `${p} wrecked ${obj}${d.zone ? ` in ${n(str(d.zone))}` : ""}.`, heat: 0.5, sentiment: -0.3 }, mentioned: [str(d.owner)] };
    }
    case "world.helped": {
      const npc = str(d.npc);
      return { draft: { key: `helped:${npc}`, content: `${p} helped ${n(npc || "someone")}${d.how ? ` (${humanise(str(d.how))})` : ""}.`, heat: 0.5, sentiment: 0.6 }, mentioned: [npc] };
    }
  }
  return null;
}

export const RUMOUR_SIGNAL_TYPES = ["combat.killed", "combat.died", "economy.bought", "economy.stole", "social.threatened", "social.gave", "social.lied", "world.destroyed", "world.helped"];

/** Signal handler: notable signals, observer moments and salient persona memories become rumours. */
export function onRumourSource(ctx: EventContext, ev: StoredEvent): void {
  const player = ev.player;
  if (!player || opt(ctx, "rumours", true) === false) return;
  const m = ctx.manifest;
  const p = playerLabel(ctx, ctx.world, player);
  const explicit = Array.isArray(ev.data.witnesses) ? ev.data.witnesses.map(str) : [];

  if (ev.type === "lf.observer.moment") {
    const mo = ev.data.moment as Moment | undefined;
    if (!mo?.kind || (mo.salience ?? 0.5) < opt(ctx, "minMomentSalience", 0.35)) return;
    const tpl = MOMENT_TEXT[mo.kind];
    const fallback = { text: `Word is ${p} was involved in something: ${mo.evidence?.[0] ? clip(mo.evidence[0], 120) : humanise(mo.kind)}.`, sentiment: 0 };
    const t = tpl ? tpl(p, mo, (id) => nameOf(m, id)) : fallback;
    createRumour(ctx, {
      key: `moment:${mo.kind}`, content: t.text, heat: clamp(mo.salience ?? 0.5, 0.2, 1), sentiment: t.sentiment,
      origin: { kind: "moment", ref: mo.id }, about: { player },
    }, { player, explicitWitnesses: explicit, mentioned: [str(mo.data?.npc)] });
    return;
  }

  if (ev.type === "lf.persona.memory") {
    const npc = str(ev.data.npc);
    const entry = ev.data.entry as { text?: string; salience?: number; kind?: string } | undefined;
    if (!npc || !entry?.text || (entry.salience ?? 0) < opt(ctx, "minMemorySalience", 0.7)) return;
    if (!["harm", "gift", "witnessed", "trade"].includes(entry.kind ?? "")) return;
    const sentiment = entry.kind === "harm" ? -0.6 : entry.kind === "gift" ? 0.5 : 0;
    createRumour(ctx, {
      key: `memory:${npc}:${entry.kind}`, content: `${nameOf(m, npc)} keeps telling people: ${clip(entry.text, 200)}`,
      heat: clamp(entry.salience ?? 0.7, 0.3, 0.9), sentiment, truthfulness: 0.9,
      origin: { kind: "memory", npc }, about: { player, npc }, knownBy: [npc],
    }, { player });
    return;
  }

  const sd = signalDraft(ctx, ev, p);
  if (!sd) return;
  createRumour(ctx, { ...sd.draft, origin: { kind: "event", ref: `${ev.type}#${ev.seq}` }, about: { player } }, { player, explicitWitnesses: explicit, mentioned: sd.mentioned });
}

// ------------------------------------------------------------------ spread + mutation (rules)

const GOSSIP_WORDS = /gossip|news|rumou?r|chatty|talk/i;
const isGossip = (p: Persona | undefined) => !!p && (GOSSIP_WORDS.test(p.personality) || p.likes.some((l) => GOSSIP_WORDS.test(l)) || GOSSIP_WORDS.test(p.voice.style ?? ""));

type Rel = { a: string; b: string; kind: string; strength: number };
const relBetween = (rels: Rel[], a: string, b: string): Rel | undefined => rels.find((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a));
const WARM = ["ally", "friend", "family", "lover", "mentor", "employer"];
const COLD = ["rival", "enemy"];

/** Chance (per tick, before heat) that `teller` passes a rumour to `listener`. */
export function spreadChance(ctx: Pick<ModuleContext, "manifest">, rels: Rel[], teller: Persona, listener: Persona, rumour: Rumour): number {
  const m = ctx.manifest;
  let p: number;
  if (!teller.zone || !listener.zone) p = 0.1;
  else if (teller.zone === listener.zone) p = 0.25;
  else if (neighbours(m, teller.zone).includes(listener.zone)) p = 0.08;
  else p = 0.02;
  const fr = factionRelation(m, teller.faction, listener.faction);
  if (teller.faction && teller.faction === listener.faction) p += 0.1;
  else if (fr >= 0.3) p += 0.04;
  else if (fr <= -0.5) p = Math.max(0, p - 0.05);
  const rel = relBetween(rels, teller.id, listener.id);
  if (rel && WARM.includes(rel.kind)) p += 0.15 * rel.strength;
  if (rel && COLD.includes(rel.kind)) p *= 0.5;
  // Gossip about a rival travels faster.
  const aboutNpc = rumour.about?.npc;
  if (aboutNpc && aboutNpc !== teller.id) {
    const r2 = relBetween(rels, teller.id, aboutNpc);
    if (r2 && COLD.includes(r2.kind)) p *= 2;
  }
  if (isGossip(teller)) p *= 1.6;
  return clamp(p, 0, 0.95);
}

const INTENSIFY: [RegExp, string][] = [
  [/\bbeaten by\b/, "humiliated by"], [/\bkilled\b/, "slaughtered"], [/\bslew\b/, "butchered"], [/\bspent\b/, "blew"],
  [/\bstealing\b/, "robbing"], [/\bhelped\b/, "saved"], [/\bthreatened\b/, "attacked"], [/\bbrought down\b/, "single-handedly brought down"],
  [/\bwrecked\b/, "burned down"], [/\bescaped death\b/, "cheated death"], [/\ba fortune\b/, "a king's ransom"], [/\blied to\b/, "swore a false oath to"],
  [/\bgave\b/, "showered"], [/\bbetrayed\b/, "stabbed in the back"], [/\bwithout taking a single scratch\b/, "with their eyes closed"],
];
const FLOURISH = [" Or so they say.", " Twice, apparently.", " Without breaking a sweat.", " And laughed about it.", " In broad daylight.", " Everyone saw it."];
const HEDGES = ["Word is, ", "I heard ", "Rumour has it ", "They say "];

/** Rules mutation: inflate a number, intensify a verb, add a flourish or a hedge. Returns null when nothing changed. */
export function mutateText(content: string, r: () => number): string | null {
  const strategies = shuffle([0, 1, 2, 3], r);
  for (const s of strategies) {
    let out = content;
    if (s === 0) {
      const m = /\b(\d{1,6})\b/.exec(content);
      if (!m) continue;
      const n = Math.round(Number(m[1]) * (1.5 + r() * 1.5));
      out = content.replace(m[0], String(n));
    } else if (s === 1) {
      const hit = shuffle(INTENSIFY, r).find(([re]) => re.test(content));
      if (!hit) continue;
      out = content.replace(hit[0], hit[1]);
    } else if (s === 2) {
      if (FLOURISH.some((f) => content.endsWith(f.trim()))) continue;
      out = `${content}${pick(FLOURISH, r)}`;
    } else {
      if (HEDGES.some((h) => content.startsWith(h))) continue;
      out = `${pick(HEDGES, r)}${content.charAt(0).toLowerCase()}${content.slice(1)}`;
    }
    if (out !== content && out.length <= 280) return out;
  }
  return null;
}

/** Tick: hot rumours hop between NPCs; some retellings drift. Returns the edges it created. */
export function spreadTick(ctx: TickContext): { from: string; to: string; rumourId: string }[] {
  const m = ctx.manifest;
  const edges: { from: string; to: string; rumourId: string }[] = [];
  if (m.personas.length < 2 || opt(ctx, "rumours", true) === false) return edges;
  const s = rumourState(ctx, ctx.world);
  if (!s.rumours.length) return edges;
  const rels = safeProjection<{ relationships?: Rel[] }>(ctx, "world.factions", { world: ctx.world })?.relationships ?? m.relationships;
  const now = ctx.now();
  const r = rngFrom(`${ctx.world}:spread:${Math.floor(now / 1000)}`);
  const speed = opt(ctx, "spreadSpeed", 1);
  const mutationChance = opt(ctx, "mutationChance", 0.2);
  let budget = opt(ctx, "maxSpreadsPerTick", 6);

  const hot = s.rumours.filter((x) => x.heat >= 0.05 && x.knownBy.length < m.personas.length).sort((a, b) => b.heat - a.heat).slice(0, 12);
  for (const rumour of hot) {
    if (budget <= 0) break;
    let content = rumour.content;
    let truth = rumour.truthfulness;
    let heat = rumour.heat;
    const knowers = new Set(rumour.knownBy);
    for (const tellerId of shuffle(rumour.knownBy, r)) {
      if (budget <= 0) break;
      const teller = personaById(m, tellerId);
      if (!teller) continue;
      for (const listener of shuffle(m.personas.filter((p) => !knowers.has(p.id)), r)) {
        if (r() >= spreadChance(ctx, rels, teller, listener, rumour) * heat * speed) continue;
        let mutated = false;
        if (r() < mutationChance * (isGossip(teller) ? 1.5 : 1) && (rumour.mutations ?? 0) < 8) {
          const next = mutateText(content, r);
          if (next) {
            content = next;
            truth = round3(clamp(truth - (0.1 + r() * 0.1), 0, 1));
            mutated = true;
          }
        }
        heat = round3(clamp(heat + 0.03, 0, 1));
        knowers.add(listener.id);
        ctx.record("lf.world.rumour_spread", {
          rumourId: rumour.id, from: teller.id, to: listener.id, heat,
          ...(mutated ? { content, truthfulness: truth } : {}),
        }, { player: null });
        ctx.emit({
          kind: "rumour.heard", target: `npc:${listener.id}`,
          args: { npc: listener.id, rumourId: rumour.id, content, heat },
          why: clip(`${teller.name} told ${listener.name}${mutated ? " (and embellished it)" : ""}`, 200),
        }, { player: null });
        edges.push({ from: teller.id, to: listener.id, rumourId: rumour.id });
        budget--;
        break; // one retelling per teller per tick
      }
    }
  }
  return edges;
}

/** Tick: heat decays with a half-life; cold rumours are forgotten. */
export function decayTick(ctx: TickContext): void {
  const s = rumourState(ctx, ctx.world);
  if (!s.rumours.length) return;
  const now = ctx.now();
  const key = `decay:${ctx.world}`;
  const last = ctx.kv.get<number>(key) ?? now;
  ctx.kv.set(key, now);
  const dt = now - last;
  if (dt <= 0) return;
  const halfLife = opt(ctx, "rumourHalfLifeMin", 15) * 60_000;
  const factor = Math.pow(0.5, dt / halfLife);
  const heat: Record<string, number> = {};
  const drop: string[] = [];
  for (const r of s.rumours) {
    const h = round3(r.heat * factor);
    if (h < 0.02) drop.push(r.id);
    else if (Math.abs(h - r.heat) >= 0.005) heat[r.id] = h;
  }
  if (drop.length || Object.keys(heat).length) ctx.record("lf.world.rumour_decay", { heat, drop }, { player: null });
}

// ------------------------------------------------------------------ LLM-flavoured retelling (budgeted upgrade)

const RETELL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string", description: "The rumour as this NPC would retell it, max 200 characters, one or two sentences." },
    distortion: { type: "number", description: "0-1: how far the retelling drifted from the original." },
  },
  required: ["text", "distortion"],
};

/** Tick: at most one LLM retelling per world per interval, for the hottest rumour (rules keep working without it). */
export async function flavourTick(ctx: TickContext): Promise<void> {
  if (!ctx.llm || opt(ctx, "llmMutation", true) === false) return;
  if (!ctx.budgets.check(null).ok) return;
  const s = rumourState(ctx, ctx.world);
  const r = rngFrom(`${ctx.world}:flavour:${ctx.now()}`);
  const target = s.rumours.filter((x) => x.heat >= 0.3 && (x.mutations ?? 0) < 6 && x.knownBy.length).sort((a, b) => b.heat - a.heat)[0];
  if (!target) return;
  const teller = personaById(ctx.manifest, pick(target.knownBy, r));
  if (!teller) return;
  try {
    const res = await ctx.llm.json<{ text?: unknown; distortion?: unknown }>(
      RETELL_SCHEMA,
      loreSystem(ctx.manifest, "You retell village gossip in character. Keep it short, in-world, and distort ONE detail slightly (exaggerate or misremember). Never invent real-world names."),
      `NPC retelling it:\n${personaCard(teller)}\n\nCurrent rumour: "${target.content}"\nTimes retold with changes: ${target.mutations ?? 0}`,
      { tier: "fast", maxTokens: 200, task: "world.rumour", player: target.about?.player ?? null },
    );
    const text = await moderateOut(ctx, res.value.text, 200);
    if (!text || text === target.content) return;
    const drift = clamp(numOr(res.value.distortion, 0.2), 0.05, 0.5);
    ctx.record("lf.world.rumour_mutated", { rumourId: target.id, content: text, truthfulness: round3(clamp(target.truthfulness - drift * 0.5, 0, 1)), by: teller.id, source: "ai" }, { player: null });
  } catch (e) {
    ctx.log.debug("rumour retelling skipped", { error: (e as Error).message });
  }
}

/** Seed a designer rumour (admin route / other modules). */
export function seedRumour(ctx: ScopedContext, input: { content: string; npcs?: string[]; heat?: number; sentiment?: number; aboutNpc?: string; aboutPlayer?: string; truthfulness?: number }): Rumour | null {
  return createRumour(ctx, {
    key: `designer:${input.content.slice(0, 40)}`,
    content: input.content,
    heat: input.heat ?? 0.6,
    sentiment: input.sentiment ?? 0,
    truthfulness: input.truthfulness ?? 1,
    origin: { kind: "designer" },
    about: input.aboutNpc || input.aboutPlayer ? { ...(input.aboutNpc ? { npc: input.aboutNpc } : {}), ...(input.aboutPlayer ? { player: input.aboutPlayer } : {}) } : undefined,
    knownBy: input.npcs,
  }, { player: input.aboutPlayer ?? null });
}

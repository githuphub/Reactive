// Factions, reputation and NPC relationships. Projection "world.factions" (world scope): reputation per faction per
// player, plus the NPC relationship graph seeded from the manifest and changed by "lf.world.relationship" events.
// Reputation drives NPC attitudes, shop prices and guard behaviour (standing).
import type { FactionState, StoredEvent } from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";
import type { EventContext, ModuleContext, Projection, ScopedContext } from "../../module.js";
import { clamp, factionById, factionRelation, nameOf, numOr, opt, personaById, resolveFaction, round3, safeProjection, str } from "./util.js";
import { rumourState } from "./rumours.js";

export interface ReputationChange {
  ts: number;
  faction: string;
  player: string;
  delta: number;
  reason: string;
}
/** FactionState plus a short change log for the dashboard. */
export type WorldFactionState = FactionState & { changes: ReputationChange[] };

const MAX_CHANGES = 100;

const seedRelationships = (m: Manifest): FactionState["relationships"] =>
  m.relationships.map((r) => ({ a: r.a, b: r.b, kind: r.kind, strength: r.strength }));

export const factionsProjection: Projection<WorldFactionState> = {
  name: "world.factions",
  scope: "world",
  version: 1,
  types: ["lf.world.reputation", "lf.world.relationship"],
  init: (_key, m) => ({ reputation: {}, relationships: seedRelationships(m), changes: [] }),
  apply(s, ev, env) {
    s.changes ??= [];
    const d = ev.data;
    if (ev.type === "lf.world.reputation") {
      const faction = str(d.faction);
      const player = ev.player ?? str(d.player);
      if (!faction || !player) return;
      const row = (s.reputation[faction] ??= {});
      const base = row[player] ?? factionById(env.manifest, faction)?.attitude ?? 0;
      const next = typeof d.set === "number" ? d.set : base + numOr(d.delta, 0);
      row[player] = round3(clamp(next, -1, 1));
      s.changes.push({ ts: ev.ts, faction, player, delta: round3(row[player] - base), reason: str(d.reason).slice(0, 120) });
      if (s.changes.length > MAX_CHANGES) s.changes.splice(0, s.changes.length - MAX_CHANGES);
      return;
    }
    if (ev.type === "lf.world.relationship") {
      const a = str(d.a);
      const b = str(d.b);
      if (!a || !b || a === b) return;
      const i = s.relationships.findIndex((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a));
      if (d.remove === true) {
        if (i >= 0) s.relationships.splice(i, 1);
        return;
      }
      const cur = i >= 0 ? s.relationships[i] : { a, b, kind: str(d.kind) || "friend", strength: 0.5 };
      const kind = str(d.kind) || cur.kind;
      const strength = round3(clamp(typeof d.strength === "number" ? d.strength : cur.strength + numOr(d.delta, 0), 0, 1));
      const next = { a: cur.a, b: cur.b, kind, strength };
      if (i >= 0) s.relationships[i] = next;
      else s.relationships.push(next);
    }
  },
};

// ------------------------------------------------------------------ reads

export function factionState(ctx: Pick<ModuleContext, "projections" | "manifest">, world: string): WorldFactionState {
  const s = safeProjection<WorldFactionState>(ctx, "world.factions", { world });
  return s ? { ...s, changes: s.changes ?? [] } : { reputation: {}, relationships: seedRelationships(ctx.manifest), changes: [] };
}

/** Player reputation with a faction (-1..1); defaults to the faction's manifest attitude. */
export function reputationOf(ctx: Pick<ModuleContext, "projections" | "manifest">, world: string, player: string, faction: string): number {
  const v = factionState(ctx, world).reputation[faction]?.[player];
  return typeof v === "number" ? v : factionById(ctx.manifest, faction)?.attitude ?? 0;
}

/**
 * An NPC's attitude toward the player (-1..1): persona memory attitude (when the Persona module has one) blended
 * with faction reputation, nudged by the rumours this NPC has heard about the player.
 */
export function attitudeOf(ctx: Pick<ModuleContext, "projections" | "manifest">, world: string, player: string, npc: string): number {
  const p = personaById(ctx.manifest, npc);
  const base = p?.faction ? reputationOf(ctx, world, player, p.faction) : 0;
  const mem = safeProjection<{ npcs?: Record<string, { attitude?: number }> }>(ctx, "persona.memories", { world, player })?.npcs?.[npc]?.attitude;
  let a = typeof mem === "number" ? 0.6 * mem + 0.4 * base : base;
  const rs = rumourState(ctx, world);
  let gossip = 0;
  for (const r of rs.rumours) {
    if (r.about?.player !== player || !r.knownBy.includes(npc)) continue;
    gossip += (rs.meta[r.id]?.sentiment ?? 0) * r.heat * (0.5 + 0.5 * r.truthfulness);
  }
  a += clamp(gossip * 0.3, -0.3, 0.3);
  return round3(clamp(a, -1, 1));
}

/** Shop price multiplier for an NPC: faction priceRange by attitude, clamped to manifest clamps.npc.priceMultiplier. */
export function priceFor(ctx: Pick<ModuleContext, "projections" | "manifest">, world: string, player: string, npc: string): number {
  const m = ctx.manifest;
  const f = factionById(m, personaById(m, npc)?.faction);
  const [lo, hi] = f?.priceRange ?? [0.8, 1.5];
  const a = attitudeOf(ctx, world, player, npc);
  const mult = a >= 0 ? 1 - a * (1 - lo) : 1 + -a * (hi - 1);
  const [cl, ch] = m.clamps.npc.priceMultiplier;
  return round3(clamp(mult, cl, ch));
}

export type Standing = "hostile" | "wary" | "neutral" | "friendly" | "honoured";
/** Guard / default behaviour bucket for a reputation value. */
export function standingFor(rep: number): Standing {
  if (rep <= -0.6) return "hostile";
  if (rep <= -0.3) return "wary";
  if (rep >= 0.6) return "honoured";
  if (rep >= 0.3) return "friendly";
  return "neutral";
}

/** Everything a game needs to colour NPCs for one player: reputation, standing, attitudes and prices. */
export function standingReport(ctx: Pick<ModuleContext, "projections" | "manifest">, world: string, player: string, npcs?: string[]) {
  const m = ctx.manifest;
  const reputation: Record<string, { value: number; standing: Standing; name: string }> = {};
  for (const f of m.factions) {
    const v = reputationOf(ctx, world, player, f.id);
    reputation[f.id] = { value: v, standing: standingFor(v), name: f.name };
  }
  const ids = npcs?.length ? npcs : m.personas.map((p) => p.id);
  const attitudes: Record<string, number> = {};
  const prices: Record<string, number> = {};
  for (const id of ids) {
    if (!personaById(m, id)) continue;
    attitudes[id] = attitudeOf(ctx, world, player, id);
    prices[id] = priceFor(ctx, world, player, id);
  }
  return { reputation, attitudes, prices, relationships: factionState(ctx, world).relationships };
}

// ------------------------------------------------------------------ reputation rules

/**
 * A reputation rule: when `signal` arrives, the faction referred to by `data[field]` (a faction id or an NPC id)
 * changes by `delta`. Designers add rules with manifest `modules.world.options.reputation: [{signal, field, delta,
 * faction?}]` (`faction` fixes the faction instead of reading a field).
 */
export interface RepRule {
  signal: string;
  field?: string;
  faction?: string;
  delta: number;
  reason?: string;
  /** Built-ins only: extra guard. */
  when?: (d: Record<string, unknown>) => boolean;
}

export const DEFAULT_REP_RULES: RepRule[] = [
  { signal: "economy.stole", field: "from", delta: -0.2, reason: "stole from {ref}", when: (d) => d.seen !== false },
  { signal: "social.threatened", field: "target", delta: -0.1, reason: "threatened {ref}" },
  { signal: "social.gave", field: "to", delta: 0.06, reason: "gave a gift to {ref}" },
  { signal: "world.helped", field: "npc", delta: 0.1, reason: "helped {ref}" },
  { signal: "social.lied", field: "to", delta: -0.05, reason: "lied to {ref}" },
  { signal: "combat.killed", field: "target", delta: -0.5, reason: "killed {ref}" },
  { signal: "combat.killed", field: "target_type", delta: -0.1, reason: "killed one of {ref}" },
  { signal: "world.destroyed", field: "owner", delta: -0.1, reason: "wrecked property of {ref}" },
  { signal: "economy.bought", field: "vendor", delta: 0.02, reason: "traded with {ref}" },
  { signal: "economy.sold", field: "vendor", delta: 0.01, reason: "traded with {ref}" },
];

function rulesFor(ctx: Pick<ModuleContext, "options">): RepRule[] {
  const extra = Array.isArray(ctx.options?.reputation) ? (ctx.options.reputation as Record<string, unknown>[]) : [];
  const custom = extra
    .filter((r) => typeof r?.signal === "string" && typeof r?.delta === "number")
    .map((r) => ({ signal: str(r.signal), field: str(r.field) || undefined, faction: str(r.faction) || undefined, delta: clamp(r.delta as number, -1, 1), reason: str(r.reason) || undefined }));
  return opt(ctx, "defaultReputationRules", true) ? [...DEFAULT_REP_RULES, ...custom] : custom;
}

/** Record a reputation change (+ smaller ripples to allied / enemy factions) and announce standing changes. */
export function changeReputation(ctx: ScopedContext, player: string, faction: string, delta: number, reason: string, ripple = true): void {
  const m = ctx.manifest;
  if (!factionById(m, faction) || !delta) return;
  const before = reputationOf(ctx, ctx.world, player, faction);
  ctx.record("lf.world.reputation", { faction, delta: round3(delta), reason }, { player });
  const after = reputationOf(ctx, ctx.world, player, faction);
  const sb = standingFor(before);
  const sa = standingFor(after);
  if (sb !== sa) {
    ctx.emit({
      kind: "world.reaction", target: "player",
      args: { rule: "standing", effect: sa, data: { faction, reputation: after, previous: sb } },
      why: `${nameOf(m, faction)} now sees you as ${sa} (${reason})`.slice(0, 200),
    }, { player });
  }
  if (!ripple) return;
  for (const f of m.factions) {
    if (f.id === faction) continue;
    const rel = factionRelation(m, faction, f.id);
    if (Math.abs(rel) < 0.3) continue;
    const d = round3(delta * rel * 0.5);
    if (Math.abs(d) >= 0.01) changeReputation(ctx, player, f.id, d, `${rel > 0 ? "ally" : "rival"} of ${nameOf(m, faction)}: ${reason}`.slice(0, 120), false);
  }
}

/** Signal handler: built-in + designer reputation rules, persona attitude shifts and quest rewards. */
export function onReputationSource(ctx: EventContext, ev: StoredEvent): void {
  const player = ev.player;
  if (!player || !ctx.manifest.factions.length) return;
  const m = ctx.manifest;
  const d = ev.data;

  if (ev.type === "lf.persona.attitude") {
    const f = resolveFaction(m, d.npc);
    const delta = numOr(d.delta, 0) * 0.25;
    if (f && Math.abs(delta) >= 0.005) changeReputation(ctx, player, f, delta, `${nameOf(m, str(d.npc))}'s opinion changed`);
    return;
  }
  if (ev.type === "lf.quests.completed") {
    const rewards = Array.isArray(d.rewards) ? (d.rewards as { type?: string; id?: string; amount?: number }[]) : [];
    let given = false;
    for (const r of rewards) {
      if (r?.type !== "reputation") continue;
      const f = resolveFaction(m, r.id) ?? resolveFaction(m, d.giver);
      if (f) {
        changeReputation(ctx, player, f, clamp(numOr(r.amount, 0.1), -0.5, 0.5), `quest "${str(d.title) || str(d.questId)}"`);
        given = true;
      }
    }
    const gf = resolveFaction(m, d.giver);
    if (!given && gf) changeReputation(ctx, player, gf, 0.05, `finished a quest for ${nameOf(m, str(d.giver))}`);
    return;
  }
  if (ev.type.startsWith("lf.")) return;

  for (const rule of rulesFor(ctx)) {
    if (rule.signal !== ev.type || (rule.when && !rule.when(d))) continue;
    const ref = rule.faction ?? (rule.field ? str(d[rule.field]) : "");
    const f = rule.faction ? (factionById(m, rule.faction) ? rule.faction : undefined) : resolveFaction(m, ref);
    if (!f) continue;
    const reason = (rule.reason ?? `${ev.type}`).replace("{ref}", nameOf(m, ref || f));
    changeReputation(ctx, player, f, rule.delta, reason);
  }
}

/** Gossip between allies strengthens their bond a little (relationships evolve with the world). */
export function bondFromGossip(ctx: ScopedContext, from: string, to: string): void {
  const rels = factionState(ctx, ctx.world).relationships;
  const r = rels.find((x) => (x.a === from && x.b === to) || (x.a === to && x.b === from));
  if (!r || !["ally", "friend", "family", "lover", "mentor"].includes(r.kind) || r.strength >= 0.95) return;
  ctx.record("lf.world.relationship", { a: r.a, b: r.b, delta: 0.01, reason: "shared gossip" }, { player: null });
}

// Module "world" - OWNER: K2. Only edit files inside packages/server/src/modules/world/.
// World reactions: rumours (spread + mutation), factions + reputation, NPC relationships, reactive rules.
// Contract: docs/CONTRACTS.md. Asks owned here: world.reactions.
// Projections owned here: world.rumours (world; RumourState + meta), world.factions (world; FactionState + changes).
//
// Module options (manifest modules.world.options), all optional:
//   rumours (true)               create + spread rumours at all
//   playerNoun ("the newcomer")  how rules text names the player when the player model has no stat "name"
//   minMomentSalience (0.35)     moments below this don't become rumours
//   minMemorySalience (0.7)      persona memories below this don't become rumours
//   bigPurchase (500)            economy.bought price that makes a rumour
//   rumourCooldownSec (120)      the same rumour key per player at most this often
//   spreadSpeed (1)              spread probability multiplier (tick every 5 s)
//   maxSpreadsPerTick (6)        mutationChance (0.2)        rumourHalfLifeMin (15)
//   llmMutation (true)           LLM retellings (at most one per world per 45 s, budget-checked) when keyed
//   reputation ([])              extra reputation rules [{signal, field?, faction?, delta, reason?}]
//   defaultReputationRules (true)
//   reactionEveryMs (750)        min interval between signal-driven reaction evaluations per player
import { checkDsl, type LooseDirectiveDraft, type Rumour, type StoredEvent } from "@liveforge/protocol";
import { defineModule, type EventContext, type ModuleContext, type TickContext } from "../../module.js";
import { makeDslEnv } from "./dsl.js";
import { decayTick, flavourTick, knownRumours, onRumourSource, rumoursProjection, RUMOUR_SIGNAL_TYPES, spreadTick } from "./rumours.js";
import { attitudeOf, bondFromGossip, factionsProjection, onReputationSource } from "./factions.js";
import { activeReactions, evaluateReactions, standingDrafts } from "./reactions.js";
import { opt, personaById, personasInZone, scopeFor, throttle } from "./util.js";
import { worldRoutes } from "./routes.js";

export { knownRumours, rumourState, createRumour, seedRumour, type WorldRumourState, type RumourMeta } from "./rumours.js";
export { attitudeOf, priceFor, reputationOf, standingFor, standingReport, changeReputation, type WorldFactionState } from "./factions.js";
export { activeReactions, evaluateReactions } from "./reactions.js";

/** Saved per game in init() so routes can reach the context. */
const contexts = new Map<string, ModuleContext>();

/** Event types that cannot change a reaction condition (core / our own bookkeeping). */
const skipForReactions = (t: string) =>
  t === "lf.directive" || t.startsWith("lf.world.rumour") || t === "lf.world.reaction" || t === "lf.world.reaction_flavour" || t === "lf.world.relationship";

function reactOnEvent(ctx: EventContext, ev: StoredEvent): void {
  if (!ev.player || skipForReactions(ev.type) || !ctx.manifest.reactions.length) return;
  if (!throttle(`world:react:${ctx.game}:${ev.world}:${ev.player}`, opt(ctx, "reactionEveryMs", 750), ctx.now())) return;
  evaluateReactions(ctx, ev.player, { fire: true });
}

function reactTick(ctx: TickContext): void {
  if (!ctx.manifest.reactions.length) return;
  for (const player of ctx.activePlayers.slice(0, 200)) evaluateReactions(scopeFor(ctx, ctx.world, player), player, { fire: true });
}

export default defineModule({
  id: "world",
  description: "World reactions: rumours (spread + mutation), factions + reputation, NPC relationships, reactive rules.",
  projections: [rumoursProjection, factionsProjection],
  signalHandlers: [
    { types: [...RUMOUR_SIGNAL_TYPES, "lf.observer.moment", "lf.persona.memory"], handle: onRumourSource },
    { types: ["combat.*", "economy.*", "social.*", "world.*", "lf.persona.attitude", "lf.quests.completed"], handle: onReputationSource },
    { types: ["*"], handle: reactOnEvent },
  ],
  asks: {
    "world.reactions": {
      /** Current active reactions near the player: rumours the NPCs know, directive drafts that apply, NPC attitudes. */
      instant(ctx, params) {
        const m = ctx.manifest;
        const player = ctx.player!;
        const env = makeDslEnv(ctx, ctx.world, player);
        const zone = params.zone ?? env.zone();
        const npcs = (params.npcs?.length ? params.npcs : personasInZone(m, zone).map((p) => p.id)).filter((id) => personaById(m, id));
        const scope = npcs.length ? npcs : m.personas.map((p) => p.id);
        const inScope = (d: LooseDirectiveDraft) => !d.target.startsWith("npc:") || !params.npcs?.length || scope.includes(d.target.slice(4));

        const current = evaluateReactions(ctx, player, { fire: true, env });
        const seen = new Set<string>();
        const directives: LooseDirectiveDraft[] = [];
        for (const f of activeReactions(ctx, ctx.world, player)) {
          if (seen.has(f.rule)) continue;
          seen.add(f.rule);
          directives.push(f.draft);
        }
        for (const c of current) {
          if (seen.has(c.rule.id)) continue;
          seen.add(c.rule.id);
          directives.push(c.draft);
        }
        directives.push(...standingDrafts(ctx, player));

        const rumours = new Map<string, Rumour>();
        for (const npc of scope) for (const r of knownRumours(ctx, ctx.world, npc, { player, limit: 5 })) rumours.set(r.id, r);
        const list = [...rumours.values()]
          .sort((a, b) => Number(b.about?.player === player) - Number(a.about?.player === player) || b.heat - a.heat)
          .slice(0, 10);

        const attitudes: Record<string, number> = {};
        for (const npc of scope) attitudes[npc] = attitudeOf(ctx, ctx.world, player, npc);

        const active = directives.filter(inScope).slice(0, 20);
        return {
          result: { rumours: list, directives: active, attitudes },
          why: `${active.length} reaction(s), ${list.length} rumour(s) known by ${scope.length} NPC(s)${zone ? ` in ${zone}` : ""}`,
          final: true,
        };
      },
    },
  },
  ticks: [
    { name: "rumour-spread", everyMs: 5000, run: (ctx) => { for (const e of spreadTick(ctx)) bondFromGossip(ctx, e.from, e.to); } },
    { name: "rumour-decay", everyMs: 30_000, run: decayTick },
    { name: "rumour-flavour", everyMs: 45_000, run: flavourTick },
    { name: "reactions", everyMs: 5000, run: reactTick },
  ],
  routes: worldRoutes(contexts),
  init(ctx) {
    contexts.set(ctx.game, ctx);
    for (const r of ctx.manifest.reactions) {
      const err = checkDsl(r.when);
      if (err) ctx.log.warn("reaction rule has an invalid condition and will never fire", { rule: r.id, when: r.when, error: err });
    }
  },
});

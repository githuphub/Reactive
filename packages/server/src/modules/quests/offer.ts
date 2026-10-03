// quest.offer: reactive quests in the manifest quest schema. Instant = rule templates over recent moments, rumours
// about the player, world state (rivalries, reputation) and the player model; upgrade = rich-tier LLM rewrite with
// giver dialogue, clamped back into the schema (objective types, valid targets, reward budgets).
import { cleanText, type Moment, type Quest, type QuestObjective, type QuestReward, type Rumour, type StoredEvent } from "@liveforge/protocol";
import type { AskContext, ModuleContext, ScopedContext } from "../../module.js";
import { makeDslEnv } from "../world/dsl.js";
import {
  clamp, clip, humanise, loreSystem, moderateOut, nameOf, neighbours, numOr, opt, personaById, personaCard, pick, playerLabel,
  resolveFaction, rngFrom, safeProjection, shortId, str, titleCase, type Persona,
} from "../world/util.js";
import { questLog } from "./log.js";

type Objective = Omit<QuestObjective, "id">;

/** A rule-template candidate before it becomes a Quest. */
export interface QuestSeed {
  /** Dedupe key (one open quest per key). */
  key: string;
  /** Lower = preferred. */
  priority: number;
  origin: NonNullable<Quest["origin"]>;
  title: string;
  summary: string;
  objectives: Objective[];
  /** Reward scale 0.5-2.5. */
  weight: number;
  offer: string;
  tags?: string[];
}

/** Everything the templates look at (computed once per offer). */
export interface OfferContext {
  world: string;
  player: string;
  label: string;
  zone: string;
  giver: Persona | undefined;
  moments: Moment[];
  rumours: Rumour[];
  traits: [string, number][];
  killedTypes: string[];
  enemyTypes: string[];
  items: string[];
  visited: Set<string>;
  talked: Set<string>;
  relationships: { a: string; b: string; kind: string; strength: number }[];
  openKeys: Set<string>;
}

const keyTag = (k: string) => `key:${k}`;

/** Allowed quest givers (manifest quests.givers, else every persona). */
export function allowedGivers(m: ModuleContext["manifest"]): Persona[] {
  const g = m.quests.givers;
  return g?.length ? m.personas.filter((p) => g.includes(p.id)) : m.personas;
}

function pickGiver(ctx: ScopedContext, zone: string, requested: string | undefined, seed: string): { giver?: Persona; error?: string } {
  const m = ctx.manifest;
  const allowed = allowedGivers(m);
  if (requested) {
    const p = personaById(m, requested);
    if (!p) return { error: `unknown giver "${requested}"` };
    if (!allowed.includes(p)) return { error: `${p.name} does not give quests (manifest quests.givers)` };
    return { giver: p };
  }
  const near = allowed.filter((p) => p.zone && p.zone === zone);
  return { giver: pick(near.length ? near : allowed, rngFrom(seed)) };
}

export function buildOfferContext(ctx: ScopedContext, player: string, giverId?: string, zoneHint?: string): OfferContext & { error?: string } {
  const m = ctx.manifest;
  const now = ctx.now();
  const env = makeDslEnv(ctx, ctx.world, player);
  const zone = zoneHint ?? env.zone();
  const evs: StoredEvent[] = ctx.events({ world: ctx.world, player, since: now - 2 * 3_600_000, limit: 3000, desc: true });
  const moments = evs
    .filter((e) => e.type === "lf.observer.moment" && now - e.ts < 15 * 60_000)
    .map((e) => e.data.moment as Moment)
    .filter((x) => x?.kind);
  const counts = new Map<string, number>();
  const enemy = new Set<string>();
  const items = new Set<string>();
  const visited = new Set<string>();
  const talked = new Set<string>();
  for (const e of evs) {
    const d = e.data;
    if (e.type === "combat.killed") {
      const t = str(d.target_type) || str(d.target);
      if (t && !personaById(m, t)) counts.set(t, (counts.get(t) ?? 0) + 1);
      if (t) enemy.add(t);
    } else if (e.type === "combat.hurt" && (str(d.source_type) || str(d.source))) enemy.add(str(d.source_type) || str(d.source));
    else if (e.type === "movement.entered_zone" && d.zone) visited.add(str(d.zone));
    else if (e.type === "social.talked_to" && d.npc) talked.add(str(d.npc));
    if ((e.type === "economy.bought" || e.type === "gear.equipped") && d.item) items.add(str(d.item));
  }
  const model = env.model;
  const traits = Object.keys(model.traits ?? {})
    .map((k) => [k, numOr(env.call("trait", [k]), 0)] as [string, number])
    .filter(([, v]) => v >= 0.3)
    .sort((a, b) => b[1] - a[1]);
  const rumourState = safeProjection<{ rumours?: Rumour[] }>(ctx, "world.rumours", { world: ctx.world });
  const rumours = (rumourState?.rumours ?? []).filter((r) => r.about?.player === player && r.heat >= 0.25).sort((a, b) => b.heat - a.heat);
  const relationships = safeProjection<{ relationships?: OfferContext["relationships"] }>(ctx, "world.factions", { world: ctx.world })?.relationships ?? m.relationships;
  const log = questLog(ctx, ctx.world, player);
  const openKeys = new Set<string>();
  for (const q of [...log.offered, ...log.active.map((a) => a.quest)]) for (const t of q.tags ?? []) if (t.startsWith("key:")) openKeys.add(t.slice(4));
  const g = pickGiver(ctx, zone, giverId, `${player}:${log.completed.length}:${log.offered.length}`);
  return {
    world: ctx.world, player, label: playerLabel(ctx, ctx.world, player), zone, giver: g.giver, error: g.error,
    moments, rumours, traits,
    killedTypes: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k),
    enemyTypes: [...enemy], items: [...items], visited, talked, relationships, openKeys,
  };
}

// ------------------------------------------------------------------ templates

const OFFER_LINES = {
  moment: ["I heard what happened. There's more to it, and I need someone who's already in the thick of it.", "After what you just pulled off, I have a job that suits you."],
  rumour: ["People are talking about you. Want to do something about it?", "Gossip travels fast here. Let's get ahead of it."],
  world: ["There's a matter I can't handle myself.", "I could use a favour, and you look capable."],
  designer: ["I have work, if you want it.", "Got a moment? Something needs doing."],
} as const;

function momentSeeds(o: OfferContext, m: ModuleContext["manifest"]): QuestSeed[] {
  const out: QuestSeed[] = [];
  for (const mo of o.moments.slice(0, 5)) {
    const d = mo.data ?? {};
    const origin = { kind: "moment" as const, ref: mo.id };
    switch (mo.kind) {
      case "first_kill_of_type": {
        const t = str(d.type) || str(d.target_type) || o.killedTypes[0];
        if (t) out.push({ key: `hunt:${t}`, priority: 1, origin, title: `Hunt the ${titleCase(t)}`, summary: `You've had your first taste of ${humanise(t)}. Thin their numbers before they regroup.`, objectives: [{ type: "kill", target: t, count: 5, description: `Defeat 5 ${humanise(t)}` }], weight: 1, offer: `First ${humanise(t)} down. There are plenty more, and they're getting bold.` });
        break;
      }
      case "near_death_escape": {
        const src = str(d.source) || str(d.killer) || o.enemyTypes[0];
        const boss = m.bosses.find((b) => b.id === src);
        if (boss) out.push({ key: `rematch:${boss.id}`, priority: 0, origin, title: "Unfinished Business", summary: `${boss.name} nearly had you. Go back and finish it.`, objectives: [{ type: "defeat_boss", target: boss.id, count: 1, description: `Defeat ${boss.name}` }], weight: 2, offer: `You walked away from ${boss.name} with your life. Most don't. Will you go back?` });
        else if (src) out.push({ key: `rematch:${src}`, priority: 0, origin, title: "Unfinished Business", summary: `A ${humanise(src)} nearly ended you. Return the favour.`, objectives: [{ type: "kill", target: src, count: 3, description: `Defeat 3 ${humanise(src)}` }], weight: 1.4, offer: `That ${humanise(src)} almost had you. Don't let it think it won.` });
        break;
      }
      case "flawless_phase": {
        const b = m.bosses.find((x) => x.id === str(d.boss)) ?? m.bosses[0];
        if (b) out.push({ key: `finish:${b.id}`, priority: 0, origin, title: "Finish the Job", summary: `You made ${b.name} look clumsy. Now bring it down for good.`, objectives: [{ type: "defeat_boss", target: b.id, count: 1, description: `Defeat ${b.name}` }], weight: 2.2, offer: `Not a scratch on you against ${b.name}. Finish it.` });
        break;
      }
      case "comeback": {
        const z = o.zone || m.zones[0]?.id;
        if (z) out.push({ key: `hold:${z}`, priority: 2, origin, title: "Hold the Line", summary: `You turned that fight around. ${nameOf(m, z)} needs someone who doesn't quit.`, objectives: [{ type: "survive", target: z, count: 1, description: `Survive the next assault in ${nameOf(m, z)}` }], weight: 1.2, offer: "You don't give up. Good. I need exactly that." });
        break;
      }
      case "betrayal":
      case "broken_promise": {
        const npc = str(d.npc);
        if (personaById(m, npc)) out.push({ key: `amends:${npc}`, priority: 1, origin, title: "Make Amends", summary: `${nameOf(m, npc)} hasn't forgotten. Talk to them and set it right.`, objectives: [{ type: "talk", target: npc, count: 1, description: `Talk to ${nameOf(m, npc)}` }], weight: 0.8, offer: `${nameOf(m, npc)} is hurt. Words might fix it. Might.` });
        break;
      }
      case "absurd_purchase": {
        const who = m.personas.find((p) => p.likes.some((l) => /shiny|gold|treasure|coin/i.test(l))) ?? m.personas[0];
        if (who) out.push({ key: `showoff:${who.id}`, priority: 3, origin, title: "Show It Off", summary: `You bought ${d.item ? humanise(str(d.item)) : "something extravagant"}. ${who.name} will want to see it.`, objectives: [{ type: "talk", target: who.id, count: 1, description: `Show your purchase to ${who.name}` }], weight: 0.6, offer: "Spent a fortune, did you? Someone I know would love a look." });
        break;
      }
    }
  }
  return out;
}

function rumourSeeds(o: OfferContext, m: ModuleContext["manifest"]): QuestSeed[] {
  const r = o.rumours[0];
  if (!r) return [];
  const source = r.origin.npc ?? r.knownBy[0];
  if (!source || !personaById(m, source)) return [];
  return [{
    key: `rumour:${r.id}`, priority: 1, origin: { kind: "rumour", ref: r.id }, title: "Set the Record Straight",
    summary: clip(`People are saying "${r.content}" Find out where it started.`, 400),
    objectives: [{ type: "talk", target: source, count: 1, description: `Ask ${nameOf(m, source)} where the story came from` }],
    weight: 0.8, offer: `Have you heard what they're saying about you? ${nameOf(m, source)} was the first I heard it from.`,
  }];
}

function worldSeeds(o: OfferContext, m: ModuleContext["manifest"], rep: (f: string) => number): QuestSeed[] {
  const out: QuestSeed[] = [];
  const g = o.giver;
  if (g) {
    const rival = o.relationships.find((r) => (r.a === g.id || r.b === g.id) && (r.kind === "rival" || r.kind === "enemy"));
    if (rival) {
      const other = rival.a === g.id ? rival.b : rival.a;
      if (personaById(m, other)) out.push({ key: `rival:${g.id}:${other}`, priority: 2, origin: { kind: "npc", ref: g.id }, title: `A Word About ${nameOf(m, other)}`, summary: `${g.name} wants to know what ${nameOf(m, other)} is up to.`, objectives: [{ type: "talk", target: other, count: 1, description: `Find out what ${nameOf(m, other)} is planning` }], weight: 1, offer: `Keep an eye on ${nameOf(m, other)} for me. Ask around, casual-like.` });
    }
  }
  for (const f of m.factions) {
    if (rep(f.id) > -0.3) continue;
    const member = m.personas.find((p) => p.faction === f.id);
    if (member) {
      out.push({ key: `mend:${f.id}`, priority: 2, origin: { kind: "world", ref: f.id }, title: `Mend Fences with ${f.name}`, summary: `${f.name} think poorly of you. A gesture to ${member.name} could help.`, objectives: [{ type: "deliver", target: member.id, count: 1, description: `Bring a peace offering to ${member.name}` }], weight: 0.9, offer: `${f.name} won't deal with you as things stand. A gift to ${member.name} would go a long way.`, tags: [`faction:${f.id}`] });
      break;
    }
  }
  return out;
}

function traitSeeds(o: OfferContext, m: ModuleContext["manifest"], r: () => number): QuestSeed[] {
  const out: QuestSeed[] = [];
  const unvisited = m.zones.filter((z) => !o.visited.has(z.id) && z.id !== o.zone);
  const strangers = m.personas.filter((p) => !o.talked.has(p.id) && p.id !== o.giver?.id);
  const top = o.traits[0]?.[0];
  const world = { kind: "world" as const };
  const explore = () => {
    const z = pick(unvisited.length ? unvisited : m.zones.filter((x) => neighbours(m, o.zone).includes(x.id)), r);
    if (z) out.push({ key: `explore:${z.id}`, priority: top === "explorer" ? 2 : 5, origin: world, title: "Off the Map", summary: `Nobody's been to ${z.name} in a while. See what's there.`, objectives: [{ type: "explore", target: z.id, count: 1, description: `Explore ${z.name}` }], weight: 0.8, offer: `You like poking around. Try ${z.name}.` });
  };
  const fight = () => {
    const t = o.killedTypes[0] ?? o.enemyTypes[0];
    if (t) out.push({ key: `prove:${t}`, priority: ["berserker", "murderer", "glass_cannon", "dodger"].includes(top ?? "") ? 2 : 5, origin: world, title: "Prove It", summary: `You fight like you mean it. Prove it against the ${humanise(t)}.`, objectives: [{ type: "kill", target: t, count: 8, description: `Defeat 8 ${humanise(t)}` }], weight: 1.2, offer: "All that fury. Let's point it somewhere useful." });
  };
  const social = () => {
    const p = pick(strangers, r);
    if (p) out.push({ key: `meet:${p.id}`, priority: ["chatterbox", "pacifist", "beloved"].includes(top ?? "") ? 2 : 6, origin: world, title: "A New Acquaintance", summary: `You haven't met ${p.name} yet. You should.`, objectives: [{ type: "talk", target: p.id, count: 1, description: `Talk to ${p.name}` }], weight: 0.5, offer: `You get on with people. ${p.name} could use a friendly face.` });
  };
  const forge = () => {
    const fam = pick(m.items?.families ?? [], r);
    if (fam) out.push({ key: `forge:${fam}`, priority: 4, origin: world, title: `Forge a ${titleCase(fam)}`, summary: `Make a ${humanise(fam)} worth talking about.`, objectives: [{ type: "forge", target: fam, count: 1, description: `Forge a ${humanise(fam)}` }], weight: 0.9, offer: `I want to see what you can make. A ${humanise(fam)}, say.` });
  };
  const charity = () => {
    const p = pick(m.personas.filter((x) => x.id !== o.giver?.id), r);
    if (p) out.push({ key: `charity:${p.id}`, priority: ["rich", "big_spender", "hoarder"].includes(top ?? "") ? 2 : 7, origin: world, title: "Spread the Wealth", summary: `Your purse is heavy. ${p.name} could use some of it.`, objectives: [{ type: "deliver", target: p.id, count: 1, description: `Give something of value to ${p.name}` }], weight: 0.7, offer: `You've got more than you need. ${p.name} hasn't.` });
  };
  explore();
  fight();
  social();
  forge();
  charity();
  return out;
}

/** Valid targets per objective type (clamps LLM output). Unknown custom types accept the union. */
export function validTargets(o: OfferContext, m: ModuleContext["manifest"]): Record<string, Set<string>> {
  const npcs = new Set(m.personas.map((p) => p.id));
  const zones = new Set(m.zones.map((z) => z.id));
  const bosses = new Set(m.bosses.map((b) => b.id));
  const enemies = new Set([...o.enemyTypes, ...o.killedTypes, ...bosses]);
  const items = new Set([...(m.items?.families ?? []), ...o.items, "any"]);
  const all = new Set([...npcs, ...zones, ...enemies, ...items]);
  return { kill: enemies, talk: npcs, deliver: npcs, escort: npcs, explore: new Set([...zones, "any"]), survive: new Set([...zones, "any"]), defeat_boss: bosses, fetch: items, forge: items, "*": all };
}

/** Rewards inside the manifest reward types and budgets. */
export function rewardsFor(m: ModuleContext["manifest"], weight: number, giver: Persona | undefined, r: () => number): QuestReward[] {
  const types = m.quests.rewardTypes;
  const caps = m.quests.rewards;
  const out: QuestReward[] = [];
  const w = clamp(weight, 0.3, 2.5);
  if (types.includes("gold")) out.push({ type: "gold", amount: Math.max(5, Math.round((caps.goldMax * 0.15 * w * (0.9 + r() * 0.2)) / 5) * 5) });
  if (types.includes("xp")) out.push({ type: "xp", amount: Math.max(10, Math.round(caps.xpMax * 0.1 * w)) });
  const faction = giver?.faction;
  if (types.includes("reputation") && faction) out.push({ type: "reputation", id: faction, amount: Math.round(clamp(0.05 * w, 0.05, 0.25) * 100) / 100, description: `Standing with ${faction}` });
  if (types.includes("item") && w >= 1.4) out.push({ type: "item", id: "forge.loot", description: "Something forged for the occasion" });
  if (types.includes("title") && w >= 2) out.push({ type: "title", id: "the_bold", description: "Title: the Bold" });
  if (!out.length && types[0]) out.push({ type: types[0], description: "A reward" });
  return out.slice(0, 4);
}

/** Pick the best open seed and turn it into a Quest (null when nothing fits the schema). */
export function composeQuest(ctx: ScopedContext, o: OfferContext, seed?: number): { quest: Quest | null; why: string } {
  const m = ctx.manifest;
  const r = rngFrom(`${o.player}:${seed ?? Math.floor(ctx.now() / 60_000)}`);
  const rep = (f: string) => {
    const v = safeProjection<{ reputation?: Record<string, Record<string, number>> }>(ctx, "world.factions", { world: o.world })?.reputation?.[f]?.[o.player];
    return typeof v === "number" ? v : m.factions.find((x) => x.id === f)?.attitude ?? 0;
  };
  const allowed = new Set(m.quests.objectiveTypes);
  const seeds = [...momentSeeds(o, m), ...rumourSeeds(o, m), ...worldSeeds(o, m, rep), ...traitSeeds(o, m, r)]
    .filter((s) => !o.openKeys.has(s.key))
    .filter((s) => s.objectives.length && s.objectives.every((x) => allowed.has(x.type) && x.target));
  if (!seeds.length) return { quest: null, why: "no quest template fits the manifest quest schema right now" };
  const best = Math.min(...seeds.map((s) => s.priority));
  const s = pick(seeds.filter((x) => x.priority === best), r)!;
  const objectives: QuestObjective[] = s.objectives.slice(0, m.quests.maxObjectives).map((x, i) => ({
    id: `o${i + 1}`, type: x.type, target: x.target.slice(0, 64), ...(x.count ? { count: Math.max(1, Math.round(x.count)) } : {}), description: clip(x.description, 200),
  }));
  const giver = o.giver;
  const quest: Quest = {
    id: shortId("q", `${o.world}:${o.player}:${s.key}:${ctx.now()}`),
    title: clip(s.title, 80),
    summary: clip(s.summary, 400),
    ...(giver ? { giver: giver.id } : {}),
    objectives,
    rewards: rewardsFor(m, s.weight, giver, r),
    dialogue: {
      offer: clip(s.offer, 400),
      accept: pick(["Good. Don't dawdle.", "I knew I could count on you.", "Off you go, then."], r),
      complete: pick(["Well done. I won't forget it.", "That's that, then. Thank you.", "Better than I hoped."], r),
    },
    expiresInSec: Math.max(60, opt(ctx, "questExpirySec", 1800)),
    origin: s.origin,
    tags: [keyTag(s.key), ...(s.tags ?? [])],
  };
  return { quest, why: `${s.origin.kind} template "${s.key}"${giver ? ` from ${giver.name}` : ""}` };
}

/** Instant quest offer (records lf.quests.offered). */
export function offerInstant(ctx: AskContext | ScopedContext, player: string, params: { giver?: string; zone?: string; seed?: number }): { quest: Quest | null; why: string; ctx?: OfferContext } {
  const m = ctx.manifest;
  const log = questLog(ctx, ctx.world, player);
  if (log.active.length >= m.quests.maxActive) return { quest: null, why: `already ${log.active.length} active quests (max ${m.quests.maxActive})` };
  const o = buildOfferContext(ctx, player, params.giver, params.zone);
  if (o.error) return { quest: null, why: o.error };
  const { quest, why } = composeQuest(ctx, o, params.seed);
  if (quest) ctx.record("lf.quests.offered", { quest, source: "rules" }, { player });
  return { quest, why, ctx: o };
}

// ------------------------------------------------------------------ LLM upgrade (rich tier)

const QUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    objectives: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { type: { type: "string" }, target: { type: "string" }, count: { type: "integer" }, description: { type: "string" } },
        required: ["type", "target", "count", "description"],
      },
    },
    rewards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { type: { type: "string" }, id: { type: "string" }, amount: { type: "number" }, description: { type: "string" } },
        required: ["type", "id", "amount", "description"],
      },
    },
    dialogue: {
      type: "object",
      additionalProperties: false,
      properties: { offer: { type: "string" }, accept: { type: "string" }, complete: { type: "string" } },
      required: ["offer", "accept", "complete"],
    },
  },
  required: ["title", "summary", "objectives", "rewards", "dialogue"],
};

interface RawQuest {
  title?: unknown;
  summary?: unknown;
  objectives?: { type?: unknown; target?: unknown; count?: unknown; description?: unknown }[];
  rewards?: { type?: unknown; id?: unknown; amount?: unknown; description?: unknown }[];
  dialogue?: { offer?: unknown; accept?: unknown; complete?: unknown };
}

/** Clamp an untrusted LLM quest back into the schema, keeping id / giver / origin / expiry from the instant quest. */
export async function clampQuest(ctx: ScopedContext, raw: RawQuest, base: Quest, targets: Record<string, Set<string>>): Promise<Quest | null> {
  const m = ctx.manifest;
  const allowed = new Set(m.quests.objectiveTypes);
  const objectives: QuestObjective[] = [];
  for (const [i, x] of (Array.isArray(raw.objectives) ? raw.objectives : []).entries()) {
    if (objectives.length >= m.quests.maxObjectives) break;
    const type = str(x?.type);
    let target = str(x?.target);
    if (!allowed.has(type)) continue;
    const valid = targets[type] ?? targets["*"];
    if (!valid.has(target)) {
      const fb = base.objectives[i] ?? base.objectives.find((b) => b.type === type);
      if (!fb || fb.type !== type) continue;
      target = fb.target;
    }
    const description = (await moderateOut(ctx, x?.description, 200)) || `${titleCase(type)} ${nameOf(m, target)}`;
    objectives.push({ id: `o${objectives.length + 1}`, type, target, count: Math.round(clamp(numOr(x?.count, 1), 1, 20)), description });
  }
  if (!objectives.length) return null;
  const rewardTypes = new Set(m.quests.rewardTypes);
  const caps = m.quests.rewards;
  const rewards: QuestReward[] = [];
  for (const x of Array.isArray(raw.rewards) ? raw.rewards : []) {
    if (rewards.length >= 4) break;
    const type = str(x?.type);
    if (!rewardTypes.has(type) || rewards.some((r) => r.type === type)) continue;
    const description = await moderateOut(ctx, x?.description, 120);
    const amount = numOr(x?.amount, 0);
    if (type === "gold") rewards.push({ type, amount: Math.round(clamp(amount, 1, caps.goldMax)), ...(description ? { description } : {}) });
    else if (type === "xp") rewards.push({ type, amount: Math.round(clamp(amount, 1, caps.xpMax)), ...(description ? { description } : {}) });
    else if (type === "reputation") {
      const f = resolveFaction(m, x?.id) ?? personaById(m, base.giver)?.faction;
      if (f) rewards.push({ type, id: f, amount: Math.round(clamp(amount, 0.01, 0.3) * 100) / 100, ...(description ? { description } : {}) });
    } else {
      const id = cleanText(x?.id, 64).replace(/[^A-Za-z0-9_\-.:]/g, "_");
      rewards.push({ type, ...(id ? { id } : {}), ...(description ? { description } : {}) });
    }
  }
  const title = (await moderateOut(ctx, raw.title, 80)) || base.title;
  const summary = (await moderateOut(ctx, raw.summary, 400)) || base.summary;
  const dl = raw.dialogue ?? {};
  return {
    ...base,
    title,
    summary,
    objectives,
    rewards: rewards.length ? rewards : base.rewards,
    dialogue: {
      offer: (await moderateOut(ctx, dl.offer, 400)) || base.dialogue?.offer,
      accept: (await moderateOut(ctx, dl.accept, 300)) || base.dialogue?.accept,
      complete: (await moderateOut(ctx, dl.complete, 300)) || base.dialogue?.complete,
    },
  };
}

/** Rich-tier rewrite of the instant quest with giver dialogue. Returns null to keep the instant quest. */
export async function offerUpgrade(ctx: AskContext, base: Quest | null, params: { giver?: string; zone?: string }): Promise<{ quest: Quest; why: string } | null> {
  if (!base || !ctx.llm || !ctx.player) return null;
  const m = ctx.manifest;
  const o = buildOfferContext(ctx, ctx.player, base.giver ?? params.giver, params.zone);
  const targets = validTargets(o, m);
  const giver = personaById(m, base.giver);
  const profile = safeProjection<{ profile?: { text?: string } | null }>(ctx, "observer.player_model", { world: ctx.world, player: ctx.player })?.profile?.text;
  const list = (s: Set<string>) => [...s].slice(0, 30).join(", ") || "(none)";
  const user = [
    giver ? `QUEST GIVER:\n${personaCard(giver)}` : "QUEST GIVER: none (notice board)",
    `PLAYER: ${o.label}${profile ? ` — ${profile}` : ""}`,
    `TOP TRAITS: ${o.traits.slice(0, 5).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ") || "unknown"}`,
    o.moments.length ? `RECENT MOMENTS: ${o.moments.slice(0, 3).map((x) => `${x.kind}${x.evidence?.[0] ? ` (${x.evidence[0]})` : ""}`).join("; ")}` : "",
    o.rumours.length ? `RUMOURS ABOUT THE PLAYER: ${o.rumours.slice(0, 2).map((x) => `"${x.content}"`).join(" ")}` : "",
    `DRAFT QUEST (keep its intent, make it vivid and specific):\n${JSON.stringify({ title: base.title, summary: base.summary, objectives: base.objectives, rewards: base.rewards })}`,
    `RULES: objective types only from [${m.quests.objectiveTypes.join(", ")}]; at most ${m.quests.maxObjectives} objectives; targets must come from these lists — npcs: ${list(targets.talk)}; zones: ${list(targets.explore)}; enemies: ${list(targets.kill)}; bosses: ${list(targets.defeat_boss)}; items: ${list(targets.fetch)}.`,
    `REWARDS: types only from [${m.quests.rewardTypes.join(", ")}]; gold <= ${m.quests.rewards.goldMax}; xp <= ${m.quests.rewards.xpMax}; reputation amount 0.01-0.3 with id = a faction id. Use "" / 0 for unused id / amount.`,
    `DIALOGUE: offer (<= 300 chars), accept and complete lines (<= 200 chars each) in the giver's voice.`,
  ].filter(Boolean).join("\n\n");
  const res = await ctx.llm.json<RawQuest>(QUEST_SCHEMA, loreSystem(m, "You design short, reactive side quests that fit the game's quest schema exactly."), user, {
    tier: "rich", maxTokens: 900, task: "quest.offer", player: ctx.player, signal: ctx.signal,
  });
  const quest = await clampQuest(ctx, res.value, base, targets);
  if (!quest) return null;
  ctx.record("lf.quests.offered", { quest, source: "ai" }, { player: ctx.player });
  return { quest, why: `AI quest from ${giver?.name ?? "the board"} (${base.origin?.kind ?? "world"})` };
}

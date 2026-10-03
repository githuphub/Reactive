// Reaction rules (manifest `reactions`): `when: <DSL over the player model>` -> `then: <directive template>`, with
// per-player cooldowns, once/repeat, and optional LLM flavour (a persona bark, or a named NPC with a bark + plan).
// Evaluated continuously (signals, throttled) and on a tick; `world.reactions` lists what is active right now.
import { isKnownDirectiveKind, type LooseDirectiveDraft } from "@liveforge/protocol";
import type { ModuleContext, ScopedContext } from "../../module.js";
import { evalWith, makeDslEnv, type HostDslEnv } from "./dsl.js";
import { clip, fillTemplate, loreSystem, moderateOut, nameOf, personaById, personaCard, playerLabel, str, type Reaction } from "./util.js";
import { reputationOf, standingFor } from "./factions.js";

/** One firing, kept in kv per player for `world.reactions` (active = still inside its cooldown window). */
export interface FiredReaction {
  rule: string;
  ts: number;
  until: number;
  draft: LooseDirectiveDraft;
  directiveId: string | null;
}

const FIRED_MAX = 20;
const firedKey = (world: string, player: string) => `fired:${world}:${player}`;
const cdKey = (world: string, player: string, rule: string) => `cd:${world}:${player}:${rule}`;
const edgeKey = (world: string, player: string, rule: string) => `edge:${world}:${player}:${rule}`;
const onceKey = (world: string, player: string, rule: string) => `once:${world}:${player}:${rule}`;

const warned = new Set<string>();

/** Template variables for `then`: {{player}}, {{name}}, {{zone}}, {{rule}}, {{gold}}, {{trait.X}}, {{stat.X}}, {{rep.F}}. */
function vars(ctx: ScopedContext, env: HostDslEnv, player: string, rule: Reaction): (k: string) => unknown {
  return (k) => {
    if (k === "player") return player;
    if (k === "name") return playerLabel(ctx, ctx.world, player);
    if (k === "zone") return env.zone();
    if (k === "rule") return rule.id;
    if (k === "gold") return env.call("stat", ["gold"]);
    if (k.startsWith("trait.")) return env.call("trait", [k.slice(6)]);
    if (k.startsWith("stat.")) return env.call("stat", [k.slice(5)]);
    if (k.startsWith("rep.")) return env.call("rep", [k.slice(4)]);
    return undefined;
  };
}

/** The directive a rule produces for this player (unknown kinds are wrapped as `world.reaction`). */
export function buildDraft(ctx: ScopedContext, env: HostDslEnv, player: string, rule: Reaction): LooseDirectiveDraft {
  const filled = fillTemplate({ target: rule.then.target, args: rule.then.args }, vars(ctx, env, player, rule)) as { target: string; args: Record<string, unknown> };
  const why = clip(rule.description || `${rule.id}: ${rule.when}`, 200);
  const kind = rule.then.kind;
  if (isKnownDirectiveKind(kind) || kind.startsWith("custom.")) return { kind, target: String(filled.target).slice(0, 96), args: filled.args ?? {}, why };
  return { kind: "world.reaction", target: String(filled.target).slice(0, 96), args: { rule: rule.id, effect: kind, data: filled.args ?? {} }, why };
}

export interface EvalOptions {
  /** Emit directives for rules that pass (respecting cooldown / once). false = just report. */
  fire: boolean;
  /** Reuse an env (one evaluation pass). */
  env?: HostDslEnv;
}

/** Evaluate every manifest reaction for one player. Returns the rules whose condition is currently true. */
export function evaluateReactions(ctx: ScopedContext, player: string, o: EvalOptions): { rule: Reaction; draft: LooseDirectiveDraft; fired: boolean }[] {
  const m = ctx.manifest;
  if (!m.reactions.length) return [];
  const env = o.env ?? makeDslEnv(ctx, ctx.world, player);
  const now = ctx.now();
  const out: { rule: Reaction; draft: LooseDirectiveDraft; fired: boolean }[] = [];
  for (const rule of m.reactions) {
    const res = evalWith(env, rule.when);
    if (res.error) {
      const wk = `${ctx.game}:${rule.id}:${res.error}`;
      if (!warned.has(wk)) {
        warned.add(wk);
        ctx.log.warn("reaction condition error", { rule: rule.id, when: rule.when, error: res.error });
      }
    }
    const edge = rule.cooldown === 0;
    if (edge) {
      const prev = ctx.kv.get<boolean>(edgeKey(ctx.world, player, rule.id)) ?? false;
      if (prev !== res.ok && o.fire) ctx.kv.set(edgeKey(ctx.world, player, rule.id), res.ok);
      if (!res.ok) continue;
      const draft = buildDraft(ctx, env, player, rule);
      const fired = o.fire && !prev && fire(ctx, env, player, rule, draft, now);
      out.push({ rule, draft, fired });
      continue;
    }
    if (!res.ok) continue;
    const draft = buildDraft(ctx, env, player, rule);
    let fired = false;
    if (o.fire) {
      const last = ctx.kv.get<number>(cdKey(ctx.world, player, rule.id)) ?? 0;
      const doneOnce = rule.once && ctx.kv.get<boolean>(onceKey(ctx.world, player, rule.id));
      if (!doneOnce && now - last >= rule.cooldown * 1000) fired = fire(ctx, env, player, rule, draft, now);
    }
    out.push({ rule, draft, fired });
  }
  return out;
}

function fire(ctx: ScopedContext, env: HostDslEnv, player: string, rule: Reaction, draft: LooseDirectiveDraft, now: number): boolean {
  ctx.kv.set(cdKey(ctx.world, player, rule.id), now);
  if (rule.once) ctx.kv.set(onceKey(ctx.world, player, rule.id), true);
  const d = ctx.emit(draft, { player });
  if (!d) return false;
  const list = ctx.kv.get<FiredReaction[]>(firedKey(ctx.world, player)) ?? [];
  list.push({ rule: rule.id, ts: now, until: now + Math.max(rule.cooldown, 120) * 1000, draft, directiveId: d.id });
  ctx.kv.set(firedKey(ctx.world, player), list.slice(-FIRED_MAX));
  ctx.record("lf.world.reaction", { rule: rule.id, kind: draft.kind, target: draft.target, directiveId: d.id, why: draft.why }, { player });
  if (rule.flavour) void flavour(ctx, env, player, rule, draft).catch((e) => ctx.log.debug("reaction flavour skipped", { rule: rule.id, error: (e as Error).message }));
  return true;
}

/** Reactions fired for this player whose window is still open (newest first). */
export function activeReactions(ctx: Pick<ModuleContext, "kv" | "now">, world: string, player: string): FiredReaction[] {
  const now = ctx.now();
  return (ctx.kv.get<FiredReaction[]>(firedKey(world, player)) ?? []).filter((f) => f.until > now).reverse();
}

/** Built-in standing reactions from reputation (guards keep distance / turn hostile, honoured discounts). */
export function standingDrafts(ctx: ScopedContext, player: string): LooseDirectiveDraft[] {
  const out: LooseDirectiveDraft[] = [];
  for (const f of ctx.manifest.factions) {
    const rep = reputationOf(ctx, ctx.world, player, f.id);
    const s = standingFor(rep);
    if (s === "neutral") continue;
    out.push({
      kind: "world.reaction", target: "world",
      args: { rule: "standing", effect: s, data: { faction: f.id, reputation: rep } },
      why: `${f.name} reputation ${rep.toFixed(2)} -> ${s}`,
    });
  }
  return out;
}

// ------------------------------------------------------------------ LLM flavour (optional upgrade)

const FLAVOUR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    npcName: { type: "string", description: "Name of the NPC carrying out the reaction (keep the given name if one is provided)." },
    bark: { type: "string", description: "One spoken line the NPC says to or about the player, max 160 characters." },
    plan: { type: "string", description: "What the NPC intends to do next, one sentence, max 200 characters." },
  },
  required: ["npcName", "bark", "plan"],
};

interface Flavour {
  name: string;
  bark: string;
  plan: string;
}

/**
 * Flavour a fired reaction: cached by (rule, target, zone, top trait) so repeats are instant; else one fast-tier
 * LLM call (budget-checked). Emits an `npc.bark` for persona targets, otherwise a `world.reaction` "flavour" with a
 * named NPC, bark and plan. Without an LLM nothing extra happens: the rules directive already fired.
 */
async function flavour(ctx: ScopedContext, env: HostDslEnv, player: string, rule: Reaction, draft: LooseDirectiveDraft): Promise<void> {
  const m = ctx.manifest;
  const npcId = draft.target.startsWith("npc:") ? draft.target.slice(4) : str((draft.args as Record<string, unknown>).npc);
  const persona = personaById(m, npcId);
  const traits = Object.keys(env.model.traits ?? {}).map((k) => [k, Number(env.call("trait", [k])) || 0] as const).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const zone = env.zone();
  const key = ctx.cache.key("world.flavour", { rule: rule.id, target: draft.target, zone, trait: traits[0]?.[0] ?? "" });
  let f = ctx.cache.get<Flavour>(key) ?? null;
  if (!f) {
    if (!ctx.llm || !ctx.budgets.check(player).ok) return;
    const res = await ctx.llm.json<{ npcName?: unknown; bark?: unknown; plan?: unknown }>(
      FLAVOUR_SCHEMA,
      loreSystem(m, "You give world reactions a face: an NPC who acts on them, one line of dialogue and a short plan. Stay in-world and in tone."),
      [
        `Reaction rule "${rule.id}": ${rule.description ?? rule.when}`,
        `Directive: ${draft.kind} -> ${draft.target} ${JSON.stringify(draft.args).slice(0, 300)}`,
        persona ? `The NPC is fixed:\n${personaCard(persona)}` : `Invent a fitting named NPC (not one of: ${m.personas.map((p) => p.name).join(", ") || "none"}).`,
        `Player: ${playerLabel(ctx, ctx.world, player)}; zone: ${zone ? nameOf(m, zone) : "unknown"}; traits: ${traits.map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ") || "unknown"}.`,
      ].join("\n"),
      { tier: "fast", maxTokens: 250, task: "world.reaction", player },
    );
    const bark = await moderateOut(ctx, res.value.bark, 160);
    if (!bark) return;
    f = {
      name: persona?.name ?? ((await moderateOut(ctx, res.value.npcName, 48)) || "A stranger"),
      bark,
      plan: await moderateOut(ctx, res.value.plan, 200),
    };
    ctx.cache.set(key, f, { ttlSec: 600, kind: "world.flavour" });
  }
  ctx.record("lf.world.reaction_flavour", { rule: rule.id, name: f.name, bark: f.bark, plan: f.plan }, { player });
  if (persona) {
    ctx.emit({ kind: "npc.bark", target: `npc:${persona.id}`, args: { npc: persona.id, text: f.bark, ...(persona.voice ? { voice: persona.voice } : {}) }, why: clip(`${rule.id}: ${f.plan || "flavour"}`, 200) }, { player });
  } else {
    ctx.emit({ kind: "world.reaction", target: draft.target, args: { rule: rule.id, effect: "flavour", data: { name: f.name, bark: f.bark, plan: f.plan } }, why: clip(`${rule.id}: ${f.name} — ${f.plan}`, 200) }, { player });
  }
}

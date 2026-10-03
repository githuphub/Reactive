// The recipe toolkit: what a Reaction Library recipe is (RecipeDef) and what it can do while it runs (RecipeRun):
// pick speakers, respect cooldowns / chance / the `when` gate, say a line through the combination engine
// (fingerprint -> novelty-checked seeded variant -> facet weaving -> persona voice), push `custom.reaction` effects,
// start rumours, offer quests, move attitudes and reputation. Every emitted directive carries a `why` with the
// recipe and the fingerprint facets, and every firing is recorded as `lf.reactions.fired` (dashboard ledger).
import {
  hashString, type Directive, type LooseDirectiveDraft, type Quest, type QuestObjective, type ReactionInfo, type ReactionRecipeId, type StoredEvent,
} from "@liveforge/protocol";
import { moduleEnabled } from "@liveforge/manifest";
import type { ScopedContext } from "../../../module.js";
import { capFirst, facetId, fillLine, normaliseLine, pickVariant, voiceTic, weave, type Facet } from "../../../core/combination/index.js";
import { personaCard, voiceFor } from "../../persona/cards.js";
import { createRumour } from "../rumours.js";
import { changeReputation } from "../factions.js";
import { evalCondition } from "../dsl.js";
import { clip, nameOf, personaById, personasInZone, rngFrom, shortId, shuffle } from "../util.js";
import { questLog } from "../../quests/log.js";
import { rewardsFor } from "../../quests/offer.js";
import { pList, pNum, pStr, type Params } from "./config.js";
import { buildSituation, type Situation } from "./facets.js";
import { LIB_EVENTS, ledgerOf, type LedgerState } from "./state.js";

/** A passive contribution to npc.bark (and to reply prompts): what this recipe would say to the player right now. */
export interface Offer {
  pool: string;
  vars?: Record<string, string | number | undefined>;
  /** Base priority 0-1 (combination weighting adds per matching facet). */
  base: number;
  emote?: string;
  /** Short reason for the why. */
  reason: string;
  extra?: Facet[];
}

export interface RecipeDef {
  id: ReactionRecipeId;
  /** Default seconds between reactions of this recipe from the same speaker (params.cooldownSec overrides). */
  cooldownSec: number;
  /** Facet kinds (or "kind:key") the recipe itself talks about: never woven in as an aside, and they score it up. */
  relevant: string[];
  /** Line pools (>= 6 variants each). Placeholders: {name} (address), {npc}, plus recipe vars. */
  pools: Record<string, string[]>;
  /** Event handlers by canonical type (internal claim / promise events arrive as social.claim / social.promise). */
  on?: Record<string, (run: RecipeRun, ev: StoredEvent) => void>;
  /** Runs every few seconds per active player. */
  tick?: (run: RecipeRun) => void;
  /** Passive bark contribution for npc.bark (speaker = npc). */
  offer?: (run: RecipeRun, npc: string, trigger: string) => Offer | null;
  /** A fact line for AI prompts about this player, from npc's point of view. */
  note?: (run: RecipeRun, npc: string) => string | null;
}

export interface SayOptions {
  vars?: Record<string, string | number | undefined>;
  extra?: Facet[];
  emote?: string;
  /** Effect pushed with the line as custom.reaction (payload.effect = effect). */
  effect?: { effect: string; payload?: Record<string, unknown>; target?: string };
  /** Short reason for the why ("3rd death", "crimson cloak"). */
  reason?: string;
  /** Skip the cooldown bookkeeping key (default recipe|speaker). */
  cooldownKey?: string;
  /** Do not emit (just return the text), e.g. for boss taunts folded into another directive. */
  silent?: boolean;
  /** Extra directives emitted with this reaction (ids land in the ledger). */
  also?: LooseDirectiveDraft[];
}

export interface Spoken {
  text: string;
  info: ReactionInfo;
  situation: Situation;
  directives: Directive[];
}

const BARK_CHANNEL = "bark";

export class RecipeRun {
  readonly world: string;
  readonly now: number;
  private _l: LedgerState | null = null;

  constructor(
    readonly def: RecipeDef,
    readonly ctx: ScopedContext,
    readonly player: string,
    readonly params: Params,
    readonly event?: StoredEvent,
  ) {
    this.world = ctx.world;
    this.now = ctx.now();
  }

  get id(): ReactionRecipeId { return this.def.id; }
  get m() { return this.ctx.manifest; }
  /** The player's ledger (live projection state). */
  get l(): LedgerState { return (this._l ??= ledgerOf(this.ctx, this.world, this.player)); }

  num(k: string, d: number): number { return pNum(this.params, k, d); }
  str(k: string, d = ""): string { return pStr(this.params, k, d); }
  list(k: string, d: string[] = []): string[] { return pList(this.params, k, d); }

  /** Persona id from a param when it names a declared persona. */
  persona(k: string): string | null {
    const v = this.str(k);
    return v && personaById(this.m, v) ? v : null;
  }

  cooldownSec(): number { return this.num("cooldownSec", this.def.cooldownSec); }

  /** True when `speaker` may react with this recipe again (cooldown per recipe x speaker x player). */
  ready(speaker: string, sec = this.cooldownSec(), key = `${this.id}|${speaker}`): boolean {
    const last = this.l.cooldowns[key] ?? 0;
    return this.now - last >= sec * 1000;
  }

  /** True when this recipe has not fired for this player (any speaker) within `sec` seconds. */
  readyAny(sec = this.cooldownSec()): boolean {
    return this.ready("*", sec);
  }

  /** Seeded coin flip against params.chance (deterministic per salt). */
  roll(salt: string, chance = this.num("chance", 1)): boolean {
    if (chance >= 1) return true;
    if (chance <= 0) return false;
    return rngFrom(`${this.id}:${this.player}:${salt}`)() < chance;
  }

  /** The params.when DSL gate (true when absent). */
  gate(): boolean {
    const w = this.str("when");
    if (!w) return true;
    return evalCondition(this.ctx, this.world, this.player, w).ok;
  }

  /** Personas not used as a boss voice. */
  private townsfolk(): string[] {
    const bossVoices = new Set(this.m.bosses.map((b) => b.persona).filter(Boolean));
    return this.m.personas.filter((p) => !bossVoices.has(p.id)).map((p) => p.id);
  }

  /**
   * Who may voice this reaction: params.speakers, else personas in the player's zone, else anyone in town (boss
   * voices excluded). `prefer` ids go first; order is seeded so different speakers take turns.
   */
  speakers(o: { prefer?: (string | null | undefined)[]; max?: number; salt?: string; anywhere?: boolean } = {}): string[] {
    const allowed = this.list("speakers").filter((id) => personaById(this.m, id));
    const town = this.townsfolk();
    let pool = allowed.length ? allowed : town;
    if (!allowed.length && !o.anywhere) {
      const zone = this.l.zone;
      const near = personasInZone(this.m, zone).map((p) => p.id).filter((id) => town.includes(id));
      if (near.length) pool = near;
    }
    const order = shuffle(pool, rngFrom(`${this.id}:${this.player}:${o.salt ?? ""}:${Math.floor(this.now / 60_000)}`));
    const prefer = (o.prefer ?? []).filter((x): x is string => !!x && personaById(this.m, x) !== undefined);
    const out = [...new Set([...prefer, ...order])];
    return out.slice(0, o.max ?? out.length);
  }

  /** Pool + AI variants (AI ones first: they were written for this recipe and voice). */
  private poolLines(pool: string, speaker: string): string[] {
    const base = this.def.pools[pool] ?? [];
    const ai = this.ctx.kv.get<string[]>(aiKey(this.id, pool, speaker)) ?? [];
    return [...ai, ...base];
  }

  /**
   * Compose a line for `speaker` from `pool` through the combination engine. Returns the text + reaction info; also
   * emits it (npc.bark for personas, boss.adapt taunt for bosses, custom.reaction for "world") unless silent.
   */
  say(speaker: string, pool: string, o: SayOptions = {}): Spoken | null {
    const lines = this.poolLines(pool, speaker);
    if (!lines.length) return null;
    const sit = buildSituation(this.ctx, this.world, this.player, speaker, this.l, o.extra);
    const vars = { name: sit.address, player: sit.label, npc: sit.speakerName, nick: this.l.nickname?.name, ...(o.vars ?? {}) };
    const filled = lines.map((t) => capFirst(fillLine(t, vars)));
    const count = this.l.counts[`${this.id}|${pool}|${speaker}|${sit.fingerprint}`] ?? 0;
    const recent = (this.l.ledger[speaker] ?? []).map((x) => x.line);
    const pick = pickVariant(filled, { fingerprint: sit.fingerprint, speaker, count, recent, salt: `${this.id}:${pool}` });
    if (!pick) return null;
    const seed = hashString(`${sit.fingerprint}|${speaker}|${count}|${this.id}`);
    const woven = weave(pick.text, sit.facets, { seed, skipKinds: this.def.relevant, richness: sit.facets.length });
    const persona = personaById(this.m, speaker);
    const voice = persona ?? personaById(this.m, this.m.bosses.find((b) => b.id === speaker)?.persona);
    const text = clip(voiceTic(woven.text, voice ? { personality: voice.personality, style: voice.voice.style } : undefined, seed), 280);
    const info: ReactionInfo = {
      recipe: this.id, fingerprint: sit.fingerprint,
      facets: sit.facets.slice(0, 12).map(facetId), sentence: sit.sentence, variant: pick.index,
    };
    const directives: Directive[] = [];
    if (!o.silent) {
      const why = whyOf(this.id, o.reason, sit.facets);
      if (persona) {
        const card = personaCard(this.m, speaker);
        const d = this.ctx.emit({ kind: "npc.bark", target: `npc:${speaker}`, args: { npc: speaker, text, ...(o.emote ? { emote: o.emote } : {}), voice: voiceFor(card), reaction: info }, why }, { player: this.player });
        if (d) directives.push(d);
      } else if (this.m.bosses.some((b) => b.id === speaker)) {
        const d = this.ctx.emit({ kind: "boss.adapt", target: `boss:${speaker}`, args: { boss: speaker, taunt: clip(text, 200) }, why }, { player: this.player });
        if (d) directives.push(d);
      }
      if (o.effect || !persona) {
        const eff = o.effect ?? { effect: "line" };
        const target = eff.target ?? (persona ? `npc:${speaker}` : speaker === "world" || !speaker ? "world" : `boss:${speaker}`);
        const d = this.ctx.emit({ kind: "custom.reaction", target, args: { recipe: this.id, target, payload: { effect: eff.effect, ...(eff.payload ?? {}) }, line: text, reaction: info }, why }, { player: this.player });
        if (d) directives.push(d);
      }
      for (const extra of o.also ?? []) {
        const d = this.ctx.emit({ ...extra, why: extra.why || why }, { player: this.player });
        if (d) directives.push(d);
      }
    }
    this.ctx.record(LIB_EVENTS.fired, {
      recipe: this.id, speaker, pool, variant: pick.index, line: text, fingerprint: sit.fingerprint,
      facets: info.facets, sentence: sit.sentence, why: whyOf(this.id, o.reason, sit.facets),
      directives: directives.map((d) => d.id), ...(o.effect ? { effect: o.effect.effect } : {}),
      ...(o.cooldownKey ? { cooldownKey: o.cooldownKey } : {}), ...(o.silent ? { channel: BARK_CHANNEL } : {}),
    }, { player: this.player });
    if (pick.reused || count >= 2) requestAiVariants(this, pool, speaker, sit, recent);
    return { text, info, situation: sit, directives };
  }

  /** Push a game effect with no spoken line (custom.reaction), recorded in the ledger. */
  effect(target: string, effect: string, payload: Record<string, unknown> = {}, o: { reason?: string; speaker?: string; also?: LooseDirectiveDraft[]; cooldownKey?: string } = {}): Directive | null {
    const speaker = o.speaker ?? (target.startsWith("npc:") ? target.slice(4) : target.startsWith("boss:") ? target.slice(5) : "world");
    const sit = buildSituation(this.ctx, this.world, this.player, speaker, this.l);
    const info: ReactionInfo = { recipe: this.id, fingerprint: sit.fingerprint, facets: sit.facets.slice(0, 12).map(facetId), sentence: sit.sentence };
    const why = whyOf(this.id, o.reason ?? effect, sit.facets);
    const d = this.ctx.emit({ kind: "custom.reaction", target, args: { recipe: this.id, target, payload: { effect, ...payload }, reaction: info }, why }, { player: this.player });
    const ids = d ? [d.id] : [];
    for (const extra of o.also ?? []) {
      const x = this.ctx.emit({ ...extra, why: extra.why || why }, { player: this.player });
      if (x) ids.push(x.id);
    }
    this.ctx.record(LIB_EVENTS.fired, {
      recipe: this.id, speaker, pool: effect, fingerprint: sit.fingerprint, facets: info.facets, sentence: sit.sentence, why, directives: ids, effect,
      ...(o.cooldownKey ? { cooldownKey: o.cooldownKey } : {}),
    }, { player: this.player });
    return d;
  }

  /** Emit any directive with the recipe's why (no ledger entry). */
  emit(draft: LooseDirectiveDraft, reason?: string): Directive | null {
    const sit = buildSituation(this.ctx, this.world, this.player, "world", this.l);
    return this.ctx.emit({ ...draft, why: draft.why || whyOf(this.id, reason, sit.facets) }, { player: this.player });
  }

  /** Start a rumour about the player from a pool (seeded variant). */
  rumour(key: string, pool: string, o: { vars?: Record<string, string | number | undefined>; sentiment: number; heat?: number; truthfulness?: number; knownBy?: string[] }): void {
    const lines = this.def.pools[pool] ?? [];
    if (!lines.length) return;
    const label = buildSituation(this.ctx, this.world, this.player, "world", this.l).label;
    const r = rngFrom(`${this.id}:${key}:${this.player}:${this.l.fired.length}`);
    const text = capFirst(fillLine(lines[Math.floor(r() * lines.length) % lines.length], { name: label, player: label, nick: this.l.nickname?.name, ...(o.vars ?? {}) }));
    createRumour(this.ctx, {
      key: `lib:${this.id}:${key}`, content: text, heat: o.heat ?? 0.6, sentiment: o.sentiment, truthfulness: o.truthfulness ?? 1,
      origin: { kind: "event", ref: this.id }, about: { player: this.player }, ...(o.knownBy?.length ? { knownBy: o.knownBy } : {}),
    }, { player: this.player });
  }

  /** Attitude change (+ an optional memory) for one NPC, through the persona module's events. */
  attitude(npc: string, delta: number, memory?: { text: string; kind?: "harm" | "gift" | "trade" | "other"; salience?: number }): void {
    if (!personaById(this.m, npc)) return;
    if (delta) this.ctx.record("lf.persona.attitude", { npc, delta: Math.round(delta * 100) / 100, reason: this.id }, { player: this.player });
    if (memory) this.ctx.record("lf.persona.memory", { npc, entry: { text: clip(memory.text, 200), kind: memory.kind ?? "other", salience: memory.salience ?? 0.7 } }, { player: this.player });
  }

  reputation(faction: string | undefined, delta: number, reason: string): void {
    if (faction && delta) changeReputation(this.ctx, this.player, faction, delta, `${this.id}: ${reason}`.slice(0, 120));
  }

  /**
   * Offer a quest in the manifest quest schema (needs the quests module). Objective types the manifest does not
   * allow are mapped to an allowed one when possible; returns null when nothing fits (callers then push a
   * custom.reaction hook instead).
   */
  quest(q: { key: string; giver?: string | null; title: string; summary: string; offer: string; objectives: Omit<QuestObjective, "id">[]; weight?: number; origin?: Quest["origin"] }): Quest | null {
    const m = this.m;
    if (!moduleEnabled(m, "quests")) return null;
    const allowed = m.quests.objectiveTypes;
    const FALLBACK: Record<string, string[]> = { defeat_boss: ["kill"], kill: ["defeat_boss", "survive"], deliver: ["fetch", "talk"], fetch: ["deliver", "talk"], explore: ["talk"], repair: ["fetch", "deliver", "talk"] };
    const objectives: QuestObjective[] = [];
    for (const o of q.objectives) {
      const type = allowed.includes(o.type) ? o.type : (FALLBACK[o.type] ?? []).find((t) => allowed.includes(t));
      if (!type || !o.target) continue;
      objectives.push({ ...o, id: `o${objectives.length + 1}`, type, target: o.target.slice(0, 64), description: clip(o.description, 200) });
    }
    if (!objectives.length) return null;
    const log = questLog(this.ctx, this.world, this.player);
    const tag = `key:lib:${q.key}`;
    if ([...log.offered, ...log.active.map((a) => a.quest)].some((x) => x.tags?.includes(tag))) return null;
    if (log.active.length >= m.quests.maxActive) return null;
    const giver = q.giver && personaById(m, q.giver) ? personaById(m, q.giver) : undefined;
    const quest: Quest = {
      id: shortId("q", `${this.world}:${this.player}:${q.key}:${this.now}`),
      title: clip(q.title, 80),
      summary: clip(q.summary, 400),
      ...(giver ? { giver: giver.id } : {}),
      objectives: objectives.slice(0, m.quests.maxObjectives),
      rewards: rewardsFor(m, q.weight ?? 1, giver, rngFrom(`${this.player}:${q.key}`)),
      dialogue: { offer: clip(q.offer, 400) },
      expiresInSec: 1800,
      origin: q.origin ?? { kind: "world", ref: this.id },
      tags: [tag, `recipe:${this.id}`],
    };
    this.ctx.record("lf.quests.offered", { quest, source: "rules" }, { player: this.player });
    const sit = buildSituation(this.ctx, this.world, this.player, giver?.id ?? "world", this.l);
    const d = this.ctx.emit({ kind: "quest.offer", target: giver ? `npc:${giver.id}` : "ui", args: { quest, ...(giver ? { giver: giver.id } : {}) }, why: whyOf(this.id, `quest "${quest.title}"`, sit.facets) }, { player: this.player });
    return d ? quest : null;
  }

  name(id: string): string { return nameOf(this.m, id); }
}

/** "recipe: reason · facet, facet, facet" (<= 200 chars). */
export function whyOf(recipe: string, reason: string | undefined, facets: Facet[]): string {
  const f = facets.slice(0, 4).map(facetId).join(", ");
  return clip(`${recipe}${reason ? `: ${reason}` : ""}${f ? ` · ${f}` : ""}`, 200);
}

// ------------------------------------------------------------------ AI variants (background, keyed servers only)

export const aiKey = (recipe: string, pool: string, speaker: string) => `ai:${recipe}:${pool}:${speaker}`;
const aiInflight = new Set<string>();
const aiLast = new Map<string, number>();
const AI_SCHEMA = {
  type: "object", additionalProperties: false, required: ["lines"],
  properties: { lines: { type: "array", items: { type: "string" } } },
};

/**
 * When a combination keeps coming back (or every variant was used), ask the LLM for fresh variants of that pool in
 * the speaker's voice, given the context sentence and the lines it must not repeat. Stored in kv; the next pick
 * uses them. At most one call per world every 20 s, budget-checked; never blocks a reaction.
 */
function requestAiVariants(run: RecipeRun, pool: string, speaker: string, sit: Situation, recent: string[]): void {
  const ctx = run.ctx;
  const m = ctx.manifest;
  if (!ctx.llm || !m.reactions.engine.ai || run.params.ai === false) return;
  const key = `${ctx.game}:${run.world}`;
  const now = run.now;
  if ((aiLast.get(key) ?? 0) > now - 20_000 || aiInflight.has(key)) return;
  if (!ctx.budgets.check(run.player).ok) return;
  aiLast.set(key, now);
  aiInflight.add(key);
  const persona = personaById(m, speaker);
  const examples = (run.def.pools[pool] ?? []).slice(0, 6);
  const placeholders = [...new Set(examples.join(" ").match(/\{\w+\}/g) ?? [])];
  const system = [
    `You write short spoken lines for characters in the game "${m.game.name}". Tone: ${m.lore.tone}. Content rating ${m.safety.rating}. Stay in-world.`,
    `World lore:\n${m.lore.bible.slice(0, 3000)}`,
  ].join("\n\n");
  const user = [
    `Recipe "${run.id}", line pool "${pool}". Example lines:\n${examples.map((e) => `- ${e}`).join("\n")}`,
    persona ? `Speaker: ${persona.name}, ${persona.role}. ${persona.personality.slice(0, 300)}` : `Speaker: ${sit.speakerName}.`,
    `Situation: ${sit.sentence}`,
    recent.length ? `Do not repeat or paraphrase:\n${recent.slice(-8).map((r) => `- ${r}`).join("\n")}` : "",
    `Write 4 new, different lines with the same purpose (max 140 characters each).${placeholders.length ? ` Keep these placeholders exactly where names/things go: ${placeholders.join(" ")}.` : ""} Return JSON {lines}.`,
  ].filter(Boolean).join("\n\n");
  void ctx.llm.json<{ lines?: unknown }>(AI_SCHEMA, system, user, { tier: "fast", maxTokens: 300, task: "world.reaction_lib", player: run.player })
    .then(async (r) => {
      const out: string[] = [];
      for (const l of Array.isArray(r.value?.lines) ? r.value.lines.slice(0, 6) : []) {
        if (typeof l !== "string") continue;
        const t = l.replace(/^["']|["']$/g, "").trim().slice(0, 160);
        if (!t || (t.match(/\{\w+\}/g) ?? []).some((p) => !placeholders.includes(p))) continue;
        const v = await ctx.moderation.check(t, { direction: "output", manifest: m });
        if (v.ok && !out.some((x) => normaliseLine(x) === normaliseLine(t))) out.push(t);
      }
      if (!out.length) return;
      const k = aiKey(run.id, pool, speaker);
      const prev = ctx.kv.get<string[]>(k) ?? [];
      ctx.kv.set(k, [...out, ...prev].slice(0, 12));
      ctx.log.debug("reaction variants written", { recipe: run.id, pool, speaker, lines: out.length });
    })
    .catch((e) => ctx.log.debug("reaction variants skipped", { recipe: run.id, error: (e as Error).message }))
    .finally(() => aiInflight.delete(key));
}

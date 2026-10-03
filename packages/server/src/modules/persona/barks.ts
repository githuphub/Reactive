// npc.bark: instant from a per-NPC bark pool keyed by context bucket (moment / rumour / attitude / gear / trait /
// time / trigger), seeded from the manifest and refilled by the LLM in the background; rules templates fill any
// gap. The upgrade is a fresh contextual bark (also added to the pool). Greetings are prefetched when the player
// approaches an NPC (movement.near_npc / social.approach).
import { cleanText, mulberry32, type AskResult, type StoredEvent } from "@liveforge/protocol";
import type { AskHandler, ScopedContext } from "../../module.js";
import { gearNames, gearTags } from "../observer/view.js";
import { voiceFor, type PersonaCard } from "./cards.js";
import { gatherContext, personaSystem, playerBlock, type NpcContext } from "./context.js";
import { seedFor } from "./intent.js";
import { libraryBark, libraryContext, noteLine } from "../world/reactions-lib/index.js";

type BarkResult = AskResult<"npc.bark">;

const POOL_MAX = 12;
const RECENT_MAX = 6;
const WANTED_MAX = 60;
const GREETING_TTL = 10 * 60_000;

/** kv keys (module-private). */
export const BK = {
  pool: (npc: string, bucket: string) => `pool:${npc}:${bucket}`,
  recent: (world: string, npc: string, player: string) => `recent:${world}:${npc}:${player}`,
  wanted: "wanted",
  greet: (world: string, npc: string, player: string) => `greet:${world}:${npc}:${player}`,
  greetCd: (world: string, npc: string, player: string) => `greetcd:${world}:${npc}:${player}`,
};

export interface BarkPool { lines: string[]; updatedAt: number }

interface Bucket {
  key: string;
  /** Description for the LLM refill prompt. */
  describe: string;
  /** Rules lines for this bucket (placeholders already filled). */
  templates: string[];
  emote?: string;
  /** Player-specific lines (rumours) are not pooled across players. */
  personal?: boolean;
}

const TRAIT_LINES: Record<string, string[]> = {
  rich: ["Heavy purse you've got there.", "Someone's been doing well for themselves."],
  broke: ["Pockets empty again?", "Coin's tight, eh? I know the feeling."],
  dodger: ["Quick on your feet, aren't you?", "Saw you dance around that last fight."],
  turtle: ["Hiding behind that guard won't win every fight.", "Careful one, aren't you?"],
  glass_cannon: ["Hit hard, bleed easy. That's you, isn't it?", "You'll get yourself killed fighting like that."],
  ranged_camper: ["Prefer to keep your distance, eh?", "Shooting from afar again?"],
  berserker: ["Easy, easy. Save some fury for the enemy.", "You fight like something possessed."],
  hoarder: ["Saving up for something?", "All that coin and you never spend a mark."],
  big_spender: ["Spending like there's no tomorrow.", "Merchants must love you."],
  pacifist: ["Haven't drawn your blade once, have you?", "A gentle soul. Rare, round here."],
  murderer: ["Stay away from me, killer.", "I know what you did."],
  thief: ["Keep your hands where I can see them.", "Count your pockets after talking to that one."],
  explorer: ["Found anything interesting out there?", "Been poking into every corner, I hear."],
  speedrunner: ["In a hurry again?", "Slow down, the world's not going anywhere."],
  chatterbox: ["You do like to talk.", "Not you again. My ears are still ringing."],
  liar: ["I'll take your word with a pinch of salt.", "Truth's a stranger to you, isn't it?"],
  feared: ["I-I don't want any trouble.", "Whatever you want, it's yours."],
  famous: ["It's you! Everyone's talking about you.", "The hero of the hour."],
  beloved: ["Always good to see a friendly face.", "There's our favourite."],
};

const MOMENT_LINES: Record<string, string[]> = {
  near_death_escape: ["Still breathing? Barely, by the look of you.", "You look like death warmed over."],
  flawless_phase: ["Not a scratch on you. Impressive.", "Clean work out there."],
  comeback: ["Thought you were finished back there.", "Never count you out, eh?"],
  betrayal: ["I heard what you did. Can't trust anyone these days.", "Turned on a friend, did you?"],
  absurd_purchase: ["You paid how much for that?", "A fool and their money..."],
  first_kill_of_type: ["First {type} you've felled, is it?", "Blooded at last."],
  broken_promise: ["Word is you don't keep your promises.", "Some folk's word means nothing."],
};

const TIME_LINES: Record<string, string[]> = {
  night: ["Late to be wandering about.", "Mind the dark."],
  dawn: ["Early start?", "Sun's barely up."],
  dusk: ["Getting dark.", "Best be indoors soon."],
};

const TRIGGER_LINES: Record<string, string[]> = {
  combat: ["Watch out!", "Behind you!"],
  farewell: ["Safe travels.", "Mind how you go."],
  approach: ["Hello there.", "Can I help you?"],
  greeting: ["Hello there.", "Well met."],
  gear: ["Nice gear.", "New kit?"],
  idle: ["Hm.", "Quiet day."],
};

const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? k);

/** Context buckets for this bark, highest priority first. */
function bucketsFor(c: NpcContext, trigger: string, now: number, recentGear: { item: string; tag?: string } | null): Bucket[] {
  const out: Bucket[] = [];
  const mo = c.player.moments.find((x) => now - x.ts < 3 * 60_000 && x.salience >= 0.4);
  if (mo) {
    const type = String(mo.data?.targetType ?? "beast");
    out.push({ key: `moment:${mo.kind}`, describe: `reacting to the player's moment "${mo.kind}" (${mo.evidence[0] ?? ""})`, templates: (MOMENT_LINES[mo.kind] ?? ["Quite a stir you caused."]).map((l) => fill(l, { type })), emote: "surprised" });
  }
  const rumour = c.rumours[0];
  if (rumour && rumour.heat >= 0.3) {
    out.push({ key: `rumour:${rumour.id}`, describe: `passing on a rumour: "${rumour.content}"`, templates: [`They say ${lowerFirst(rumour.content)}`, `Heard a rumour: ${lowerFirst(rumour.content)}`], emote: "whisper", personal: true });
  }
  if (c.attitude <= -0.5) out.push({ key: "attitude:hostile", describe: "the NPC dislikes the player", templates: ["You. Again.", "Keep walking."], emote: "glare" });
  else if (c.attitude >= 0.5) out.push({ key: "attitude:friendly", describe: "the NPC is fond of the player", templates: ["Good to see you, friend.", "There you are!"], emote: "smile" });
  if (recentGear) {
    out.push(recentGear.tag
      ? { key: `gear:${recentGear.tag.toLowerCase()}`, describe: `commenting on the player's new ${recentGear.tag} gear`, templates: [`${recentGear.tag}, is it? Careful where you point that.`, `That's ${recentGear.tag.toLowerCase()} work, if I'm any judge.`], emote: "look" }
      : { key: "gear:new", describe: "commenting on the player's new gear", templates: [`Nice ${recentGear.item}. Where'd you get that?`, `That ${recentGear.item} suits you.`], emote: "look" });
  }
  const top = c.player.top.find((t) => t.score >= 0.5);
  if (top) out.push({ key: `trait:${top.trait}`, describe: `the player is known as ${top.trait.replace(/_/g, " ")}`, templates: TRAIT_LINES[top.trait] ?? [`Ah, the ${top.trait.replace(/_/g, " ")}.`] });
  const phase = typeof c.player.stats.phase === "string" ? c.player.stats.phase : "";
  if (trigger === "idle" && TIME_LINES[phase]) out.push({ key: `time:${phase}`, describe: `it is ${phase}`, templates: TIME_LINES[phase] });
  const seed = [...c.card.barks, ...(c.card.greeting && (trigger === "approach" || trigger === "greeting") ? [c.card.greeting] : [])];
  out.push({ key: `trigger:${trigger}`, describe: `a ${trigger} bark`, templates: seed.length ? seed : TRIGGER_LINES[trigger] ?? TRIGGER_LINES.idle });
  return out;
}

const lowerFirst = (s: string) => (s ? s.charAt(0).toLowerCase() + s.slice(1) : s);

function recentGearOf(ctx: ScopedContext, c: NpcContext, context?: Record<string, unknown>): { item: string; tag?: string } | null {
  if (typeof context?.item === "string") return { item: context.item, tag: typeof context.tag === "string" ? context.tag : undefined };
  if (!ctx.player) return null;
  const ev = ctx.events({ world: ctx.world, player: ctx.player, type: "gear.equipped", since: ctx.now() - 5 * 60_000, desc: true, limit: 1 })[0];
  if (!ev) return null;
  const d = ev.data as { item?: unknown; name?: unknown; tags?: unknown };
  const tags = Array.isArray(d.tags) ? d.tags.filter((t): t is string => typeof t === "string") : gearTags(c.player);
  const item = typeof d.name === "string" ? d.name : typeof d.item === "string" ? d.item : Object.values(gearNames(c.player))[0] ?? "gear";
  return { item, tag: tags[0] };
}

function wantBucket(ctx: ScopedContext, npc: string, bucket: Bucket): void {
  if (bucket.personal) return;
  const list = ctx.kv.get<string[]>(BK.wanted) ?? [];
  const k = `${npc}|${bucket.key}|${bucket.describe}`.slice(0, 300);
  if (list.some((x) => x.startsWith(`${npc}|${bucket.key}|`))) return;
  list.push(k);
  ctx.kv.set(BK.wanted, list.slice(-WANTED_MAX));
}

/** Add lines to a pool (dedupe, keep the newest POOL_MAX). */
export function addToPool(ctx: ScopedContext, npc: string, bucket: string, lines: string[]): void {
  const key = BK.pool(npc, bucket);
  const pool = ctx.kv.get<BarkPool>(key) ?? { lines: [], updatedAt: 0 };
  for (const l of lines) if (l && !pool.lines.includes(l)) pool.lines.push(l);
  pool.lines = pool.lines.slice(-POOL_MAX);
  pool.updatedAt = ctx.now();
  ctx.kv.set(key, pool);
}

export const barkHandler: AskHandler<"npc.bark"> = {
  instant(ctx, p) {
    const now = ctx.now();
    const player = ctx.player ?? "";
    const c = gatherContext(ctx, p.npc);
    const voice = voiceFor(c.card, c.attitude <= -0.5 ? -0.3 : 0);

    // 1) A prefetched greeting (generated when the player approached).
    if (player && (p.trigger === "approach" || p.trigger === "greeting")) {
      const g = ctx.kv.get<{ text: string; emote?: string; at: number }>(BK.greet(ctx.world, p.npc, player));
      if (g && now - g.at < GREETING_TTL) {
        ctx.kv.delete(BK.greet(ctx.world, p.npc, player));
        remember(ctx, p.npc, player, g.text);
        return { result: { npc: p.npc, text: g.text, ...(g.emote ? { emote: g.emote } : {}), voice, actions: [] }, why: "prefetched greeting", source: "cache", final: true };
      }
    }

    // 2) Reaction Library (R1): the best-scoring recipe line for this NPC and situation (outfit, nickname, weather,
    //    promises, debts ...), novelty-checked so it never repeats; recorded in the library's ledger.
    if (player) {
      const lib = libraryBark(ctx, p.npc, p.trigger);
      if (lib) {
        remember(ctx, p.npc, player, lib.text, false);
        ctx.kv.set(`libbark:${ctx.askId}`, { recipe: lib.info.recipe, why: lib.why });
        return { result: { npc: p.npc, text: lib.text, ...(lib.emote ? { emote: lib.emote } : {}), voice, actions: [] }, why: lib.why };
      }
    }

    // 3) Highest-priority bucket with a pooled or template line not said recently.
    const recent = player ? ctx.kv.get<string[]>(BK.recent(ctx.world, p.npc, player)) ?? [] : [];
    const rng = mulberry32(seedFor(p.npc, player, p.trigger, Math.floor(now / 15_000)));
    const buckets = bucketsFor(c, p.trigger, now, p.trigger === "gear" || p.trigger === "approach" || p.trigger === "idle" ? recentGearOf(ctx, c, p.context) : null);
    for (const b of buckets) {
      const pooled = b.personal ? [] : ctx.kv.get<BarkPool>(BK.pool(p.npc, b.key))?.lines ?? [];
      const pool = pooled.filter((l) => !recent.includes(l));
      const templ = b.templates.filter((l) => !recent.includes(l));
      if (!pooled.length) wantBucket(ctx, p.npc, b);
      const from = pool.length ? pool : templ;
      if (!from.length) continue;
      const text = from[Math.floor(rng() * from.length) % from.length].slice(0, 300);
      if (player) remember(ctx, p.npc, player, text);
      return {
        result: { npc: p.npc, text, ...(b.emote ? { emote: b.emote } : {}), voice, actions: [] },
        why: `${b.key} (${pool.length ? "pool" : "template"})`,
      };
    }
    const fallback = buckets[buckets.length - 1].templates[0] ?? "Hm.";
    return { result: { npc: p.npc, text: fallback, voice, actions: [] }, why: "fallback line" };
  },

  async upgrade(ctx, p, instant) {
    const llm = ctx.llm;
    if (!llm) return null;
    const c = gatherContext(ctx, p.npc);
    const buckets = bucketsFor(c, p.trigger, ctx.now(), p.trigger === "gear" || p.trigger === "approach" || p.trigger === "idle" ? recentGearOf(ctx, c, p.context) : null);
    const b = buckets[0];
    // Reaction Library context: the situation sentence, what the recipes know, and the lines not to repeat.
    const lib = ctx.kv.get<{ recipe: string; why: string }>(`libbark:${ctx.askId}`);
    if (lib) ctx.kv.delete(`libbark:${ctx.askId}`);
    const lc = libraryContext(ctx, p.npc);
    const focus = lib ? `the ${lib.recipe.replace(/_/g, " ")} reaction (${lib.why.replace(/^reaction \S+: /, "")})` : b.describe;
    const line = await generateBark(ctx, c.card, c, `Say one bark now. Trigger: ${p.trigger}. Focus: ${focus}.${p.context ? ` Scene: ${JSON.stringify(p.context).slice(0, 300)}` : ""} Avoid repeating: "${instant.text}".${lc?.block ? `\n${lc.block}` : ""}`, ctx.signal);
    if (!line) return null;
    if (!b.personal && !lib) addToPool(ctx, p.npc, b.key, [line.text]);
    if (ctx.player) remember(ctx, p.npc, ctx.player, line.text);
    const result: BarkResult = { npc: p.npc, text: line.text, ...(line.emote ? { emote: line.emote } : {}), voice: instant.voice ?? voiceFor(c.card), actions: [] };
    return { result, why: `fresh bark: ${b.key}` };
  },

  cacheKey: () => false,
};

function remember(ctx: ScopedContext, npc: string, player: string, line: string, ledger = true): void {
  const key = BK.recent(ctx.world, npc, player);
  const list = (ctx.kv.get<string[]>(key) ?? []).filter((l) => l !== line);
  list.push(line);
  ctx.kv.set(key, list.slice(-RECENT_MAX));
  // the Reaction Library's novelty ledger covers Persona's own lines too (library lines are recorded by the library)
  if (ledger) noteLine(ctx, npc, line);
}

const BARK_SCHEMA = {
  type: "object", additionalProperties: false, required: ["text", "emote"],
  properties: { text: { type: "string" }, emote: { type: "string" } },
};
const POOL_SCHEMA = {
  type: "object", additionalProperties: false, required: ["lines"],
  properties: { lines: { type: "array", items: { type: "string" } } },
};

const sysCache = new WeakMap<object, Map<string, string>>();
function barkSystem(ctx: ScopedContext, card: PersonaCard): string {
  let per = sysCache.get(ctx.manifest);
  if (!per) sysCache.set(ctx.manifest, (per = new Map()));
  let s = per.get(card.id);
  if (!s) per.set(card.id, (s = personaSystem(ctx.manifest, card, "bark")));
  return s;
}

async function cleanLine(ctx: ScopedContext, raw: unknown): Promise<string> {
  const text = cleanText(raw, 200).replace(/^["']|["']$/g, "");
  if (!text) return "";
  const v = await ctx.moderation.check(text, { direction: "output", manifest: ctx.manifest });
  return v.ok ? text : "";
}

/** One fresh contextual bark from the LLM (fast tier). */
export async function generateBark(ctx: ScopedContext, card: PersonaCard, c: NpcContext, instruction: string, signal?: AbortSignal): Promise<{ text: string; emote?: string } | null> {
  if (!ctx.llm) return null;
  const r = await ctx.llm.json<{ text?: unknown; emote?: unknown }>(BARK_SCHEMA, barkSystem(ctx, card), `${playerBlock(c)}\n\n${instruction}\nReturn JSON {text, emote} (emote: one word or empty).`, {
    tier: "fast", task: "npc.bark", player: ctx.player, maxTokens: 120, signal,
  });
  const text = await cleanLine(ctx, r.value?.text);
  if (!text) return null;
  const emote = typeof r.value?.emote === "string" ? r.value.emote.replace(/[^a-z_ -]/gi, "").trim().slice(0, 32) : "";
  return { text, ...(emote ? { emote } : {}) };
}

/** Refill tick: generate lines for buckets that recently fell back to templates (bounded per run). */
export async function refillPools(ctx: ScopedContext, maxCalls = 2): Promise<void> {
  if (!ctx.llm || !ctx.budgets.check(null).ok) return;
  const wanted = ctx.kv.get<string[]>(BK.wanted) ?? [];
  if (!wanted.length) return;
  const batch = wanted.slice(0, maxCalls);
  ctx.kv.set(BK.wanted, wanted.slice(batch.length));
  for (const w of batch) {
    const [npc, bucket, ...rest] = w.split("|");
    const describe = rest.join("|");
    const card = gatherContext(ctx, npc).card;
    try {
      const r = await ctx.llm.json<{ lines?: unknown }>(POOL_SCHEMA, barkSystem(ctx, card), `Write 5 different short barks ${card.name} might say to a passing player. Situation: ${describe}. Lines must work for any player (no names). Return JSON {lines}.`, {
        tier: "fast", task: "npc.bark.pool", maxTokens: 300,
      });
      const lines: string[] = [];
      for (const l of Array.isArray(r.value?.lines) ? r.value.lines.slice(0, 8) : []) {
        const t = await cleanLine(ctx, l);
        if (t && t.length <= 160) lines.push(t);
      }
      if (lines.length) addToPool(ctx, npc, bucket, lines);
      ctx.log.debug("bark pool refilled", { npc, bucket, lines: lines.length });
    } catch (e) {
      ctx.log.warn("bark pool refill failed", { npc, bucket, error: e as Error });
      return;
    }
  }
}

const greetInflight = new Set<string>();

/** Prefetch a greeting when the player approaches an NPC (so npc.bark {trigger: approach} is instant + fresh). */
export function prefetchGreeting(ctx: ScopedContext, ev: StoredEvent): void {
  const npc = typeof (ev.data as { npc?: unknown }).npc === "string" ? String((ev.data as { npc: string }).npc) : "";
  const player = ctx.player;
  if (!npc || !player || !ctx.llm) return;
  if (!ctx.manifest.personas.some((p) => p.id === npc)) return;
  const now = ctx.now();
  const cdKey = BK.greetCd(ctx.world, npc, player);
  if ((ctx.kv.get<number>(cdKey) ?? 0) > now - 2 * 60_000) return;
  const existing = ctx.kv.get<{ at: number }>(BK.greet(ctx.world, npc, player));
  if (existing && now - existing.at < GREETING_TTL / 2) return;
  if (!ctx.budgets.check(player).ok) return;
  const key = `${ctx.game}:${ctx.world}:${npc}:${player}`;
  if (greetInflight.has(key)) return;
  greetInflight.add(key);
  ctx.kv.set(cdKey, now);
  const c = gatherContext(ctx, npc);
  void generateBark(ctx, c.card, c, `The player is walking up to you. Greet them in one line, reflecting your memories, their reputation or a rumour if relevant.`)
    .then((g) => { if (g) ctx.kv.set(BK.greet(ctx.world, npc, player), { ...g, at: ctx.now() }); })
    .catch((e) => ctx.log.debug("greeting prefetch failed", { npc, error: e as Error }))
    .finally(() => greetInflight.delete(key));
}

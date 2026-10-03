// Player profile (spec §3.1): a 2-3 sentence narrative every N events or on demand. LLM (rich tier, task
// "observer.profile") when available; otherwise a rules template from the top traits. Either way the text is
// recorded as "lf.observer.profile" so the projection (and a rebuild) picks it up.
import { cleanText } from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";
import type { ScopedContext } from "../../module.js";
import { OBS_EVENTS, readModel } from "./model.js";
import { describePlayer, viewModel, type ModelView } from "./view.js";

const PHRASES: Record<string, string> = {
  dodger: "slips out of harm's way rather than taking a hit",
  turtle: "hides behind a guard and waits for openings",
  glass_cannon: "hits hard and lives dangerously close to death",
  ranged_camper: "prefers to fight from a safe distance",
  berserker: "charges in swinging and keeps swinging when hurt",
  hoarder: "sits on a growing pile of gold",
  big_spender: "spends coin as fast as it comes",
  rich: "carries a heavy purse",
  broke: "has barely a coin to their name",
  pacifist: "gets by without drawing a blade",
  murderer: "has blood of innocents on their hands",
  thief: "has light fingers",
  explorer: "pokes into every corner of the world",
  speedrunner: "rushes from objective to objective",
  chatterbox: "talks to anyone who will listen",
  liar: "bends the truth when it suits them",
  feared: "makes people nervous",
  famous: "is the talk of the town",
  beloved: "is kind and generous with the locals",
};

const PROFILE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: { text: { type: "string", description: "2-3 sentences, third person, in the game's tone." } },
};

/** Rules profile: two short sentences from the top traits + the latest notable moment. */
export function rulesProfile(view: ModelView): string {
  const top = view.top.slice(0, 3);
  if (!top.length) return "A newcomer; nobody has made up their mind about them yet.";
  const ph = top.map((t) => PHRASES[t.trait] ?? `is known as ${t.trait.replace(/_/g, " ")}`);
  const first = ph.length === 1 ? `This player ${ph[0]}.` : `This player ${ph.slice(0, -1).join(", ")} and ${ph[ph.length - 1]}.`;
  const m = view.moments[0];
  const second = m ? ` Most recently: ${m.kind.replace(/_/g, " ")}${m.evidence[0] ? ` (${m.evidence[0]})` : ""}.` : "";
  return (first + second).slice(0, 400);
}

const systemPrompt = (m: Manifest) =>
  [
    `You write short player profiles for the game "${m.game.name}". NPCs, the boss director and quest writers read them as context.`,
    `Tone: ${m.lore.tone}. Write 2-3 sentences in the third person about how this player plays and what they are known for.`,
    "Only use the facts given. No real-world references, no meta talk about games or AI. Keep it under 60 words.",
    `World summary:\n${m.lore.bible.slice(0, 1500)}`,
  ].join("\n");

/**
 * Generate + record a fresh profile for ctx.player. Uses the LLM when present (and in budget), else rules.
 * Returns the text.
 */
export async function refreshProfile(ctx: ScopedContext, opts: { signal?: AbortSignal; llm?: boolean } = {}): Promise<string> {
  const player = ctx.player;
  if (!player) return "";
  const model = readModel((n, s) => ctx.projections.get(n, s), ctx.world, player);
  const view = viewModel(model, ctx.now(), ctx.manifest, 6);
  let text = "";
  let source: "ai" | "rules" = "rules";
  if (opts.llm !== false && ctx.llm && ctx.budgets.check(player).ok) {
    try {
      const r = await ctx.llm.json<{ text?: unknown }>(PROFILE_SCHEMA, systemPrompt(ctx.manifest), describePlayer(view, { maxMoments: 5 }), {
        tier: "rich", task: "observer.profile", player, maxTokens: 220, signal: opts.signal,
      });
      const cleaned = cleanText(r.value?.text, 500);
      const v = await ctx.moderation.check(cleaned, { direction: "output", manifest: ctx.manifest });
      if (cleaned && v.ok) { text = cleaned; source = "ai"; }
    } catch (e) {
      ctx.log.warn("profile LLM failed; using rules", { player, error: e as Error });
    }
  }
  if (!text) text = rulesProfile(view);
  ctx.record(OBS_EVENTS.profile, { text, eventCount: model.eventCount, source }, { world: ctx.world, player });
  return text;
}

const inflight = new Set<string>();

/** Called per event: refresh when the player has produced `every` events since the last profile. */
export function maybeRefreshProfile(ctx: ScopedContext, every: number): void {
  const player = ctx.player;
  if (!player || every <= 0) return;
  const model = readModel((n, s) => ctx.projections.get(n, s), ctx.world, player);
  const last = model.profile?.eventCount ?? 0;
  if (model.eventCount - last < every) return;
  const key = `${ctx.game}:${ctx.world}:${player}`;
  if (inflight.has(key)) return;
  inflight.add(key);
  void refreshProfile(ctx)
    .catch((e) => ctx.log.warn("profile refresh failed", { player, error: e as Error }))
    .finally(() => inflight.delete(key));
}

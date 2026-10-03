// npc.reply: instant = in-character canned line by intent + safe action (rules, ms); upgrade = streamed persona
// reply (fast tier unless manifest models.overrides["npc.reply"]) with lore, tone, memory, player model and rumours,
// structured actions validated against persona allowedActions + the manifest action schema.
import { cleanText, type AskResult } from "@liveforge/protocol";
import type { AskContext, AskHandler } from "../../module.js";
import { allowedActions, sanitizeActions, voiceFor, type RawAction } from "./cards.js";
import { gatherContext, personaSystem, playerBlock, type NpcContext } from "./context.js";
import { cannedReply, classifyIntent, refusal, screenInput, seedFor } from "./intent.js";
import { PERSONA_EVENTS } from "./memory.js";

type ReplyResult = AskResult<"npc.reply">;

/** Memories whose words overlap with what the player said (they get sharpened = recalled). */
function recalledEntries(c: NpcContext, text: string): number[] {
  const words = new Set(text.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  if (!words.size) return [];
  return (c.memory?.entries ?? []).filter((e) => e.text.toLowerCase().split(/\W+/).some((w) => w.length > 3 && words.has(w))).slice(0, 3).map((e) => e.ts);
}

/** Clamp to the manifest reply length at a sentence boundary when possible. */
export function clampReply(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > max * 0.4 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "...";
}

function maxChars(ctx: AskContext): number {
  return Math.min(1200, ctx.manifest.clamps.npc.maxReplyChars);
}

const REPLY_SCHEMA = (allowed: string[]) => ({
  type: "object",
  additionalProperties: false,
  required: ["text", "emote", "mood", "end", "actions"],
  properties: {
    text: { type: "string", description: "What you say aloud, in character." },
    emote: { type: "string", description: "One-word body language (nod, laugh, frown, shrug ...) or empty." },
    mood: { type: "number", description: "Attitude change toward the player this turn, -0.5..0.5." },
    end: { type: "boolean", description: "true if you end the conversation." },
    actions: {
      type: "array",
      description: "Usually empty. Only actions from your list.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "args"],
        properties: {
          action: allowed.length ? { type: "string", enum: allowed } : { type: "string" },
          args: {
            type: "array",
            items: { type: "object", additionalProperties: false, required: ["name", "value"], properties: { name: { type: "string" }, value: { type: "string" } } },
          },
        },
      },
    },
  },
});

interface LlmReply {
  text?: unknown;
  emote?: unknown;
  mood?: unknown;
  end?: unknown;
  actions?: { action?: unknown; args?: { name?: unknown; value?: unknown }[] }[];
}

export const replyHandler: AskHandler<"npc.reply"> = {
  instant(ctx, p) {
    const c = gatherContext(ctx, p.npc);
    const m = ctx.manifest;
    const seed = seedFor(p.npc, ctx.player ?? "", p.text, c.memory?.entries.length ?? 0);
    const moderated = typeof p.context?.moderated === "string" || p.context?.moderated === true;
    const verdict = moderated ? ({ ok: false, reason: "moderated" } as const) : screenInput(m, p.text);
    const intent = classifyIntent(p.text);
    const canned = verdict.ok
      ? cannedReply(m, c.card, intent, p.text, { attitude: c.attitude, met: !!c.memory?.lastTalked, grudge: !!c.memory?.entries.some((e) => e.kind === "harm" && c.now - e.ts < 30 * 60_000), seed })
      : refusal(m, c.card, verdict, seed);
    const text = clampReply(canned.text, maxChars(ctx));
    const result: ReplyResult = {
      npc: p.npc, text, actions: canned.actions,
      ...(canned.emote ? { emote: canned.emote } : {}),
      voice: voiceFor(c.card, canned.mood),
      ...(canned.mood ? { mood: canned.mood } : {}),
      ...(canned.end ? { end: true } : {}),
    };
    ctx.record(PERSONA_EVENTS.turn, { npc: p.npc, said: moderated ? "(something rude)" : p.text.slice(0, 200), reply: text, actions: canned.actions, mood: canned.mood, ref: ctx.askId, recalled: recalledEntries(c, p.text), stage: "instant" });
    return { result, why: `${canned.why}${c.card.declared ? "" : " (undeclared NPC)"}`, final: !verdict.ok };
  },

  async upgrade(ctx, p, instant) {
    const llm = ctx.llm;
    if (!llm) return null;
    const m = ctx.manifest;
    const c = gatherContext(ctx, p.npc);
    const max = maxChars(ctx);
    const history = (p.history ?? []).slice(-10).map((h) => `${h.role === "player" ? "Player" : c.card.name}: ${h.text.slice(0, 300)}`);
    const user = [
      playerBlock(c),
      p.context && Object.keys(p.context).length ? `Scene context: ${JSON.stringify(p.context).slice(0, 600)}` : "",
      history.length ? `Conversation so far:\n${history.join("\n")}` : "",
      `The player says to you: "${p.text.slice(0, 1000)}"`,
      "Answer as JSON.",
    ].filter(Boolean).join("\n\n");

    // Stream sentence chunks (moderated, length-clamped) when the client asked for it.
    let streamed = 0;
    const send = (txt: string) => {
      const room = max - streamed;
      if (room <= 0) return;
      const piece = txt.length > room ? clampReply(txt, room) : txt;
      streamed += piece.length + 1;
      if (piece) ctx.chunk(piece);
    };
    const onSentence = (s: string) => {
      const v = ctx.moderation.check(s, { direction: "output", manifest: m });
      if (v instanceof Promise) v.then((r) => send(r.ok ? s : r.cleaned)).catch(() => {});
      else send(v.ok ? s : v.cleaned);
    };

    const r = await llm.json<LlmReply>(REPLY_SCHEMA(allowedActions(m, c.card)), personaSystemCached(m, c.card), user, {
      tier: "fast", task: "npc.reply", player: ctx.player, maxTokens: 450, signal: ctx.signal,
      ...(p.stream ? { stream: { field: "text", onSentence } } : {}),
    });
    const v = r.value ?? {};
    let text = cleanText(v.text, 1200);
    if (!text) return null;
    const mod = await ctx.moderation.check(text, { direction: "output", manifest: m });
    if (!mod.ok) text = mod.cleaned;
    text = clampReply(text, max);
    const raw: RawAction[] = Array.isArray(v.actions)
      ? v.actions.map((a) => ({
          action: typeof a?.action === "string" ? a.action : "",
          args: Object.fromEntries((Array.isArray(a?.args) ? a.args : []).filter((x) => typeof x?.name === "string").map((x) => [String(x.name), x.value])),
        }))
      : [];
    const actions = sanitizeActions(m, c.card, raw, { attitude: c.attitude });
    const mood = typeof v.mood === "number" && Number.isFinite(v.mood) ? Math.round(Math.max(-0.5, Math.min(0.5, v.mood)) * 100) / 100 : 0;
    const emote = typeof v.emote === "string" ? v.emote.replace(/[^a-z_ -]/gi, "").trim().slice(0, 32) : "";
    const result: ReplyResult = {
      npc: p.npc, text, actions,
      ...(emote ? { emote } : {}),
      voice: voiceFor(c.card, mood),
      ...(mood ? { mood } : {}),
      ...(v.end === true ? { end: true } : {}),
    };
    // Replace the instant turn in memory (same ref) and apply only the mood difference.
    ctx.record(PERSONA_EVENTS.turn, { npc: p.npc, said: p.text.slice(0, 200), reply: text, actions, mood: Math.round((mood - (instant.mood ?? 0)) * 100) / 100, ref: ctx.askId, stage: "upgrade" });
    if (actions.some((a) => a.action === "quest_offer")) {
      // K2 quests can subscribe to this to generate the quest (the game may also ask quest.offer {giver}).
      ctx.record(PERSONA_EVENTS.questOffer, { npc: p.npc, askId: ctx.askId, context: p.text.slice(0, 200) });
    }
    return { result, why: `${c.card.name} in character (${r.model}, ${r.ms}ms)` };
  },

  cacheKey: () => false,
};

// The system prompt only depends on manifest + persona: memoise per manifest object for prompt caching stability.
const sysCache = new WeakMap<object, Map<string, string>>();
function personaSystemCached(m: Parameters<typeof personaSystem>[0], card: Parameters<typeof personaSystem>[1]): string {
  let per = sysCache.get(m);
  if (!per) sysCache.set(m, (per = new Map()));
  let s = per.get(card.id);
  if (!s) per.set(card.id, (s = personaSystem(m, card, "reply")));
  return s;
}


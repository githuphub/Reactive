// Brain feed (Livecraft spec §4): every agent step, build plan and AI decision as one small entry, pushed live over
// WS `{t:"brain", entry}` and kept in a per-world ring buffer (GET /v1/brain?world=&after=). Brain View and the
// dashboard render it with a model badge and latency.
import { z } from "zod";
import { Timestamp } from "./common.js";

/** Known producers (third-party modules may use their own id). */
export const BRAIN_SOURCES = ["agents", "builder", "factions", "director", "reactions", "forge", "persona"] as const;
export type BrainSource = (typeof BRAIN_SOURCES)[number];
export const BRAIN_KINDS = ["goal", "thought", "tool_call", "tool_result", "plan", "decision", "line"] as const;
export type BrainKind = (typeof BRAIN_KINDS)[number];
/** Badge: which brain answered. sonnet / haiku = live model, rules = instant rules, cache = cached AI answer, replay = cassette. */
export const BRAIN_MODELS = ["sonnet", "haiku", "rules", "cache", "replay"] as const;
export type BrainModel = (typeof BRAIN_MODELS)[number];

export const BrainEntry = z.object({
  /** Server id ("brn_<seq>"), increasing; pass the last one as GET /v1/brain?after=. */
  id: z.string().max(64),
  ts: Timestamp,
  /** Producer: agents | builder | factions | director | reactions | forge | persona (or a plugin id). */
  source: z.string().min(1).max(32),
  /** Who is thinking: npc id, faction id, "director" ... */
  actor: z.string().max(64),
  kind: z.enum(BRAIN_KINDS),
  /** One human line (thought text, "build({prompt})", plan summary ...). */
  text: z.string().max(1000),
  /** Structured payload (tool input / output, plan, decision data). */
  data: z.unknown().optional(),
  model: z.enum(BRAIN_MODELS).optional(),
  /** Latency of the call that produced it. */
  ms: z.number().optional(),
  /** Groups the entries of one agent run or ask (runId / askId). */
  ref: z.string().max(64).optional(),
  /** World the entry belongs to (stamped by the server). */
  world: z.string().max(64).optional(),
});
export type BrainEntry = z.infer<typeof BrainEntry>;

/** What modules pass to ctx.brain (id / ts / world are stamped by the server). */
export type BrainDraft = Omit<BrainEntry, "id" | "ts" | "world"> & { ts?: number };

/** GET /v1/brain?world=&after=&limit= response. */
export const BrainPage = z.object({ entries: z.array(BrainEntry), last: z.string().nullable() });
export type BrainPage = z.infer<typeof BrainPage>;

/**
 * Model badge from a model id and an optional answer source: source "replay" / "cache" / "rules" | "bake" win,
 * else haiku models -> "haiku", any other model -> "sonnet", no model -> "rules".
 */
export function brainModel(model?: string | null, source?: string | null): BrainModel {
  if (source === "replay") return "replay";
  if (source === "cache") return "cache";
  if (source === "rules" || source === "bake") return "rules";
  if (!model) return "rules";
  return /haiku/i.test(model) ? "haiku" : "sonnet";
}

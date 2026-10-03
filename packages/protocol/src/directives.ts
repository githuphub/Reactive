// Directives (spec §2.3): server -> game instructions pushed over WebSocket. Every directive carries a short `why`.
// Only actions declared in the manifest action schema are ever emitted (the server validates before pushing).
import { z } from "zod";
import { Bag, Id, Timestamp, Vec3 } from "./common.js";
import { Achievement, ForgedItem, Moment, NpcAction, Quest, VoiceStyle } from "./content.js";
import { Blueprint } from "./blueprint.js";
import { EngineMoveRef, MoveSpec } from "./moves.js";
import { ReactionDirectiveArgs, ReactionInfo } from "./reactions.js";

/** Args per built-in directive kind. */
export const DIRECTIVE_ARGS = {
  /** An NPC performs a manifest action (trade, flee, call_guards, steal ...). */
  "npc.action": z.object({ npc: z.string(), action: NpcAction, line: z.string().max(300).optional() }),
  /** An NPC says a line unprompted. */
  "npc.bark": z.object({
    npc: z.string(), text: z.string().max(300), emote: z.string().max(32).optional(), voice: VoiceStyle.optional(),
    /** Set when a Reaction Library recipe produced the line (recipe + context fingerprint + facets). */
    reaction: ReactionInfo.optional(),
  }),
  /** An NPC heard (and may repeat) a rumour. */
  "rumour.heard": z.object({ npc: z.string(), rumourId: z.string(), content: z.string().max(280), heat: z.number().min(0).max(1).optional() }),
  /** Spawn a wave via a spawner the game owns. */
  "spawn.wave": z.object({
    spawner: z.string().max(64).optional(),
    zone: z.string().max(64).optional(),
    position: Vec3.optional(),
    units: z.array(z.object({
      type: z.string().max(64),
      count: z.number().int().min(1).max(50),
      elite: z.boolean().optional(),
      modifiers: z.array(z.string()).optional(),
      tactic: z.string().max(32).optional(),
    })).min(1),
  }),
  /** Give the player a breather (pause spawns / lower aggression) for N seconds. */
  "pacing.breather": z.object({ seconds: z.number().min(1).max(600), loot: z.boolean().optional() }),
  /** A boss gains a new move (grammar and/or engine-native). */
  "boss.move_added": z.object({ boss: z.string(), move: MoveSpec, engineMove: EngineMoveRef.optional() }),
  /** Boss state change (aggression / attunement / weights). */
  "boss.adapt": z.object({
    boss: z.string(),
    aggression: z.number().min(0).max(1).optional(),
    attune: z.string().max(24).nullable().optional(),
    weights: z.record(z.string(), z.number()).optional(),
    taunt: z.string().max(200).optional(),
  }),
  /** Offer a quest (giver says the offer line). */
  "quest.offer": z.object({ quest: Quest, giver: z.string().optional() }),
  /** Quest progress / completion pushed by the quests module. */
  "quest.update": z.object({ questId: z.string(), status: z.enum(["active", "completed", "failed", "expired"]), objectiveId: z.string().optional(), progress: z.number().optional() }),
  "achievement.unlocked": z.object({ achievement: Achievement }),
  /** A dynamic objective inside an encounter (condition + reward). */
  "objective.dynamic": z.object({
    id: z.string(),
    text: z.string().max(200),
    /** DSL condition evaluated by the server (or the game, if it mirrors it). */
    condition: z.string().max(300),
    reward: z.object({ type: z.string(), id: z.string().optional(), amount: z.number().optional() }),
    expiresInSec: z.number().positive().optional(),
  }),
  /** A forge job finished (Hyper3D mesh ready, or an async forge upgrade). */
  "forge.ready": z.object({
    jobId: z.string(),
    askId: z.string().optional(),
    /** GLB url (server-relative, e.g. /v1/assets/<file>.glb) when a mesh is ready. */
    url: z.string().optional(),
    item: ForgedItem.optional(),
    blueprint: Blueprint.optional(),
    state: z.enum(["done", "failed"]),
  }),
  /** Loot drop. */
  "loot.drop": z.object({ items: z.array(ForgedItem).min(1), position: Vec3.optional(), from: z.string().optional() }),
  /** Difficulty / aggression change (mode hidden-adaptive or explicit assist). */
  "difficulty.set": z.object({ aggression: z.number().min(0).max(1), mode: z.enum(["hidden", "assist", "off"]), reason: z.string().max(200).optional() }),
  /** A notable moment was detected (Observer). */
  moment: z.object({ moment: Moment }),
  /** A reactive-rule outcome that isn't one of the above (manifest `reactions`). args are free. */
  "world.reaction": z.object({ rule: z.string(), effect: z.string(), data: Bag.optional() }),
  /**
   * A Reaction Library recipe's game-specific effect (pickpocket, loan offer, secret boss phase ...):
   * `{recipe, target, payload: {effect, ...}, line?, reaction?}`. See docs/reactions.md for every effect.
   */
  "custom.reaction": ReactionDirectiveArgs,
  /**
   * Agents (K6): run one tool for an NPC's goal. Execute it and answer with signal `agent.tool_result
   * {runId, callId, ok, output}` or POST /v1/m/agents/result (the JS SDK's agents.register does both for you).
   */
  "agent.tool_call": z.object({
    /** The NPC (also in the target, "npc:<id>"). */
    agent: z.string(),
    runId: z.string(),
    callId: z.string(),
    tool: z.string(),
    input: Bag,
    /** The server waits this long for the result (progress updates extend it). */
    timeoutMs: z.number().int().optional(),
    /** Loop step index. */
    step: z.number().int().optional(),
  }),
  /** Agents (K6): an NPC's run ended (finished, failed, interrupted or out of steps). */
  "agent.done": z.object({
    runId: z.string(),
    npc: z.string(),
    ok: z.boolean(),
    summary: z.string().max(300),
    state: z.enum(["done", "failed", "interrupted"]).optional(),
  }),
} as const;

export type DirectiveKind = keyof typeof DIRECTIVE_ARGS;
export const DIRECTIVE_KINDS = Object.keys(DIRECTIVE_ARGS) as DirectiveKind[];
export type DirectiveArgs<K extends DirectiveKind> = z.infer<(typeof DIRECTIVE_ARGS)[K]>;

/**
 * Wire shape. `target` addresses the receiver inside the game: "npc:<id>", "boss:<id>", "spawner:<id>",
 * "player" (the subscribed player), "world" (everyone in the world), "ui". Custom manifest directive kinds use
 * `custom.<name>` with free args.
 */
export const Directive = z.object({
  id: Id,
  kind: z.string().min(1).max(64),
  target: z.string().min(1).max(96),
  args: Bag,
  /** Short reason (<= 200 chars), shown in the dashboard timeline. */
  why: z.string().max(200),
  ts: Timestamp,
  world: Id,
  /** Set when addressed to one player; null = whole world. */
  player: Id.nullable(),
  /** Module that emitted it. */
  source: z.string().max(32).optional(),
});
export type Directive = z.infer<typeof Directive>;

/** Typed view of a directive of a known kind. */
export type TypedDirective<K extends DirectiveKind = DirectiveKind> = K extends DirectiveKind
  ? Omit<Directive, "kind" | "args"> & { kind: K; args: DirectiveArgs<K> }
  : never;

/** What a module passes to ctx.emit (id / ts / world / player are filled by the server). */
export type DirectiveDraft<K extends DirectiveKind = DirectiveKind> = K extends DirectiveKind
  ? { kind: K; target: string; args: DirectiveArgs<K>; why: string }
  : never;

/** Loose draft (custom kinds or JSON from the manifest reactions). */
export const DirectiveDraftSchema = z.object({
  kind: z.string().min(1).max(64),
  target: z.string().min(1).max(96),
  args: Bag.default({}),
  why: z.string().max(200).default(""),
});
export type LooseDirectiveDraft = z.infer<typeof DirectiveDraftSchema>;

export const isKnownDirectiveKind = (k: string): k is DirectiveKind => k in DIRECTIVE_ARGS;

/** Validate a directive's args for known kinds; custom kinds ("custom.*") pass through. */
export function validateDirectiveArgs(kind: string, args: unknown): { ok: true } | { ok: false; error: string } {
  if (!isKnownDirectiveKind(kind)) {
    return kind.startsWith("custom.") ? { ok: true } : { ok: false, error: `unknown directive kind "${kind}"` };
  }
  const r = DIRECTIVE_ARGS[kind].safeParse(args);
  return r.success ? { ok: true } : { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}

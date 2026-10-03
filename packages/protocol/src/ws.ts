// WebSocket envelope: GET /v1/ws?key=<publishable or admin key>[&world=&player=] upgrades to a socket that carries
// JSON text frames, one message per frame, discriminated by `t`.
import { z } from "zod";
import { Id, Timestamp } from "./common.js";
import { Directive } from "./directives.js";
import { AskResponse } from "./asks.js";
import { StoredEvent } from "./state.js";
import { ErrorBody } from "./http.js";
import { BrainEntry } from "./brain.js";

export const WS_PATH = "/v1/ws";
export const WS_TOPICS = ["directives", "upgrades", "chunks", "events", "jobs", "brain"] as const;
export type WsTopic = (typeof WS_TOPICS)[number];

// ---- client -> server

export const WsSubscribe = z.object({
  t: z.literal("subscribe"),
  world: Id,
  /** Omit to receive only world-wide directives (spectator / dashboard). */
  player: Id.optional(),
  /** Default: directives, upgrades, chunks, jobs, brain. "events" (the live event firehose) requires the admin key. */
  topics: z.array(z.enum(WS_TOPICS)).optional(),
});
export const WsUnsubscribe = z.object({ t: z.literal("unsubscribe"), world: Id, player: Id.optional() });
export const WsPing = z.object({ t: z.literal("ping"), ts: Timestamp.optional() });

export const WsClientMessage = z.discriminatedUnion("t", [WsSubscribe, WsUnsubscribe, WsPing]);
export type WsClientMessage = z.infer<typeof WsClientMessage>;

// ---- server -> client

export const WsWelcome = z.object({
  t: z.literal("welcome"),
  protocol: z.string(),
  game: z.string(),
  connId: z.string(),
  serverTime: Timestamp,
  admin: z.boolean(),
});
export const WsSubscribed = z.object({ t: z.literal("subscribed"), world: Id, player: Id.nullable(), topics: z.array(z.enum(WS_TOPICS)) });
export const WsDirective = z.object({ t: z.literal("directive"), directive: Directive });
/** An AI upgrade for an earlier ask (same id as the instant response). */
export const WsUpgrade = z.object({ t: z.literal("upgrade"), response: AskResponse });
/** Streamed piece of an upgrade (npc.reply with stream:true): sentence chunks in order, then the final `upgrade`. */
export const WsChunk = z.object({ t: z.literal("chunk"), id: Id, seq: z.number().int(), text: z.string(), done: z.boolean() });
/** Admin firehose: every stored event of the subscribed world (dashboard live stream). */
export const WsEvent = z.object({ t: z.literal("event"), event: StoredEvent });
/** Forge job state change. */
export const WsJob = z.object({ t: z.literal("job"), id: z.string(), state: z.enum(["queued", "generating", "done", "failed"]), url: z.string().optional() });
export const WsPong = z.object({ t: z.literal("pong"), ts: Timestamp.optional(), serverTime: Timestamp });
export const WsError = z.object({ t: z.literal("error"), error: ErrorBody.shape.error });
/** Brain feed entry (agent steps, build plans, AI decisions) for the subscribed world. */
export const WsBrain = z.object({ t: z.literal("brain"), entry: BrainEntry });

export const WsServerMessage = z.discriminatedUnion("t", [WsWelcome, WsSubscribed, WsDirective, WsUpgrade, WsChunk, WsEvent, WsJob, WsPong, WsError, WsBrain]);
export type WsServerMessage = z.infer<typeof WsServerMessage>;
export type WsServerMessageOf<T extends WsServerMessage["t"]> = Extract<WsServerMessage, { t: T }>;

// @liveforge/sdk - the Liveforge JS/TS client (browser, Node 22+, Deno, Bun, workers).
// Signals (batched), asks (instant + AI upgrade, streamed partials), directives over WebSocket with reconnect and
// long-poll fallback, fallback cache + bake packs, STT upload, forge jobs, snapshots. Wire types: @liveforge/protocol.
export { LiveforgeClient, createClient } from "./client.js";
export type { LiveforgeConfig, AskOptions, FallbackFn, OnOptions } from "./client.js";
export type { AskHandle, AskPartial } from "./ask.js";
export { FallbackCache } from "./cache.js";
export type { CachedAnswer, FallbackCacheOptions } from "./cache.js";
export { LiveforgeError, isLiveforgeError } from "./errors.js";
export type { LiveforgeErrorCode } from "./errors.js";
export { Emitter } from "./emitter.js";
export type { EventMap, Unsubscribe } from "./emitter.js";
export type { RealtimeStatus, WebSocketCtor } from "./realtime.js";
export type { FetchLike } from "./http.js";
export type { SignalData, CustomSignalType } from "./types.js";
export type { StorageLike } from "./util.js";
export { stableStringify, randomId } from "./util.js";
// Re-export the protocol types games use most, so `@liveforge/sdk` is enough for typical code.
export type {
  AskKind, AskParams, AskParamsInput, AskResult, AskResponse, AskSource, Directive, DirectiveKind, DirectiveArgs,
  TypedDirective, BuiltinSignalType, Blueprint, VfxRecipe, Variant, ForgedItem, Quest, Achievement, Rumour, Moment,
  NpcAction, VoiceStyle, MoveSpec, EngineMoveRef, PublicConfig, Snapshot, BakePack, SttResponse, ForgeJob,
} from "@liveforge/protocol";

// Record / replay "cassettes" for LLM calls (K7): a deterministic, cost-free demo with no API key.
//
//   LIVEFORGE_PROVIDER_MODE = live (default) | record | replay
//   LIVEFORGE_CASSETTES     = directory (default ./cassettes; commit it - cassettes hold prompts + answers, never keys)
//   LIVEFORGE_CASSETTE_LATENCY_MS = simulated latency for replayed answers (default 300)
//   LIVEFORGE_CASSETTE_FUZZY      = similarity threshold 0-1 for near-miss matching (default 0.6; 0 = exact only)
//
// The wrapper sits on the Anthropic *client* (messages.create / messages.stream, and the beta.messages twins), so
// every provider call (json, stream, and K6's tools()) is covered without touching the provider methods.
// - record: calls through, saves {request, response} under a hash of the canonical request.
// - replay: serves the saved response (after ~300 ms; streams are replayed as synthetic deltas), or throws
//   ReplayMissError on a miss - callers treat that like any LLM failure, so the rules answer stands.
// Replayed messages carry model "replay:<model>": metrics charge $0, and `why` / Brain badges read "replay".
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brainModel, type BrainModel } from "@liveforge/protocol";
import type { Logger } from "../log.js";

export type ProviderMode = "live" | "record" | "replay";
export const PROVIDER_MODES: readonly ProviderMode[] = ["live", "record", "replay"];

/** Prefix of the model id on replayed messages. */
export const REPLAY_PREFIX = "replay:";

/** Replay mode found no cassette for this request. Callers fall back to rules exactly as for any LLM error. */
export class ReplayMissError extends Error {
  constructor(public readonly key: string, public readonly model: string) {
    super(`no cassette for this ${model} request (key ${key.slice(0, 12)}); rules answer stands`);
    this.name = "ReplayMissError";
  }
}

/** True for a model id that came from a cassette ("replay:claude-haiku-4-5"). */
export const isReplayModel = (model: string | null | undefined): boolean => typeof model === "string" && model.startsWith(REPLAY_PREFIX);

/** The real model id ("replay:claude-haiku-4-5" -> "claude-haiku-4-5"). */
export const baseModel = (model: string): string => (isReplayModel(model) ? model.slice(REPLAY_PREFIX.length) : model);

/** Brain / dashboard badge for a model id: "replay" for cassettes, else "haiku" / "sonnet"; `fallback` for none. */
export function modelBadge(model: string | null | undefined, fallback: "rules" | "cache" = "rules"): BrainModel {
  return model ? brainModel(model) : fallback;
}

// ------------------------------------------------------------------ canonical request + keys

/** JSON with sorted keys (stable hashing). */
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}

/** Strip volatile bits that would make identical prompts hash differently (timestamps, "3 min ago"). */
export function normaliseText(s: string): string {
  return s
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?\b/g, "<iso>")
    .replace(/\b1[5-9]\d{11}\b/g, "<ts>")
    .replace(/\b\d+(\.\d+)?\s?(ms|s|sec|secs|seconds?|m|min|mins|minutes?|h|hrs?|hours?|d|days?)\s+ago\b/gi, "<ago>");
}

function normalise(v: unknown): unknown {
  if (typeof v === "string") return normaliseText(v);
  if (Array.isArray(v)) return v.map(normalise);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "cache_control") continue; // prompt caching hints don't change the answer
      out[k] = normalise(x);
    }
    return out;
  }
  return v;
}

/** The parts of a Messages request that decide the answer (not betas, effort, max_tokens or metadata). */
export function canonicalRequest(params: Record<string, unknown>): Record<string, unknown> {
  const oc = (params.output_config ?? {}) as Record<string, unknown>;
  return normalise({
    model: params.model,
    system: params.system,
    messages: params.messages,
    tools: params.tools,
    tool_choice: params.tool_choice,
    format: oc.format,
  }) as Record<string, unknown>;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Exact key: sha256 of the canonical request. */
export const requestKey = (canon: Record<string, unknown>) => sha(stable(canon));
/** Loose key: the same with every number replaced (trait scores and counters drift between runs). */
export const looseKey = (canon: Record<string, unknown>) => sha(stable(canon).replace(/\d+(\.\d+)?/g, "#"));

/** Fuzzy group: same model, system, tools, schema and conversation shape; only the message text may differ. */
function groupKey(canon: Record<string, unknown>): string {
  const msgs = Array.isArray(canon.messages) ? (canon.messages as { role?: string }[]) : [];
  return sha(stable({ model: canon.model, system: canon.system, tools: canon.tools, format: canon.format, roles: msgs.map((m) => m?.role ?? "?") }));
}

function tokens(canon: Record<string, unknown>): Set<string> {
  const text = stable(canon.messages ?? "").toLowerCase().replace(/\d+(\.\d+)?/g, " ");
  return new Set(text.split(/[^a-z_']+/).filter((w) => w.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// ------------------------------------------------------------------ store

/** One saved request -> response pair (a file in the cassettes directory). */
export interface Cassette {
  v: 1;
  key: string;
  loose: string;
  group: string;
  model: string;
  createdAt: number;
  /** Recorded from messages.stream (replayed as a synthetic stream). */
  streamed: boolean;
  /** Canonical request (what was hashed). */
  request: Record<string, unknown>;
  /** The Anthropic Message as returned. */
  response: Record<string, unknown>;
}

export interface CassetteSummary {
  key: string;
  file: string;
  model: string;
  createdAt: number;
  streamed: boolean;
  /** First words of the user message (for the dashboard list). */
  preview: string;
}

export interface CassetteStatus {
  mode: ProviderMode;
  dir: string;
  count: number;
  /** A real API key is configured (live / record possible). */
  liveAvailable: boolean;
  latencyMs: number;
  fuzzy: number;
  stats: { hits: number; looseHits: number; fuzzyHits: number; misses: number; recorded: number };
}

export interface CassetteStoreOptions {
  mode: ProviderMode;
  dir: string;
  latencyMs?: number;
  fuzzy?: number;
  log?: Logger;
}

type Match = { cassette: Cassette; match: "exact" | "loose" | "fuzzy"; score?: number };

/** Loads, matches and saves cassettes. One per process (see `cassettes()`). */
export class CassetteStore {
  private _mode: ProviderMode;
  readonly dir: string;
  latencyMs: number;
  fuzzy: number;
  /** Set by createProviders: whether a real key exists (live / record calls can succeed). */
  liveAvailable = false;
  private log: Logger | null;
  private byKey = new Map<string, Cassette>();
  private byLoose = new Map<string, Cassette>();
  private byGroup = new Map<string, Cassette[]>();
  private files = new Map<string, string>();
  private tokenCache = new WeakMap<Cassette, Set<string>>();
  readonly stats = { hits: 0, looseHits: 0, fuzzyHits: 0, misses: 0, recorded: 0 };

  constructor(opts: CassetteStoreOptions) {
    this._mode = opts.mode;
    this.dir = resolve(opts.dir);
    this.latencyMs = Math.max(0, opts.latencyMs ?? 300);
    this.fuzzy = Math.min(1, Math.max(0, opts.fuzzy ?? 0.6));
    this.log = opts.log ?? null;
    this.load();
  }

  /** Reads LIVEFORGE_PROVIDER_MODE / LIVEFORGE_CASSETTES / LIVEFORGE_CASSETTE_LATENCY_MS / LIVEFORGE_CASSETTE_FUZZY. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): CassetteStore {
    const raw = (env.LIVEFORGE_PROVIDER_MODE ?? "live").trim().toLowerCase();
    const mode = (PROVIDER_MODES as readonly string[]).includes(raw) ? (raw as ProviderMode) : "live";
    const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
    return new CassetteStore({
      mode,
      dir: env.LIVEFORGE_CASSETTES?.trim() || "cassettes",
      latencyMs: num(env.LIVEFORGE_CASSETTE_LATENCY_MS, 300),
      fuzzy: num(env.LIVEFORGE_CASSETTE_FUZZY, 0.6),
    });
  }

  get mode(): ProviderMode {
    return this._mode;
  }

  /** Switch mode at runtime (admin route). Throws when live / record is asked for without an API key. */
  setMode(mode: ProviderMode): void {
    if (!(PROVIDER_MODES as readonly string[]).includes(mode)) throw new Error(`unknown provider mode "${mode}" (live, record or replay)`);
    if (mode !== "replay" && !this.liveAvailable) throw new Error(`no ANTHROPIC_API_KEY on this server: only replay is possible`);
    this._mode = mode;
    this.log?.info("llm provider mode changed", { mode, cassettes: this.count });
  }

  attachLog(log: Logger): void {
    this.log = log;
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log?.debug(msg, data);
  }

  get count(): number {
    return this.byKey.size;
  }

  /** (Re)load every *.json cassette in the directory. */
  load(): number {
    this.byKey.clear();
    this.byLoose.clear();
    this.byGroup.clear();
    this.files.clear();
    if (!existsSync(this.dir)) return 0;
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const c = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Cassette;
        if (c?.v !== 1 || typeof c.key !== "string" || !c.response) continue;
        this.index(c, f);
      } catch (e) {
        this.log?.warn("unreadable cassette skipped", { file: f, error: (e as Error).message });
      }
    }
    return this.byKey.size;
  }

  private index(c: Cassette, file: string): void {
    this.byKey.set(c.key, c);
    this.byLoose.set(c.loose, c);
    const g = this.byGroup.get(c.group) ?? [];
    const i = g.findIndex((x) => x.key === c.key);
    if (i >= 0) g[i] = c;
    else g.push(c);
    this.byGroup.set(c.group, g);
    this.files.set(c.key, file);
  }

  /** Find the cassette for a request: exact hash, then loose (numbers ignored), then fuzzy (same shape, similar text). */
  find(params: Record<string, unknown>): { key: string; hit: Match | null } {
    const canon = canonicalRequest(params);
    const key = requestKey(canon);
    const exact = this.byKey.get(key);
    if (exact) {
      this.stats.hits++;
      return { key, hit: { cassette: exact, match: "exact" } };
    }
    const loose = this.byLoose.get(looseKey(canon));
    if (loose) {
      this.stats.looseHits++;
      return { key, hit: { cassette: loose, match: "loose" } };
    }
    if (this.fuzzy > 0) {
      const cands = this.byGroup.get(groupKey(canon)) ?? [];
      const mine = tokens(canon);
      let best: Cassette | null = null;
      let bestScore = 0;
      for (const c of cands) {
        let t = this.tokenCache.get(c);
        if (!t) this.tokenCache.set(c, (t = tokens(c.request)));
        const s = jaccard(mine, t);
        if (s > bestScore || (s === bestScore && best && c.createdAt > best.createdAt)) {
          best = c;
          bestScore = s;
        }
      }
      if (best && bestScore >= this.fuzzy) {
        this.stats.fuzzyHits++;
        return { key, hit: { cassette: best, match: "fuzzy", score: Math.round(bestScore * 100) / 100 } };
      }
    }
    this.stats.misses++;
    return { key, hit: null };
  }

  /** Save a request -> response pair (record mode). */
  save(params: Record<string, unknown>, response: unknown, streamed: boolean): void {
    if (!response || typeof response !== "object") return;
    const canon = canonicalRequest(params);
    const c: Cassette = {
      v: 1,
      key: requestKey(canon),
      loose: looseKey(canon),
      group: groupKey(canon),
      model: String(params.model ?? (response as { model?: string }).model ?? "unknown"),
      createdAt: Date.now(),
      streamed,
      request: canon,
      response: JSON.parse(JSON.stringify(response)) as Record<string, unknown>,
    };
    const file = `${c.model.replace(/[^a-z0-9.-]+/gi, "_")}-${c.key.slice(0, 16)}.json`;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, file), JSON.stringify(c, null, 2) + "\n");
      this.index(c, file);
      this.stats.recorded++;
      this.log?.info("cassette recorded", { file, model: c.model, streamed });
    } catch (e) {
      this.log?.warn("could not write cassette", { file, error: (e as Error).message });
    }
  }

  /** A deep copy of the recorded message, its model marked "replay:<model>". */
  materialise(c: Cassette): Record<string, unknown> {
    const msg = JSON.parse(JSON.stringify(c.response)) as Record<string, unknown>;
    msg.model = `${REPLAY_PREFIX}${baseModel(String(msg.model ?? c.model))}`;
    return msg;
  }

  list(limit = 500): CassetteSummary[] {
    const out: CassetteSummary[] = [];
    for (const c of this.byKey.values()) {
      const msgs = Array.isArray(c.request.messages) ? (c.request.messages as { content?: unknown }[]) : [];
      const first = msgs.find((m) => m?.content !== undefined)?.content;
      const text = typeof first === "string" ? first : stable(first ?? "");
      out.push({ key: c.key, file: this.files.get(c.key) ?? "", model: c.model, createdAt: c.createdAt, streamed: c.streamed, preview: text.replace(/\s+/g, " ").slice(0, 120) });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  status(): CassetteStatus {
    return { mode: this._mode, dir: this.dir, count: this.count, liveAvailable: this.liveAvailable, latencyMs: this.latencyMs, fuzzy: this.fuzzy, stats: { ...this.stats } };
  }

  /** One line for the startup log: "replay, 42 cassettes". */
  describe(): string {
    return this._mode === "live" ? "live" : `${this._mode}, ${this.count} cassette${this.count === 1 ? "" : "s"}`;
  }
}

let shared: CassetteStore | null = null;

/** The process-wide cassette store (created from env on first use). */
export function cassettes(): CassetteStore {
  return (shared ??= CassetteStore.fromEnv());
}

// ------------------------------------------------------------------ client wrapper

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    if (signal?.aborted) return rej(new Error("aborted"));
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }, { once: true });
  });

type StreamEvent = Record<string, unknown> & { type: string };

/** Split text into small pieces (on spaces where possible) so downstream sentence splitters see a real stream. */
function pieces(text: string, size = 32): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    if (end < text.length) {
      const sp = text.lastIndexOf(" ", end);
      if (sp > i + 8) end = sp + 1;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/** A replayed message as a Messages stream: async-iterable events + finalMessage(), like the SDK's MessageStream. */
class ReplayStream {
  private consumed = false;
  constructor(private readonly message: Record<string, unknown>, private readonly latencyMs: number, private readonly signal?: AbortSignal) {}

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    this.consumed = true;
    await sleep(this.latencyMs, this.signal);
    const msg = this.message;
    const content = Array.isArray(msg.content) ? (msg.content as Record<string, unknown>[]) : [];
    yield { type: "message_start", message: { ...msg, content: [], stop_reason: null } };
    let budget = 900; // ms of drip across all deltas
    for (let index = 0; index < content.length; index++) {
      const block = content[index];
      const text = block.type === "text" ? String(block.text ?? "") : block.type === "tool_use" ? JSON.stringify(block.input ?? {}) : "";
      const start = block.type === "text" ? { type: "text", text: "" } : block.type === "tool_use" ? { ...block, input: {} } : block;
      yield { type: "content_block_start", index, content_block: start };
      if (block.type === "text" || block.type === "tool_use") {
        const parts = pieces(text);
        const step = parts.length ? Math.min(25, budget / parts.length) : 0;
        for (const p of parts) {
          if (step >= 1) {
            await sleep(step, this.signal);
            budget -= step;
          }
          yield block.type === "text"
            ? { type: "content_block_delta", index, delta: { type: "text_delta", text: p } }
            : { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: p } };
        }
      }
      yield { type: "content_block_stop", index };
    }
    yield { type: "message_delta", delta: { stop_reason: msg.stop_reason ?? "end_turn", stop_sequence: null }, usage: msg.usage ?? {} };
    yield { type: "message_stop" };
  }

  async finalMessage(): Promise<Record<string, unknown>> {
    if (!this.consumed) for await (const _ of this) { /* drain */ }
    return this.message;
  }

  /** MessageStream compatibility no-ops. */
  on(): this { return this; }
  abort(): void {}
  async done(): Promise<void> { await this.finalMessage(); }
}

type MessagesLike = {
  create(params: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown>;
  stream(params: Record<string, unknown>, opts?: { signal?: AbortSignal }): unknown;
};

function wrapMessages(target: MessagesLike, store: CassetteStore): MessagesLike {
  const serve = (params: Record<string, unknown>) => {
    const { key, hit } = store.find(params);
    if (!hit) throw new ReplayMissError(key, String(params.model ?? "?"));
    if (hit.match !== "exact") store.debug("cassette near match", { match: hit.match, score: hit.score, cassette: hit.cassette.key.slice(0, 16) });
    return store.materialise(hit.cassette);
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop === "create") {
        return async (params: Record<string, unknown>, opts?: { signal?: AbortSignal }) => {
          const mode = store.mode;
          if (mode === "replay") {
            const msg = serve(params);
            if (params.stream === true) return new ReplayStream(msg, store.latencyMs, opts?.signal);
            await sleep(store.latencyMs, opts?.signal);
            return msg;
          }
          const res = await t.create(params, opts);
          if (mode === "record" && params.stream !== true) store.save(params, res, false);
          return res;
        };
      }
      if (prop === "stream") {
        return (params: Record<string, unknown>, opts?: { signal?: AbortSignal }) => {
          const mode = store.mode;
          if (mode === "replay") return new ReplayStream(serve(params), store.latencyMs, opts?.signal);
          const real = t.stream(params, opts) as { finalMessage?: () => Promise<unknown> };
          if (mode === "record" && typeof real?.finalMessage === "function") {
            real.finalMessage().then((m) => store.save(params, m, true)).catch(() => { /* failed calls are not recorded */ });
          }
          return real;
        };
      }
      const v = Reflect.get(t, prop);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

/**
 * Wrap an Anthropic client so `messages.create/stream` (and `beta.messages.*`) go through the cassette store.
 * In "live" mode the calls pass straight through. Usage (claude.ts): `withCassettes(new Anthropic({...}))`.
 */
export function withCassettes<T extends object>(client: T, store: CassetteStore = cassettes()): T {
  const cache = new Map<object, MessagesLike>();
  const wrapped = (m: unknown): unknown => {
    if (!m || typeof m !== "object") return m;
    let w = cache.get(m);
    if (!w) cache.set(m, (w = wrapMessages(m as MessagesLike, store)));
    return w;
  };
  return new Proxy(client, {
    get(t, prop) {
      const v = Reflect.get(t, prop);
      if (prop === "messages") return wrapped(v);
      if (prop === "beta" && v && typeof v === "object") {
        return new Proxy(v as object, {
          get(bt, bp) {
            const bv = Reflect.get(bt, bp);
            if (bp === "messages") return wrapped(bv);
            return typeof bv === "function" ? bv.bind(bt) : bv;
          },
        });
      }
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

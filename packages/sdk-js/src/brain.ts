// Brain feed client: live entries from the WebSocket (`{t:"brain"}`), history from GET /v1/brain, and local entries
// (the offline agent runner, your own game reasoning). Offline-safe: without a server it serves the local buffer.
import type { BrainDraft, BrainEntry, BrainPage } from "@liveforge/protocol";
import { Emitter, type Unsubscribe } from "./emitter.js";
import { isLiveforgeError } from "./errors.js";
import type { HttpRequest, HttpResponse } from "./http.js";

/** Filter for subscribe(): only entries from this source / actor / kind. */
export interface BrainFilter {
  source?: string;
  actor?: string;
  kind?: BrainEntry["kind"];
  /** Only entries of one agent run / ask. */
  ref?: string;
}

/** @internal wiring from the client. */
export interface BrainDeps {
  request<T>(req: HttpRequest): Promise<HttpResponse<T>>;
  world(): string;
  offline: boolean;
}

const MAX_LOCAL = 300;
let localSeq = 0;

const matches = (e: BrainEntry, f: BrainFilter | undefined) =>
  !f || ((!f.source || e.source === f.source) && (!f.actor || e.actor === f.actor) && (!f.kind || e.kind === f.kind) && (!f.ref || e.ref === f.ref));

/**
 * `lf.brain`: what the game's AI is thinking, as one stream of {@link BrainEntry} (agent goals, thoughts, tool calls
 * and results, build plans, Director decisions, reaction lines), each with a model badge and latency.
 *
 * ```ts
 * lf.brain.subscribe((e) => brainView.add(`[${e.model ?? "?"}] ${e.actor}: ${e.text}`));
 * const history = await lf.brain.recent();
 * ```
 */
export class BrainFeed {
  private readonly events = new Emitter<{ entry: (e: BrainEntry) => void }>();
  private readonly buffer: BrainEntry[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly deps: BrainDeps) {}

  /** Live entries (server + local), optionally filtered. Returns an unsubscribe function. */
  subscribe(cb: (entry: BrainEntry) => void, filter?: BrainFilter): Unsubscribe {
    return this.events.on("entry", (e) => {
      if (matches(e, filter)) cb(e);
    });
  }

  /**
   * Recent entries, oldest first: the server's ring buffer for this world (GET /v1/brain) merged with local ones;
   * just the local buffer when offline or unreachable.
   */
  async recent(opts: { limit?: number; after?: string } = {}): Promise<BrainEntry[]> {
    const limit = Math.max(1, Math.min(300, opts.limit ?? 100));
    if (!this.deps.offline) {
      try {
        const r = await this.deps.request<BrainPage>({ method: "GET", path: "/v1/brain", query: { world: this.deps.world(), after: opts.after, limit } });
        for (const e of r.data?.entries ?? []) this.remember(e);
      } catch (err) {
        if (!isLiveforgeError(err) || !err.retryable) throw err;
      }
    }
    const world = this.deps.world();
    return this.buffer.filter((e) => !e.world || e.world === world).sort((a, b) => a.ts - b.ts).slice(-limit);
  }

  /** Add a local entry (shown to subscribers, kept in recent(); not sent to the server). */
  add(draft: BrainDraft): BrainEntry {
    const e: BrainEntry = { ...draft, id: `local_${Date.now().toString(36)}_${(localSeq++).toString(36)}`, ts: draft.ts ?? Date.now(), world: this.deps.world() };
    this.push(e);
    return e;
  }

  /** @internal entry from the WebSocket or a local runner. */
  push(e: BrainEntry): void {
    if (!this.remember(e)) return;
    this.events.emit("entry", e);
  }

  private remember(e: BrainEntry): boolean {
    if (!e || typeof e.id !== "string" || this.seen.has(e.id)) return false;
    this.seen.add(e.id);
    this.buffer.push(e);
    if (this.buffer.length > MAX_LOCAL) {
      const drop = this.buffer.splice(0, this.buffer.length - MAX_LOCAL);
      for (const d of drop) this.seen.delete(d.id);
    }
    return true;
  }
}

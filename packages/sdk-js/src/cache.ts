// Fallback cache: remembers the last good answer per (kind, params) in memory and, when available, in
// localStorage, and serves bake packs (pre-generated, designer-approved answers) when the server is unreachable.
import type { AskSource, BakePack } from "@liveforge/protocol";
import { LiveforgeError } from "./errors.js";
import { defaultStorage, isPlainObject, stableStringify, type StorageLike } from "./util.js";
import { hashString } from "@liveforge/protocol";

/** One remembered answer. */
export interface CachedAnswer {
  kind: string;
  key: string;
  result: unknown;
  source: AskSource;
  why?: string;
  /** When it was stored (ms epoch). */
  ts: number;
}

export interface FallbackCacheOptions {
  /** Persistent storage. Default: localStorage when available. `null` = memory only. */
  storage?: StorageLike | null;
  /** Storage key namespace (default "default"; the client uses the game key + server URL). */
  namespace?: string;
  /** Entries kept (least recently used dropped first). Default 300. */
  maxEntries?: number;
  /** Max age of an entry in ms. Default 7 days. */
  ttlMs?: number;
}

/** Params that never belong in a cache key (they change per call without changing the meaning). */
const VOLATILE_PARAMS = new Set(["seed", "stream", "history"]);
/** Params that identify "who" an answer is for: pack entries must match them when present. */
const IDENTITY_PARAMS = ["npc", "boss", "giver"] as const;
/** Params that pack entries may be keyed by (first present wins, after the identity params). */
const KEY_PARAMS = ["prompt", "trigger", "enemy", "zone", "asset", "family", "slot", "role"] as const;

/**
 * Last-good-answer cache + bake pack store. The client consults it when an ask fails (network, timeout, 5xx) or
 * when it runs in `offline` mode. You rarely need it directly: use `client.loadPack()` and `client.cache`.
 */
export class FallbackCache {
  private readonly mem = new Map<string, CachedAnswer>();
  private readonly storage: StorageLike | null;
  private readonly storageKey: string;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly packList: BakePack[] = [];

  constructor(opts: FallbackCacheOptions = {}) {
    this.storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    this.storageKey = `liveforge:cache:${opts.namespace ?? "default"}`;
    this.maxEntries = Math.max(1, opts.maxEntries ?? 300);
    this.ttlMs = opts.ttlMs ?? 7 * 24 * 3600 * 1000;
    this.restore();
  }

  /** Cache key for an ask: kind + params without volatile fields (seed, stream, history). */
  key(kind: string, params: unknown): string {
    const p = isPlainObject(params)
      ? Object.fromEntries(Object.entries(params).filter(([k]) => !VOLATILE_PARAMS.has(k)))
      : params;
    return `${kind}|${stableStringify(p ?? {})}`;
  }

  /** Last good answer for exactly these params, if any (and not expired). */
  get(kind: string, params: unknown): CachedAnswer | undefined {
    const key = this.key(kind, params);
    const hit = this.mem.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.ts > this.ttlMs) {
      this.mem.delete(key);
      return undefined;
    }
    // LRU touch.
    this.mem.delete(key);
    this.mem.set(key, hit);
    return hit;
  }

  /** Remembers an answer. AI answers replace rules answers; a rules answer never replaces an AI one. */
  set(kind: string, params: unknown, result: unknown, source: AskSource, why?: string): void {
    const key = this.key(kind, params);
    const prev = this.mem.get(key);
    if (prev && (prev.source === "ai" || prev.source === "cache") && source === "rules" && Date.now() - prev.ts < this.ttlMs) return;
    this.mem.delete(key);
    const entry: CachedAnswer = { kind, key, result, source, ts: Date.now() };
    if (why) entry.why = why;
    this.mem.set(key, entry);
    while (this.mem.size > this.maxEntries) {
      const oldest = this.mem.keys().next().value;
      if (oldest === undefined) break;
      this.mem.delete(oldest);
    }
    this.scheduleSave();
  }

  /** Forgets every cached answer (packs stay loaded). */
  clear(): void {
    this.mem.clear();
    try {
      this.storage?.removeItem(this.storageKey);
    } catch {
      /* storage unavailable */
    }
  }

  /** Number of cached answers. */
  get size(): number {
    return this.mem.size;
  }

  // ---------------------------------------------------------------------------------------------- packs

  /**
   * Adds a bake pack (from `GET /admin/bake` or a file you ship with the game). Later packs win over earlier ones.
   * Returns the number of entries added. Throws `invalid_input` when the object is not a pack.
   */
  loadPack(pack: unknown): number {
    if (!isPlainObject(pack) || pack.protocol !== "liveforge-protocol/1" || !isPlainObject(pack.entries)) {
      throw new LiveforgeError("invalid_input", 'not a Liveforge bake pack (expected {protocol: "liveforge-protocol/1", entries: {...}})');
    }
    const p = pack as unknown as BakePack;
    this.packList.unshift(p);
    return Object.values(p.entries).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
  }

  /** Loaded packs (latest first). */
  get packs(): readonly BakePack[] {
    return this.packList;
  }

  /**
   * Picks a pack answer for an ask. Matching, in order: an entry whose key equals the cache key; else, when the
   * params name an npc / boss / giver, only entries keyed or tagged with that id (`"bess"`, `"bess:greeting"`);
   * then an entry keyed / tagged by prompt, trigger, enemy, zone ...; else a deterministic pick by params hash.
   */
  fromPack(kind: string, params: unknown): { key: string; result: unknown } | undefined {
    const p = isPlainObject(params) ? params : {};
    const exact = this.key(kind, params);
    for (const pack of this.packList) {
      let list = pack.entries[kind];
      if (!Array.isArray(list) || list.length === 0) continue;
      const hitExact = list.find((e) => e.key === exact);
      if (hitExact) return hitExact;
      const ident = IDENTITY_PARAMS.map((k) => p[k]).find((v): v is string => typeof v === "string" && v.length > 0);
      const matches = (e: { key: string; tags?: string[] }, id: string) => {
        const k = e.key.toLowerCase();
        const v = id.toLowerCase();
        return k === v || k.startsWith(`${v}:`) || k.startsWith(`${v}|`) || !!e.tags?.some((t) => t.toLowerCase() === v);
      };
      if (ident) {
        list = list.filter((e) => matches(e, ident));
        if (!list.length) continue;
      }
      for (const k of KEY_PARAMS) {
        const v = p[k];
        if (typeof v !== "string" || !v) continue;
        const hit = list.find((e) => matches(e, v) || e.key.toLowerCase().endsWith(`:${v.toLowerCase()}`));
        if (hit) return hit;
      }
      return list[hashString(exact) % list.length];
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------------------------- persistence

  private restore(): void {
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return;
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) return;
      const now = Date.now();
      for (const e of arr) {
        if (isPlainObject(e) && typeof e.key === "string" && typeof e.ts === "number" && now - e.ts <= this.ttlMs) {
          this.mem.set(e.key, e as unknown as CachedAnswer);
        }
      }
    } catch {
      /* corrupt or unavailable storage: start empty */
    }
  }

  private scheduleSave(): void {
    if (!this.storage || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 500);
  }

  /** Writes the cache to storage now (called automatically, debounced). Halves the cache on quota errors. */
  save(): void {
    if (!this.storage) return;
    let entries = [...this.mem.values()];
    for (let tries = 0; tries < 4 && entries.length; tries++) {
      try {
        this.storage.setItem(this.storageKey, JSON.stringify(entries));
        return;
      } catch {
        entries = entries.slice(Math.floor(entries.length / 2));
      }
    }
  }
}

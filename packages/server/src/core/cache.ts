// Answer cache: exact key + simple normalised-key dedupe (case / whitespace / punctuation / key order), backed by
// SQLite with an in-memory LRU in front. Semantic cache is a stub interface (no embeddings in v1).
import { createHash } from "node:crypto";
import type { Db } from "../store/db.js";

export interface SemanticCache {
  /** v1 stub: always null. A future implementation embeds `text` and returns the nearest cached answer. */
  lookup<T = unknown>(kind: string, text: string, threshold?: number): T | null;
  index(kind: string, text: string, value: unknown): void;
}

export interface Cache {
  /** Stable key from arbitrary material (normalised: sorted keys, lower-case, collapsed whitespace, no punctuation). */
  key(kind: string, material: unknown): string;
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown, opts?: { ttlSec?: number; kind?: string }): void;
  delete(key: string): void;
  semantic: SemanticCache;
}

/** Normalise any JSON-able value into a canonical string for dedupe. */
export function normaliseMaterial(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (typeof x === "string") return x.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      return Object.fromEntries(Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => [k, norm(o[k])]));
    }
    return x;
  };
  return JSON.stringify(norm(v));
}

export class CacheStore {
  private readonly lru = new Map<string, { value: unknown; expires: number | null }>();
  private readonly max = 2000;
  private readonly getStmt;
  private readonly setStmt;
  private readonly hitStmt;
  private readonly delStmt;
  hits = 0;
  misses = 0;

  constructor(private readonly db: Db) {
    this.getStmt = db.prepare("SELECT value, expires_at FROM cache WHERE key = ?");
    this.setStmt = db.prepare("INSERT INTO cache (key, game, kind, value, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at, expires_at = excluded.expires_at");
    this.hitStmt = db.prepare("UPDATE cache SET hits = hits + 1 WHERE key = ?");
    this.delStmt = db.prepare("DELETE FROM cache WHERE key = ?");
  }

  count(game?: string): number {
    const r = (game ? this.db.prepare("SELECT COUNT(*) AS n FROM cache WHERE game = ?").get(game) : this.db.prepare("SELECT COUNT(*) AS n FROM cache").get()) as { n: number };
    return r.n;
  }

  purgeExpired(): number {
    return this.db.prepare("DELETE FROM cache WHERE expires_at IS NOT NULL AND expires_at < ?").run(Date.now()).changes;
  }

  scoped(game: string): Cache {
    const semantic: SemanticCache = { lookup: () => null, index: () => {} };
    return {
      key: (kind, material) => `${game}:${kind}:${createHash("sha256").update(normaliseMaterial(material)).digest("base64url").slice(0, 32)}`,
      get: <T>(key: string): T | undefined => {
        const now = Date.now();
        const mem = this.lru.get(key);
        if (mem && (mem.expires === null || mem.expires > now)) {
          this.lru.delete(key);
          this.lru.set(key, mem);
          this.hits++;
          return mem.value as T;
        }
        const row = this.getStmt.get(key) as { value: string; expires_at: number | null } | undefined;
        if (!row || (row.expires_at !== null && row.expires_at <= now)) {
          this.misses++;
          return undefined;
        }
        const value = JSON.parse(row.value) as T;
        this.remember(key, value, row.expires_at);
        this.hitStmt.run(key);
        this.hits++;
        return value;
      },
      set: (key, value, opts = {}) => {
        const expires = opts.ttlSec ? Date.now() + opts.ttlSec * 1000 : null;
        this.setStmt.run(key, game, opts.kind ?? key.split(":")[1] ?? "", JSON.stringify(value), Date.now(), expires);
        this.remember(key, value, expires);
      },
      delete: (key) => {
        this.lru.delete(key);
        this.delStmt.run(key);
      },
      semantic,
    };
  }

  private remember(key: string, value: unknown, expires: number | null) {
    this.lru.delete(key);
    this.lru.set(key, { value, expires });
    if (this.lru.size > this.max) this.lru.delete(this.lru.keys().next().value!);
  }
}

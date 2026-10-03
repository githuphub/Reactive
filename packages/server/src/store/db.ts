// SQLite (better-sqlite3, WAL). One file holds every game; all tables are keyed by game.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

const SCHEMA_VERSION = 1;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    game TEXT NOT NULL,
    world TEXT NOT NULL,
    player TEXT,
    session TEXT,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    ts INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    origin TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_gw ON events(game, world, seq);
  CREATE INDEX IF NOT EXISTS events_gwp ON events(game, world, player, seq);
  CREATE INDEX IF NOT EXISTS events_gt ON events(game, type, seq);

  CREATE TABLE IF NOT EXISTS projection_state (
    game TEXT NOT NULL, world TEXT NOT NULL, player TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
    state TEXT NOT NULL, seq INTEGER NOT NULL,
    PRIMARY KEY (game, world, player, name)
  );
  CREATE TABLE IF NOT EXISTS projection_meta (game TEXT PRIMARY KEY, checkpoint INTEGER NOT NULL, signature TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS worlds (game TEXT NOT NULL, world TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (game, world));
  CREATE TABLE IF NOT EXISTS players (game TEXT NOT NULL, world TEXT NOT NULL, player TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY (game, world, player));

  CREATE TABLE IF NOT EXISTS kv (game TEXT NOT NULL, ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (game, ns, key));

  CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, game TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, hits INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS cache_gk ON cache(game, kind);

  CREATE TABLE IF NOT EXISTS forge_jobs (
    id TEXT PRIMARY KEY, game TEXT NOT NULL, world TEXT NOT NULL, player TEXT, provider TEXT NOT NULL, provider_job TEXT,
    state TEXT NOT NULL, prompt TEXT NOT NULL, url TEXT, error TEXT, ask_id TEXT, meta TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS forge_jobs_state ON forge_jobs(state);

  CREATE TABLE IF NOT EXISTS ask_log (
    id TEXT NOT NULL, game TEXT NOT NULL, world TEXT, player TEXT, kind TEXT NOT NULL, module TEXT NOT NULL, stage TEXT NOT NULL,
    source TEXT NOT NULL, ms INTEGER NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
    usd REAL NOT NULL DEFAULT 0, error TEXT, ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ask_log_g ON ask_log(game, ts);

  CREATE TABLE IF NOT EXISTS usage (game TEXT NOT NULL, scope TEXT NOT NULL, day TEXT NOT NULL, usd REAL NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (game, scope, day));

  CREATE TABLE IF NOT EXISTS review (id TEXT PRIMARY KEY, game TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
    note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  `,
];

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.exec(MIGRATIONS[v]);
    db.pragma(`user_version = ${v + 1}`);
  }
  return db;
}

/** Namespaced key-value store (per game + namespace, usually a module id). JSON values. */
export class Kv {
  private readonly getStmt;
  private readonly setStmt;
  private readonly delStmt;
  private readonly listStmt;
  constructor(private readonly db: Db) {
    this.getStmt = db.prepare("SELECT value FROM kv WHERE game = ? AND ns = ? AND key = ?");
    this.setStmt = db.prepare("INSERT INTO kv (game, ns, key, value, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(game, ns, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
    this.delStmt = db.prepare("DELETE FROM kv WHERE game = ? AND ns = ? AND key = ?");
    this.listStmt = db.prepare("SELECT key, value FROM kv WHERE game = ? AND ns = ? AND key LIKE ? ESCAPE '\\' ORDER BY key LIMIT ?");
  }
  scoped(game: string, ns: string): KvScope {
    return {
      get: <T>(key: string): T | undefined => {
        const row = this.getStmt.get(game, ns, key) as { value: string } | undefined;
        return row ? (JSON.parse(row.value) as T) : undefined;
      },
      set: (key: string, value: unknown) => void this.setStmt.run(game, ns, key, JSON.stringify(value), Date.now()),
      delete: (key: string) => void this.delStmt.run(game, ns, key),
      list: <T>(prefix = "", limit = 1000): { key: string; value: T }[] =>
        (this.listStmt.all(game, ns, `${prefix.replace(/[%_]/g, "\\$&")}%`, limit) as { key: string; value: string }[]).map((r) => ({ key: r.key, value: JSON.parse(r.value) as T })),
    };
  }
}

export interface KvScope {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  list<T>(prefix?: string, limit?: number): { key: string; value: T }[];
}

// The event log: append-only, the single source of truth. Every signal is an event; modules record internal
// events ("lf.<module>.<what>") for anything a projection must be able to rebuild (LLM outputs included).
import type { StoredEvent } from "@liveforge/protocol";
import type { Db } from "./db.js";

export interface NewEvent {
  game: string;
  world: string;
  player: string | null;
  session: string | null;
  type: string;
  data: Record<string, unknown>;
  ts: number;
  origin: StoredEvent["origin"];
}

export interface EventQuery {
  game: string;
  world?: string;
  player?: string;
  /** Exact type, or a prefix pattern "combat.*". */
  type?: string;
  /** seq > after */
  after?: number;
  /** seq < before (for paging backwards). */
  before?: number;
  /** ts >= since (ms) */
  since?: number;
  limit?: number;
  /** newest first (default oldest first). */
  desc?: boolean;
}

type Row = { seq: number; game: string; world: string; player: string | null; session: string | null; type: string; data: string; ts: number; received_at: number; origin: string };
const toEvent = (r: Row): StoredEvent => ({
  seq: r.seq, game: r.game, world: r.world, player: r.player, session: r.session, type: r.type,
  data: JSON.parse(r.data), ts: r.ts, receivedAt: r.received_at, origin: r.origin as StoredEvent["origin"],
});

export class EventLog {
  private readonly insert;
  private readonly touchWorld;
  private readonly touchPlayer;

  constructor(private readonly db: Db) {
    this.insert = db.prepare(
      "INSERT INTO events (game, world, player, session, type, data, ts, received_at, origin) VALUES (@game, @world, @player, @session, @type, @data, @ts, @received_at, @origin)",
    );
    this.touchWorld = db.prepare("INSERT INTO worlds (game, world, created_at, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(game, world) DO UPDATE SET last_seen = excluded.last_seen");
    this.touchPlayer = db.prepare("INSERT INTO players (game, world, player, created_at, last_seen) VALUES (?, ?, ?, ?, ?) ON CONFLICT(game, world, player) DO UPDATE SET last_seen = excluded.last_seen");
  }

  append(e: NewEvent): StoredEvent {
    const now = Date.now();
    const info = this.insert.run({ ...e, data: JSON.stringify(e.data ?? {}), received_at: now });
    this.touchWorld.run(e.game, e.world, now, now);
    if (e.player) this.touchPlayer.run(e.game, e.world, e.player, now, now);
    return { seq: Number(info.lastInsertRowid), game: e.game, world: e.world, player: e.player, session: e.session, type: e.type, data: e.data ?? {}, ts: e.ts, receivedAt: now, origin: e.origin };
  }

  query(q: EventQuery): StoredEvent[] {
    const where: string[] = ["game = @game"];
    const p: Record<string, unknown> = { game: q.game };
    if (q.world) { where.push("world = @world"); p.world = q.world; }
    if (q.player) { where.push("player = @player"); p.player = q.player; }
    if (q.type) {
      if (q.type.endsWith(".*")) { where.push("type LIKE @type"); p.type = `${q.type.slice(0, -1)}%`; }
      else if (q.type !== "*") { where.push("type = @type"); p.type = q.type; }
    }
    if (q.after !== undefined) { where.push("seq > @after"); p.after = q.after; }
    if (q.before !== undefined) { where.push("seq < @before"); p.before = q.before; }
    if (q.since !== undefined) { where.push("ts >= @since"); p.since = q.since; }
    p.limit = Math.min(Math.max(q.limit ?? 500, 1), 10_000);
    const sql = `SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY seq ${q.desc ? "DESC" : "ASC"} LIMIT @limit`;
    return (this.db.prepare(sql).all(p) as Row[]).map(toEvent);
  }

  /** Iterate every event of a game (optionally one world) in seq order, in pages. */
  *scan(game: string, opts: { world?: string; after?: number } = {}): Generator<StoredEvent> {
    let after = opts.after ?? 0;
    for (;;) {
      const page = this.query({ game, world: opts.world, after, limit: 2000 });
      if (!page.length) return;
      yield* page;
      after = page[page.length - 1].seq;
    }
  }

  lastSeq(game?: string): number {
    const row = (game
      ? this.db.prepare("SELECT MAX(seq) AS s FROM events WHERE game = ?").get(game)
      : this.db.prepare("SELECT MAX(seq) AS s FROM events").get()) as { s: number | null };
    return row.s ?? 0;
  }

  deleteWorld(game: string, world: string): number {
    return this.db.prepare("DELETE FROM events WHERE game = ? AND world = ?").run(game, world).changes;
  }

  worlds(game: string): { world: string; createdAt: number; lastSeen: number }[] {
    return (this.db.prepare("SELECT world, created_at, last_seen FROM worlds WHERE game = ? ORDER BY last_seen DESC").all(game) as { world: string; created_at: number; last_seen: number }[])
      .map((r) => ({ world: r.world, createdAt: r.created_at, lastSeen: r.last_seen }));
  }

  players(game: string, world?: string): { world: string; player: string; createdAt: number; lastSeen: number }[] {
    const rows = (world
      ? this.db.prepare("SELECT world, player, created_at, last_seen FROM players WHERE game = ? AND world = ? ORDER BY last_seen DESC").all(game, world)
      : this.db.prepare("SELECT world, player, created_at, last_seen FROM players WHERE game = ? ORDER BY last_seen DESC").all(game)) as { world: string; player: string; created_at: number; last_seen: number }[];
    return rows.map((r) => ({ world: r.world, player: r.player, createdAt: r.created_at, lastSeen: r.last_seen }));
  }

  activePlayers(game: string, world: string, sinceMs: number): string[] {
    return (this.db.prepare("SELECT player FROM players WHERE game = ? AND world = ? AND last_seen >= ?").all(game, world, Date.now() - sinceMs) as { player: string }[]).map((r) => r.player);
  }
}

/** "combat.*" matches "combat.hit"; "*" matches all; otherwise exact. */
export function matchType(pattern: string, type: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

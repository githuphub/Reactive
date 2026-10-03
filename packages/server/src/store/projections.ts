// Projection framework: folds events into per-(game, world[, player]) state, in memory, with periodic checkpoints
// to SQLite. On startup the engine restores the checkpoint (if the projection signature still matches) and replays
// events after it; otherwise it rebuilds the game from the whole log.
import type { StoredEvent } from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";
import type { Db } from "./db.js";
import { matchType, type EventLog } from "./events.js";
import type { Projection, ProjectionKey } from "../module.js";
import type { Logger } from "../log.js";

interface Slot {
  state: unknown;
  seq: number;
  dirty: boolean;
}

interface GameProjections {
  manifest: Manifest;
  list: Projection<unknown>[];
  byName: Map<string, Projection<unknown>>;
  /** "world|player|name" -> slot */
  slots: Map<string, Slot>;
  checkpoint: number;
}

const slotKey = (world: string, player: string | null, name: string) => `${world}|${player ?? ""}|${name}`;

export function projectionSignature(list: Projection<unknown>[]): string {
  return list.map((p) => `${p.name}@${p.version ?? 1}:${p.scope}`).sort().join(",");
}

export class ProjectionEngine {
  private readonly games = new Map<string, GameProjections>();

  constructor(private readonly db: Db, private readonly events: EventLog, private readonly log: Logger) {}

  /** (Re)register the projections of a game. Restores from checkpoint or rebuilds. */
  register(game: string, manifest: Manifest, list: Projection<unknown>[]): void {
    const dup = list.map((p) => p.name).find((n, i, a) => a.indexOf(n) !== i);
    if (dup) throw new Error(`projection "${dup}" registered twice for game ${game}`);
    const gp: GameProjections = { manifest, list, byName: new Map(list.map((p) => [p.name, p])), slots: new Map(), checkpoint: 0 };
    this.games.set(game, gp);
    const sig = projectionSignature(list);
    const meta = this.db.prepare("SELECT checkpoint, signature FROM projection_meta WHERE game = ?").get(game) as { checkpoint: number; signature: string } | undefined;
    if (meta && meta.signature === sig) {
      const rows = this.db.prepare("SELECT world, player, name, state, seq FROM projection_state WHERE game = ?").all(game) as { world: string; player: string; name: string; state: string; seq: number }[];
      for (const r of rows) {
        if (!gp.byName.has(r.name)) continue;
        gp.slots.set(slotKey(r.world, r.player || null, r.name), { state: JSON.parse(r.state), seq: r.seq, dirty: false });
      }
      gp.checkpoint = meta.checkpoint;
      let n = 0;
      for (const ev of this.events.scan(game, { after: meta.checkpoint })) {
        this.applyTo(gp, ev);
        n++;
      }
      this.log.info("projections restored", { game, checkpoint: meta.checkpoint, replayed: n, slots: gp.slots.size });
    } else {
      this.rebuild(game);
    }
  }

  setManifest(game: string, manifest: Manifest): void {
    const gp = this.games.get(game);
    if (gp) gp.manifest = manifest;
  }

  names(game: string): { name: string; scope: "world" | "player"; version: number }[] {
    return (this.games.get(game)?.list ?? []).map((p) => ({ name: p.name, scope: p.scope, version: p.version ?? 1 }));
  }

  has(game: string, name: string): boolean {
    return !!this.games.get(game)?.byName.has(name);
  }

  scopeOf(game: string, name: string): "world" | "player" | undefined {
    return this.games.get(game)?.byName.get(name)?.scope;
  }

  /** Apply one freshly appended event (called by the runtime right after EventLog.append). */
  apply(ev: StoredEvent): void {
    const gp = this.games.get(ev.game);
    if (gp) this.applyTo(gp, ev);
  }

  private applyTo(gp: GameProjections, ev: StoredEvent): void {
    for (const p of gp.list) {
      if (p.types && !p.types.some((t) => matchType(t, ev.type))) continue;
      if (p.scope === "player" && !ev.player) continue;
      const player = p.scope === "player" ? ev.player : null;
      const key: ProjectionKey = { game: ev.game, world: ev.world, player };
      const k = slotKey(ev.world, player, p.name);
      let slot = gp.slots.get(k);
      if (!slot) {
        slot = { state: p.init(key, gp.manifest), seq: 0, dirty: true };
        gp.slots.set(k, slot);
      }
      try {
        const next = p.apply(slot.state, ev, { manifest: gp.manifest, key });
        if (next !== undefined) slot.state = next;
      } catch (e) {
        this.log.error("projection apply failed", { projection: p.name, seq: ev.seq, type: ev.type, error: e as Error });
      }
      slot.seq = ev.seq;
      slot.dirty = true;
    }
  }

  /** Read state (lazy init, not persisted until an event touches it). */
  get<S = unknown>(game: string, name: string, world: string, player?: string | null): S {
    const gp = this.games.get(game);
    const p = gp?.byName.get(name);
    if (!gp || !p) throw new Error(`unknown projection "${name}" for game ${game} (module disabled?)`);
    const pl = p.scope === "player" ? (player ?? null) : null;
    if (p.scope === "player" && !pl) throw new Error(`projection "${name}" is player-scoped: pass a player`);
    const slot = gp.slots.get(slotKey(world, pl, name));
    if (slot) return slot.state as S;
    const init = p.init({ game, world, player: pl }, gp.manifest);
    gp.slots.set(slotKey(world, pl, name), { state: init, seq: 0, dirty: false });
    return init as S;
  }

  /** All player states of a player-scoped projection in one world. */
  all<S = unknown>(game: string, name: string, world: string): { player: string; state: S }[] {
    const gp = this.games.get(game);
    if (!gp) return [];
    const out: { player: string; state: S }[] = [];
    const prefix = `${world}|`;
    for (const [k, slot] of gp.slots) {
      if (!k.startsWith(prefix) || !k.endsWith(`|${name}`)) continue;
      const player = k.slice(prefix.length, k.length - name.length - 1);
      if (player) out.push({ player, state: slot.state as S });
    }
    return out;
  }

  /** Every state of a world (snapshots). */
  dumpWorld(game: string, world: string): Record<string, { world?: unknown; players?: Record<string, unknown> }> {
    const gp = this.games.get(game);
    const out: Record<string, { world?: unknown; players?: Record<string, unknown> }> = {};
    if (!gp) return out;
    for (const p of gp.list) {
      if (p.scope === "world") out[p.name] = { world: this.get(game, p.name, world) };
      else out[p.name] = { players: Object.fromEntries(this.all(game, p.name, world).map((x) => [x.player, x.state])) };
    }
    return out;
  }

  /** Drop state and replay the log (whole game, or one world). */
  rebuild(game: string, world?: string): { events: number } {
    const gp = this.games.get(game);
    if (!gp) return { events: 0 };
    if (world) {
      for (const k of [...gp.slots.keys()]) if (k.startsWith(`${world}|`)) gp.slots.delete(k);
      this.db.prepare("DELETE FROM projection_state WHERE game = ? AND world = ?").run(game, world);
    } else {
      gp.slots.clear();
      this.db.prepare("DELETE FROM projection_state WHERE game = ?").run(game);
    }
    let n = 0;
    for (const ev of this.events.scan(game, { world })) {
      this.applyTo(gp, ev);
      n++;
    }
    if (!world) gp.checkpoint = 0;
    this.flush(game);
    this.log.info("projections rebuilt", { game, world: world ?? "*", events: n });
    return { events: n };
  }

  /** Persist dirty states + checkpoint (all games, or one). */
  flush(onlyGame?: string): void {
    const upsert = this.db.prepare(
      "INSERT INTO projection_state (game, world, player, name, state, seq) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(game, world, player, name) DO UPDATE SET state = excluded.state, seq = excluded.seq",
    );
    const meta = this.db.prepare(
      "INSERT INTO projection_meta (game, checkpoint, signature) VALUES (?, ?, ?) ON CONFLICT(game) DO UPDATE SET checkpoint = excluded.checkpoint, signature = excluded.signature",
    );
    const tx = this.db.transaction((game: string, gp: GameProjections) => {
      for (const [k, slot] of gp.slots) {
        if (!slot.dirty) continue;
        const [world, player, name] = k.split("|");
        upsert.run(game, world, player, name, JSON.stringify(slot.state), slot.seq);
        slot.dirty = false;
      }
      const last = this.events.lastSeq(game);
      gp.checkpoint = last;
      meta.run(game, last, projectionSignature(gp.list));
    });
    for (const [game, gp] of this.games) {
      if (onlyGame && game !== onlyGame) continue;
      try {
        tx(game, gp);
      } catch (e) {
        this.log.error("projection flush failed", { game, error: e as Error });
      }
    }
  }
}

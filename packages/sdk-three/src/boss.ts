// LiveBoss: maps Director output (phase plans, boss.move_added, boss.adapt) onto your boss's move ids.
import type { BossMovePlan, Directive, EngineMoveRef, MoveSpec, VoiceStyle } from "@liveforge/protocol";
import { Emitter, type AskHandle, type LiveforgeClient, type Unsubscribe } from "@liveforge/sdk";
import { speak } from "./tts.js";

/** Your implementation of one engine-native move (manifest `moves.engine[].id`). */
export type MoveHandler = (params: EngineMoveRef["params"], move: MoveSpec | undefined) => void;

export interface LiveBossOptions {
  client: LiveforgeClient;
  /** Boss id from the manifest (`bosses[].id`). */
  id: string;
  /** Engine move id -> your handler. Moves the Director picks or invents with an `engine` mapping call these. */
  moves?: Record<string, MoveHandler>;
  /** Called for invented grammar moves without an engine mapping (build them from MoveSpec primitives). */
  onGrammarMove?: (move: MoveSpec) => void;
  /** Speak taunts with speechSynthesis. Default false. */
  speakTaunts?: boolean;
  voice?: VoiceStyle;
}

/** A move in the boss's current rotation. */
export interface RotationEntry {
  /** Engine move id, or the grammar move name. */
  id: string;
  engine?: EngineMoveRef;
  grammar?: MoveSpec;
  weight: number;
}

type BossEvents = {
  /** The boss learned a move (directive or phase plan). */
  move_added: (move: MoveSpec, engine: EngineMoveRef | undefined) => void;
  /** A taunt line to show / speak. */
  taunt: (text: string) => void;
  /** Aggression / attunement / weights changed. */
  adapt: (state: { aggression: number; attune: string | null; weights: Record<string, number> }) => void;
  /** A new phase plan (instant, then again when the AI upgrade lands). */
  phase: (plan: { phase: number; rotation: RotationEntry[]; aggression: number; counters: string[]; why?: string; stage: "instant" | "upgrade" }) => void;
  /** perform() ran a move. */
  performed: (entry: RotationEntry) => void;
};

/**
 * Adaptive boss glue.
 *
 * ```ts
 * const dummy = new LiveBoss({ client: lf, id: "training_dummy", moves: {
 *   dummy_spin: (p) => spin(p.speed as number), dummy_slam: (p) => slam(p.radius as number) } });
 * dummy.on("taunt", (t) => subtitle(t));
 * dummy.requestPhase(2, { hp: 0.5 });
 * setInterval(() => dummy.performNext(), 3000);
 * ```
 */
export class LiveBoss extends Emitter<BossEvents> {
  readonly id: string;
  /** Current rotation (engine moves + invented moves) with weights. */
  rotation: RotationEntry[] = [];
  /** 0-1 */
  aggression = 0.5;
  attune: string | null = null;
  phase = 1;
  private readonly client: LiveforgeClient;
  private readonly opts: LiveBossOptions;
  private readonly offs: Unsubscribe[] = [];

  constructor(opts: LiveBossOptions) {
    super();
    if (!opts.client || !opts.id) throw new Error("[liveforge] LiveBoss needs { client, id }");
    this.opts = opts;
    this.client = opts.client;
    this.id = opts.id;
    for (const id of Object.keys(opts.moves ?? {})) this.rotation.push({ id, engine: { moveId: id, params: {} }, weight: 1 });
    const mine = (d: Directive) => d.target === `boss:${this.id}` || (d.args as { boss?: unknown }).boss === this.id;
    this.offs.push(
      this.client.on("boss.move_added", (d) => {
        if (!mine(d)) return;
        this.learn(d.args.move, d.args.engineMove ?? d.args.move.engine);
      }),
      this.client.on("boss.adapt", (d) => {
        if (!mine(d)) return;
        if (typeof d.args.aggression === "number") this.aggression = d.args.aggression;
        if (d.args.attune !== undefined) this.attune = d.args.attune ?? null;
        if (d.args.weights) for (const r of this.rotation) if (d.args.weights[r.id] !== undefined) r.weight = d.args.weights[r.id];
        this.emit("adapt", { aggression: this.aggression, attune: this.attune, weights: Object.fromEntries(this.rotation.map((r) => [r.id, r.weight])) });
        if (d.args.taunt) this.sayTaunt(d.args.taunt);
      }),
    );
  }

  /** Asks the Director for a phase plan (`director.boss_phase`) and applies it (instant, then the AI upgrade). */
  requestPhase(phase: number, opts: { hp?: number; habits?: Record<string, unknown>; gear?: string[] } = {}): AskHandle<"director.boss_phase"> {
    this.phase = phase;
    const h = this.client.ask("director.boss_phase", {
      boss: this.id,
      phase,
      existing: this.rotation.map((r) => r.id),
      ...(opts.hp !== undefined ? { hp: opts.hp } : {}),
      ...(opts.habits ? { habits: opts.habits } : {}),
      ...(opts.gear ? { gear: opts.gear } : {}),
    });
    void h.instant.then((r) => this.applyPlan(r.result.moves, r.result.aggression, r.result.counters ?? [], r.result.taunt, r.why, "instant")).catch(() => {});
    h.onUpgrade((r) => this.applyPlan(r.result.moves, r.result.aggression, r.result.counters ?? [], r.result.taunt, r.why, "upgrade"));
    return h;
  }

  /** Adds a move to the rotation (also called for `boss.move_added`). */
  learn(move: MoveSpec, engine?: EngineMoveRef): void {
    const id = engine?.moveId ?? move.name;
    const existing = this.rotation.find((r) => r.id === id || r.grammar?.name === move.name);
    if (existing) {
      existing.grammar = move;
      if (engine) existing.engine = engine;
    } else {
      this.rotation.push({ id, grammar: move, ...(engine ? { engine } : {}), weight: 1 });
    }
    this.emit("move_added", move, engine);
    if (move.taunt) this.sayTaunt(move.taunt);
  }

  /** Runs a move by id (engine move id or grammar name). Returns false when unknown. */
  perform(id: string): boolean {
    const entry = this.rotation.find((r) => r.id === id) ?? (this.opts.moves?.[id] ? { id, engine: { moveId: id, params: {} }, weight: 1 } : undefined);
    if (!entry) return false;
    this.run(entry);
    return true;
  }

  /** Picks a move by weight (`rng` 0-1, default Math.random) and runs it. Returns it, or undefined when empty. */
  performNext(rng: () => number = Math.random): RotationEntry | undefined {
    const pool = this.rotation.filter((r) => r.weight > 0);
    if (!pool.length) return undefined;
    const total = pool.reduce((n, r) => n + r.weight, 0);
    let x = rng() * total;
    const pick = pool.find((r) => (x -= r.weight) <= 0) ?? pool[pool.length - 1];
    this.run(pick);
    return pick;
  }

  /** Signal helpers (source = this boss). */
  dodged(direction?: string, attack?: string): void {
    this.client.signal("combat.dodged", { source: this.id, ...(direction ? { direction } : {}), ...(attack ? { attack } : {}) });
  }
  hit(damage: number, extra: { weapon?: string; element?: string; crit?: boolean; range?: number } = {}): void {
    this.client.signal("combat.hit", { target: this.id, target_type: "boss", damage, ...extra });
  }
  hurt(damage: number, hp: number, attack?: string): void {
    this.client.signal("combat.hurt", { source: this.id, source_type: "boss", damage, hp, ...(attack ? { attack } : {}) });
  }
  blocked(attack?: string): void {
    this.client.signal("combat.blocked", { source: this.id, ...(attack ? { attack } : {}) });
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.clear();
  }

  private run(entry: RotationEntry): void {
    const engineId = entry.engine?.moveId;
    const handler = engineId ? this.opts.moves?.[engineId] : undefined;
    if (handler) handler(entry.engine?.params ?? {}, entry.grammar);
    else if (entry.grammar) this.opts.onGrammarMove?.(entry.grammar);
    this.emit("performed", entry);
  }

  private applyPlan(moves: BossMovePlan[], aggression: number, counters: string[], taunt: string | undefined, why: string | undefined, stage: "instant" | "upgrade"): void {
    const known = new Set(this.rotation.map((r) => r.id));
    const next: RotationEntry[] = [];
    for (const m of moves) {
      const engine = m.engine ?? m.grammar?.engine;
      const id = engine?.moveId ?? m.grammar?.name;
      if (!id) continue;
      next.push({ id, weight: m.weight, ...(engine ? { engine } : {}), ...(m.grammar ? { grammar: m.grammar } : {}) });
      if (m.grammar && !known.has(id)) this.emit("move_added", m.grammar, engine);
    }
    if (next.length) this.rotation = next;
    this.aggression = aggression;
    this.emit("phase", { phase: this.phase, rotation: this.rotation, aggression, counters, ...(why ? { why } : {}), stage });
    if (taunt) this.sayTaunt(taunt);
  }

  private sayTaunt(text: string): void {
    this.emit("taunt", text);
    if (this.opts.speakTaunts) void speak(text, { ...(this.opts.voice ? { voice: this.opts.voice } : {}) });
  }
}

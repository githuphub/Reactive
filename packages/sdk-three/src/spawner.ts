// LiveSpawner: turns `spawn.wave` directives into your spawn calls, honours `pacing.breather`.
import * as THREE from "three";
import type { Directive, DirectiveArgs } from "@liveforge/protocol";
import { Emitter, type LiveforgeClient, type Unsubscribe } from "@liveforge/sdk";

export type SpawnWaveArgs = DirectiveArgs<"spawn.wave">;
export type SpawnUnit = SpawnWaveArgs["units"][number];

/** What your spawn function receives for each unit instance. */
export interface SpawnRequest {
  type: string;
  elite: boolean;
  modifiers: string[];
  tactic?: string;
  /** World position (spawner position / wave position + spread). */
  position: THREE.Vector3;
  /** Index within its unit group. */
  index: number;
  wave: SpawnWaveArgs;
}

export interface LiveSpawnerOptions {
  client: LiveforgeClient;
  /** Spawner id (directives target `spawner:<id>` or set `args.spawner`). */
  id: string;
  /** Zone this spawner serves (waves with `args.zone` equal to it are accepted). */
  zone?: string;
  /** Create one unit. Return its object to have it tracked in `spawned`. */
  spawn: (req: SpawnRequest) => THREE.Object3D | void;
  /** Where units appear: a position or an object (its world position). Default origin. */
  at?: THREE.Vector3 | THREE.Object3D;
  /** Random scatter radius (m). Default 2. */
  spread?: number;
  /** Also accept waves that name no spawner and no zone. Default false (avoids double spawns with many spawners). */
  catchAll?: boolean;
  /** Cap on units per wave (safety). Default 50. */
  maxPerWave?: number;
}

type SpawnerEvents = {
  wave: (wave: SpawnWaveArgs, directive: Directive) => void;
  spawned: (object: THREE.Object3D, req: SpawnRequest) => void;
  /** A breather started (seconds) / ended (0). */
  breather: (seconds: number) => void;
};

/**
 * Directive-driven spawner.
 *
 * ```ts
 * new LiveSpawner({ client: lf, id: "yard", at: yardMarker, spawn: (u) => makeGoblin(u.type, u.elite, u.position) });
 * ```
 */
export class LiveSpawner extends Emitter<SpawnerEvents> {
  readonly id: string;
  /** Objects returned by your spawn function (remove them yourself when they die). */
  readonly spawned: THREE.Object3D[] = [];
  private readonly opts: LiveSpawnerOptions;
  private readonly offs: Unsubscribe[] = [];
  private breatherUntil = 0;
  private breatherTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly deferred: Array<{ wave: SpawnWaveArgs; d: Directive }> = [];

  constructor(opts: LiveSpawnerOptions) {
    super();
    if (!opts.client || !opts.id || typeof opts.spawn !== "function") throw new Error("[liveforge] LiveSpawner needs { client, id, spawn }");
    this.opts = opts;
    this.id = opts.id;
    this.offs.push(
      opts.client.on("spawn.wave", (d) => {
        if (!this.accepts(d)) return;
        if (this.paused) this.deferred.push({ wave: d.args, d });
        else this.runWave(d.args, d);
      }),
      opts.client.on("pacing.breather", (d) => {
        if (d.target.startsWith("spawner:") && d.target !== `spawner:${this.id}`) return;
        this.breathe(d.args.seconds);
      }),
    );
  }

  /** True during a breather (waves are deferred until it ends). */
  get paused(): boolean {
    return Date.now() < this.breatherUntil;
  }

  /** Starts a breather locally (also triggered by `pacing.breather`). */
  breathe(seconds: number): void {
    this.breatherUntil = Date.now() + seconds * 1000;
    this.emit("breather", seconds);
    if (this.breatherTimer) clearTimeout(this.breatherTimer);
    this.breatherTimer = setTimeout(() => {
      this.breatherTimer = null;
      this.emit("breather", 0);
      const waves = this.deferred.splice(0);
      for (const w of waves) this.runWave(w.wave, w.d);
    }, seconds * 1000);
  }

  /** Spawns a wave now (also used for directives). */
  runWave(wave: SpawnWaveArgs, directive?: Directive): void {
    if (directive) this.emit("wave", wave, directive);
    const base = new THREE.Vector3();
    if (wave.position) base.set(...wave.position);
    else if (this.opts.at instanceof THREE.Vector3) base.copy(this.opts.at);
    else if (this.opts.at) this.opts.at.getWorldPosition(base);
    const spread = this.opts.spread ?? 2;
    let budget = this.opts.maxPerWave ?? 50;
    for (const unit of wave.units) {
      for (let i = 0; i < unit.count && budget > 0; i++, budget--) {
        const a = Math.random() * Math.PI * 2;
        const r = spread * Math.sqrt(Math.random());
        const req: SpawnRequest = {
          type: unit.type,
          elite: !!unit.elite,
          modifiers: unit.modifiers ?? [],
          ...(unit.tactic ? { tactic: unit.tactic } : {}),
          position: base.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)),
          index: i,
          wave,
        };
        try {
          const obj = this.opts.spawn(req);
          if (obj) {
            this.spawned.push(obj);
            this.emit("spawned", obj, req);
          }
        } catch (err) {
          console.error("[liveforge] LiveSpawner spawn() threw", err);
        }
      }
    }
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs.length = 0;
    if (this.breatherTimer) clearTimeout(this.breatherTimer);
    this.clear();
  }

  private accepts(d: Directive): boolean {
    const a = d.args as SpawnWaveArgs;
    if (d.target === `spawner:${this.id}` || a.spawner === this.id) return true;
    if (a.spawner) return false;
    if (a.zone) return a.zone === this.opts.zone;
    return !!this.opts.catchAll && !d.target.startsWith("spawner:");
  }
}

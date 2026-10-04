/**
 * VillagerController: the async action API for one villager (or the golem). Reactive agent tools
 * (V3) map onto these methods one-to-one.
 *
 * Every method:
 * - is async and resolves when the action is finished, with `{ ok, detail, data? }`;
 * - never throws on normal failure (unreachable target, unknown block, nobody to trade with...);
 * - is cancellable with `cancel()` or an `AbortSignal` (`opts.signal`);
 * - can report progress through `opts.onProgress`.
 *
 * Body actions (walkTo, mine, place, gather, give, take, guard, buildPlan) replace each other: a
 * new one cancels the running one. Overlay actions (say, lookAt, emote, wait) run alongside.
 * Agent actions (default priority) pause the villager's daily schedule; schedule actions never
 * interrupt agent actions. `follow` and `guard` are persistent modes that last until
 * `stopFollow()`, `cancel()` or another movement action.
 */
import { BLOCK, BLOCK_FLAGS, F_SOLID, blockById, findBlock, type BlockDef } from '../../engine/blocks';
import { computeDrops, findItem, breakTime } from '../../engine/items';
import type { Entity } from '../../engine/entity';
import type { BlockSource } from '../../game/events';
import type { Vec3Like } from '../nav';
import type { Village } from '../village';
import { blockColor } from './effects';
import type { Npc } from './npc';

/** Result of every controller action. */
export interface ActionResult {
  ok: boolean;
  /** One human-readable line (good for agent tool results and Brain View). */
  detail: string;
  data?: Record<string, unknown>;
}

export interface ActionProgress {
  action: string;
  done: number;
  total: number;
  detail?: string;
}

export interface ActionOptions {
  onProgress?: (p: ActionProgress) => void;
  /** Aborting cancels the action (resolves with ok: false). */
  signal?: AbortSignal;
  /** 'agent' (default) pauses the schedule; 'schedule' never interrupts an agent action. */
  priority?: 'agent' | 'schedule';
}

/**
 * A target: a named spot ('gate', 'well', 'plaza', 'tower', 'mara_house', 'bram_plot', 'yard',
 * 'home', 'work', a building id), an NPC id or name, 'player', "x,y,z", a point, or anything with
 * a `position`.
 */
export type Target = string | Vec3Like | { position: Vec3Like };

/** One block of an expanded voxel plan (Reactive `expandVoxelPlan` output). */
export interface PlanBlock {
  x: number;
  y: number;
  z: number;
  /** Block id; "air" clears the cell. */
  block: string;
  facing?: 'north' | 'east' | 'south' | 'west';
  /** Raw 4-bit metadata (overrides `facing`). */
  meta?: number;
}

export interface ExpandedPlanLike {
  blocks: PlanBlock[];
  materials?: Record<string, number>;
}

export interface BuildOptions extends ActionOptions {
  /** Added to every block (omit when blocks are already in world coordinates). */
  origin?: Vec3Like;
  /** Placement rate while in reach. Default 6. */
  blocksPerSecond?: number;
  /** Build temporary dirt pillars to reach high blocks (removed afterwards). Default true. */
  scaffold?: boolean;
  /** Walk to the builder's yard piles for missing materials first. Default true. */
  fetchMaterials?: boolean;
  /** Block source on the edits. Default 'village'. */
  source?: BlockSource;
  /** Reach in blocks from the eye. Default 5. */
  reach?: number;
  /** Narrate in speech bubbles (builders). Default true. */
  narrate?: boolean;
  /** Register the result as an owned building (ownerAt, repair tracking). */
  registerAs?: { id: string; owner?: string; kind?: string; name?: string };
}

export interface WalkOptions extends ActionOptions {
  run?: boolean;
  /** Stop within this distance (default 1.5). */
  reach?: number;
}

/** Thrown inside actions to unwind on cancel; never escapes the controller. */
class Cancelled extends Error {}

class Token {
  cancelled = false;
  reason = '';
  constructor(readonly action: string, readonly priority: 'agent' | 'schedule', signal?: AbortSignal) {
    if (signal) {
      if (signal.aborted) this.cancel('aborted');
      else signal.addEventListener('abort', () => this.cancel('aborted'), { once: true });
    }
  }
  cancel(reason: string): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.reason = reason;
  }
}

/** A target resolved to a (possibly moving) point. */
export interface ResolvedTarget {
  label: string;
  pos(): Vec3Like;
  moving: boolean;
  entity?: { position: Vec3Like };
}

type Mode =
  | { kind: 'follow'; target: ResolvedTarget; distance: number; repath: number; agent: boolean }
  | { kind: 'guard'; at: Vec3Like; label: string; agent: boolean };

const FACING: Record<string, number> = { north: 0, east: 1, south: 2, west: 3 };
const FDX = [0, 1, 0, -1], FDZ = [-1, 0, 1, 0];
/** Seconds after an agent action before the daily schedule takes over again. */
export const AGENT_GRACE = 45;

const ok = (detail: string, data?: Record<string, unknown>): ActionResult => ({ ok: true, detail, data });
const fail = (detail: string, data?: Record<string, unknown>): ActionResult => ({ ok: false, detail, data });

export class VillagerController {
  private body: Token | null = null;
  private readonly overlays = new Set<Token>();
  private mode: Mode | null = null;
  private clock = 0;
  private lastAgent = -Infinity;
  private attackCooldown = 0;
  private combatTarget: Entity | null = null;
  private combatRepath = 0;

  constructor(readonly npc: Npc, private readonly v: Village) {}

  // -- state ---------------------------------------------------------------------------------

  /** The running body action, mode, or 'idle'. */
  get activity(): string {
    return this.body?.action ?? (this.mode ? (this.mode.kind === 'follow' ? `following ${this.mode.target.label}` : `guarding ${this.mode.label}`) : 'idle');
  }

  /** True while a body action runs. */
  get busy(): boolean {
    return this.body !== null;
  }

  /** True while an agent drives this villager (or did so in the last {@link AGENT_GRACE} s). */
  get agentControlled(): boolean {
    return this.body?.priority === 'agent' || (this.mode?.agent ?? false) || this.clock - this.lastAgent < AGENT_GRACE;
  }

  /** Current persistent mode. */
  get currentMode(): 'follow' | 'guard' | null {
    return this.mode?.kind ?? null;
  }

  /** Lets the schedule take over immediately (clears the agent grace period). */
  releaseToSchedule(): void {
    this.lastAgent = -Infinity;
  }

  // -- movement --------------------------------------------------------------------------------

  /** Walks (or runs) to a target. Resolves on arrival. */
  walkTo(target: Target, opts: WalkOptions = {}): Promise<ActionResult> {
    return this.run('walkTo', opts, true, async (tok) => {
      const t = this.v.resolveTarget(target, this.npc);
      if (!t) return fail(`don't know where "${describe(target)}" is`);
      this.clearMode();
      return this.goto(tok, t, { reach: opts.reach ?? 1.5, run: opts.run });
    });
  }

  /** Turns to look at a target (overlay). */
  lookAt(target: Target, opts: ActionOptions = {}): Promise<ActionResult> {
    return this.run('lookAt', opts, false, async (tok) => {
      const t = this.v.resolveTarget(target, this.npc);
      if (!t) return fail(`don't know where "${describe(target)}" is`);
      const p = t.pos();
      this.npc.lookAtTarget(t.entity ?? p, 4);
      if (!this.npc.moving) this.npc.face(p.x, p.z);
      await this.sleep(tok, 0.35);
      return ok(`looking at ${t.label}`);
    });
  }

  /** Follows a target at `distance` until stopFollow()/cancel(). Resolves once following starts. */
  follow(target: Target, opts: ActionOptions & { distance?: number } = {}): Promise<ActionResult> {
    return this.run('follow', opts, true, async () => {
      const t = this.v.resolveTarget(target, this.npc);
      if (!t) return fail(`don't know who "${describe(target)}" is`);
      this.mode = { kind: 'follow', target: t, distance: Math.max(1.5, opts.distance ?? 3), repath: 0, agent: (opts.priority ?? 'agent') === 'agent' };
      return ok(`following ${t.label}`);
    });
  }

  /** Stops following. */
  async stopFollow(): Promise<ActionResult> {
    if (this.mode?.kind !== 'follow') return ok('was not following anyone');
    const label = this.mode.target.label;
    this.mode = null;
    this.npc.stopMoving();
    this.lastAgent = this.clock;
    return ok(`stopped following ${label}`);
  }

  /** Walks to a post (or point) and stands guard there; guards fight hostiles nearby. */
  guard(post: Target, opts: ActionOptions = {}): Promise<ActionResult> {
    return this.run('guard', opts, true, async (tok) => {
      const t = this.v.resolveTarget(post, this.npc);
      if (!t) return fail(`there is no post called "${describe(post)}"`);
      this.clearMode();
      const r = await this.goto(tok, t, { reach: 1.2, run: true });
      if (!r.ok) return r;
      this.mode = { kind: 'guard', at: { ...t.pos() }, label: t.label, agent: (opts.priority ?? 'agent') === 'agent' };
      if (this.npc.def.guard && !this.npc.isGolem) this.npc.swordDrawn = true;
      return ok(`guarding ${t.label}`);
    });
  }

  /** Waits (overlay; does not stop following or guarding). */
  wait(seconds: number, opts: ActionOptions = {}): Promise<ActionResult> {
    return this.run('wait', opts, false, async (tok) => {
      const s = Math.max(0, Math.min(120, Number(seconds) || 0));
      await this.sleep(tok, s);
      return ok(`waited ${s.toFixed(1)} s`);
    });
  }

  // -- speech and emotes -----------------------------------------------------------------------

  /** Says a line in a speech bubble (typewriter). Resolves when it has been read. */
  say(text: string, opts: ActionOptions & { emote?: string; seconds?: number } = {}): Promise<ActionResult> {
    return this.run('say', opts, false, async (tok) => {
      const line = String(text ?? '').trim().slice(0, 400);
      if (!line) return fail('nothing to say');
      this.npc.wake();
      if (opts.emote) this.npc.playEmote(opts.emote, 1.8);
      const bubble = this.npc.bubble;
      if (!bubble) return ok(`said "${line}"`);
      const done = bubble.say(line, { seconds: opts.seconds });
      let finished = false;
      void done.then(() => (finished = true));
      while (!finished) await this.frame(tok);
      return ok(`said "${line}"`);
    });
  }

  /**
   * Plays an emote: wave, nod, shake, think, cheer, hammer, glare, stare, laugh, shrug, bow, cry,
   * and for the golem creak, stamp, offer_flower. Unknown kinds play a generic gesture.
   */
  emote(kind: string, opts: ActionOptions & { seconds?: number } = {}): Promise<ActionResult> {
    return this.run('emote', opts, false, async (tok) => {
      const k = String(kind || 'nod').toLowerCase().replace(/\s+/g, '_');
      const dur = Math.max(0.6, Math.min(8, opts.seconds ?? (k === 'offer_flower' ? 3 : 1.8)));
      this.npc.wake();
      this.npc.playEmote(k, dur);
      if (this.npc.bubble && (!this.npc.bubble.speaking || this.npc.isGolem)) void this.npc.bubble.say(EMOTE_TEXT[k] ?? k.replace(/_/g, ' '), { emote: true, seconds: dur });
      await this.sleep(tok, dur);
      return ok(`${k}`);
    });
  }

  // -- blocks ----------------------------------------------------------------------------------

  /** Walks within reach and mines one block (drops go to the villager's bag). */
  mine(pos: Vec3Like, opts: ActionOptions = {}): Promise<ActionResult> {
    return this.run('mine', opts, true, async (tok) => {
      this.clearMode();
      return this.mineAt(tok, Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), 'village');
    });
  }

  /** Walks within reach and places one block (`facing` for doors/furnaces, torches attach to walls). */
  place(pos: Vec3Like, block: string, opts: ActionOptions & { facing?: PlanBlock['facing']; meta?: number; source?: BlockSource } = {}): Promise<ActionResult> {
    return this.run('place', opts, true, async (tok) => {
      this.clearMode();
      const def = this.v.blockDef(block);
      if (!def) return fail(`unknown block "${block}"`);
      const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
      const world = this.v.game.world;
      if (world.getBlock(x, y, z) === def.id) return ok(`${def.name} is already there`);
      if (!world.isReplaceable(x, y, z) && world.getBlock(x, y, z) !== BLOCK.air) return fail(`${world.getBlockName(x, y, z)} is in the way at ${x},${y},${z}`);
      const r = await this.reachBlock(tok, x, y, z, 4.6);
      if (!r) return fail(`can't reach ${x},${y},${z}`);
      if (def.solid && this.playerIn(x, y, z)) return fail('the player is standing there');
      await this.stepOff(tok, x, y, z, def);
      this.putBlock(x, y, z, def, opts.meta ?? null, opts.facing ? FACING[opts.facing] : null, opts.source ?? 'village');
      await this.sleep(tok, 0.2);
      return ok(`placed ${def.name} at ${x},${y},${z}`);
    });
  }

  /**
   * Gathers a material: builder materials come from the yard piles (unlimited in the demo), wheat
   * is harvested (and replanted) on the farms, anything else is mined nearby.
   */
  gather(block: string, count: number, opts: ActionOptions & { near?: Target; fromWorld?: boolean; radius?: number } = {}): Promise<ActionResult> {
    return this.run('gather', opts, true, async (tok) => {
      this.clearMode();
      const name = this.v.normalizeBlock(block);
      const n = Math.max(1, Math.min(512, Math.floor(Number(count) || 1)));
      if (name === 'wheat') return this.harvest(tok, n, opts);
      if (!opts.fromWorld && this.v.yard && this.v.isYardMaterial(name)) return this.fetchFromYard(tok, [[name, n]], opts);
      const def = findBlock(name);
      if (!def || def.id === BLOCK.air) return fail(`unknown material "${block}"`);
      const near = opts.near ? this.v.resolveTarget(opts.near, this.npc)?.pos() : this.npc.position;
      const found = this.v.findExposed(def.id, near ?? this.npc.position, opts.radius ?? 20, n * 2);
      if (!found.length) return fail(`no ${name} nearby`);
      let got = 0;
      for (const p of found) {
        if (got >= n) break;
        const r = await this.mineAt(tok, p.x, p.y, p.z, 'village');
        if (r.ok) got++;
        opts.onProgress?.({ action: 'gather', done: got, total: n, detail: name });
      }
      return got > 0 ? ok(`gathered ${got}/${n} ${name}`, { count: got }) : fail(`couldn't gather any ${name}`);
    });
  }

  /** Walks to someone and gives them items (the player gets them in the inventory). */
  give(item: string, count = 1, to: Target = 'player', opts: ActionOptions = {}): Promise<ActionResult> {
    return this.run('give', opts, true, async (tok) => {
      this.clearMode();
      const name = this.v.normalizeItem(item);
      const def = findItem(name);
      if (!def) return fail(`unknown item "${item}"`);
      const n = Math.max(1, Math.min(64 * 9, Math.floor(Number(count) || 1)));
      const t = this.v.resolveTarget(to, this.npc);
      if (!t) return fail(`don't know who "${describe(to)}" is`);
      const r = await this.goto(tok, t, { reach: 2.4 });
      if (!r.ok) return fail(`couldn't reach ${t.label} to give ${name}`);
      const p = t.pos();
      this.npc.face(p.x, p.z);
      this.npc.swing();
      this.npc.carry(def.block !== null ? blockColor(def.block) : 0xd8c27a);
      await this.sleep(tok, 0.5);
      this.npc.carry(null);
      let given = n;
      if (t.entity === this.v.game.player) {
        const left = this.v.game.inventory.add({ item: name, count: n });
        given = n - left;
        this.v.game.ui.toast(`${this.npc.def.name} gave you ${given} ${def.displayName}`, { kind: 'good' });
      } else if (t.entity && (t.entity as Npc).bag) addBag((t.entity as Npc).bag, name, n);
      takeBag(this.npc.bag, name, n);
      return given > 0 ? ok(`gave ${given} ${name} to ${t.label}`, { count: given }) : fail(`${t.label} has no room for ${name}`);
    });
  }

  /** Walks to someone and takes items they hold (from the player's inventory). */
  take(item: string, count = 1, from: Target = 'player', opts: ActionOptions = {}): Promise<ActionResult> {
    return this.run('take', opts, true, async (tok) => {
      this.clearMode();
      const name = this.v.normalizeItem(item);
      const n = Math.max(1, Math.floor(Number(count) || 1));
      const t = this.v.resolveTarget(from, this.npc);
      if (!t) return fail(`don't know who "${describe(from)}" is`);
      const r = await this.goto(tok, t, { reach: 2.4 });
      if (!r.ok) return fail(`couldn't reach ${t.label}`);
      const p = t.pos();
      this.npc.face(p.x, p.z);
      let took = 0;
      if (t.entity === this.v.game.player) {
        const inv = this.v.game.inventory;
        took = Math.min(n, inv.count(name));
        if (took <= 0) return fail(`${t.label} has no ${name}`);
        inv.remove(name, took);
        this.v.game.ui.toast(`${this.npc.def.name} took ${took} ${findItem(name)?.displayName ?? name}`);
      } else if (t.entity && (t.entity as Npc).bag) {
        took = Math.min(n, (t.entity as Npc).bag.get(name) ?? 0);
        if (took <= 0) return fail(`${t.label} has no ${name}`);
        takeBag((t.entity as Npc).bag, name, took);
      } else return fail(`can't take from ${t.label}`);
      addBag(this.npc.bag, name, took);
      this.npc.swing();
      await this.sleep(tok, 0.4);
      return ok(`took ${took} ${name} from ${t.label}`, { count: took });
    });
  }

  // -- trade -----------------------------------------------------------------------------------

  /** Opens the trade screen for the player (traders only). Resolves once open, or on close with `waitForClose`. */
  trade(opts: ActionOptions & { priceMultiplier?: number; waitForClose?: boolean } = {}): Promise<ActionResult> {
    return this.run('trade', opts, false, async (tok) => {
      if (!this.npc.def.trader) return fail(`${this.npc.def.name} doesn't trade`);
      const session = this.v.openTrade(this.npc, { priceMultiplier: opts.priceMultiplier });
      if (!session) return fail('the trade screen could not open');
      if (!opts.waitForClose) return ok(`opened trade (prices ×${session.multiplier.toFixed(2)})`, { multiplier: session.multiplier });
      let closed = false;
      let summary = '';
      void session.closed.then((s) => {
        closed = true;
        summary = s;
      });
      while (!closed) await this.frame(tok);
      return ok(summary || 'trade closed');
    });
  }

  // -- building --------------------------------------------------------------------------------

  /**
   * Builds an expanded voxel plan block by block in the given order: walks into reach, swings,
   * places with particles, scaffolds high blocks with temporary dirt pillars (removed after), and
   * fetches missing materials from the builder's yard first (unlimited in the demo).
   */
  buildPlan(plan: ExpandedPlanLike, opts: BuildOptions = {}): Promise<ActionResult> {
    return this.run('buildPlan', opts, true, async (tok) => {
      this.clearMode();
      if (!plan || !Array.isArray(plan.blocks)) return fail('no plan blocks');
      const o = opts.origin ?? { x: 0, y: 0, z: 0 };
      const world = this.v.game.world;
      const source = opts.source ?? 'village';
      const bps = Math.max(0.5, Math.min(60, opts.blocksPerSecond ?? 6));
      const reach = opts.reach ?? 5;
      const warnings = new Set<string>();
      interface Job { x: number; y: number; z: number; def: BlockDef; meta: number | null; facing: number | null; air: boolean; defers: number }
      const jobs: Job[] = [];
      for (const b of plan.blocks) {
        const name = this.v.normalizeBlock(b.block);
        const air = name === 'air';
        let def = air ? blockById(BLOCK.air) : this.v.blockDef(name);
        if (!def) {
          warnings.add(`unknown block "${b.block}" → oak_planks`);
          def = blockById(BLOCK.oak_planks);
        }
        jobs.push({
          x: Math.floor(b.x + o.x), y: Math.floor(b.y + o.y), z: Math.floor(b.z + o.z),
          def, meta: typeof b.meta === 'number' ? b.meta & 15 : null, facing: b.facing ? FACING[b.facing] ?? null : null, air, defers: 0,
        });
      }
      const total = jobs.length;
      if (!total) return ok('nothing to build', { placed: 0, total: 0 });
      let minY = Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, maxY = -Infinity;
      for (const j of jobs) {
        if (j.air) continue;
        minY = Math.min(minY, j.y); maxY = Math.max(maxY, j.y);
        x0 = Math.min(x0, j.x); x1 = Math.max(x1, j.x); z0 = Math.min(z0, j.z); z1 = Math.max(z1, j.z);
      }
      if (!Number.isFinite(minY)) { minY = jobs[0].y; maxY = minY; x0 = x1 = jobs[0].x; z0 = z1 = jobs[0].z; }
      const footprint = { x0, x1, z0, z1 };
      const progress = (done: number, detail: string) => opts.onProgress?.({ action: 'buildPlan', done, total, detail });
      const lines = opts.narrate !== false ? this.npc.def.buildLines ?? [] : [];
      const narrate = (i: number) => {
        if (lines.length && this.npc.bubble && !this.npc.bubble.speaking) void this.npc.bubble.say(lines[Math.min(i, lines.length - 1)]);
      };

      if (opts.fetchMaterials !== false) {
        const need = new Map<string, number>();
        for (const j of jobs) if (!j.air && world.getBlock(j.x, j.y, j.z) !== j.def.id) need.set(j.def.name, (need.get(j.def.name) ?? 0) + 1);
        for (const [k, have] of this.npc.bag) if (need.has(k)) need.set(k, Math.max(0, need.get(k)! - have));
        const list = [...need].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
        if (list.length) {
          progress(0, 'fetching materials');
          const res = await this.fetchFromYard(tok, list, opts, true);
          if (!res.ok) for (const [k, c] of list) addBag(this.npc.bag, k, c);
        }
      }
      narrate(0);
      const placedBlocks: { x: number; y: number; z: number; id: number; meta: number }[] = [];
      let done = 0, placed = 0, skipped = 0, said = 1;
      let pillar: Pillar | null = null;
      const queue = jobs.slice();
      try {
        for (let qi = 0; qi < queue.length; qi++) {
          const j = queue[qi];
          const cur = world.getBlock(j.x, j.y, j.z);
          if (j.air) {
            if (cur === BLOCK.air || blockById(cur).renderType === 'door') {
              done++;
              continue;
            }
          } else if (cur === j.def.id && (j.meta === null || world.getMeta(j.x, j.y, j.z) === j.meta)) {
            done++;
            progress(done, j.def.name);
            continue;
          }
          // Get into reach.
          if (!this.inReach(j.x, j.y, j.z, reach)) {
            if (pillar) {
              await this.descend(tok, pillar);
              pillar = null;
            }
            const t = pointTarget({ x: j.x + 0.5, y: j.y + 0.5, z: j.z + 0.5 }, `${j.x},${j.y},${j.z}`);
            await this.goto(tok, t, {
              reach: reach - 0.3, reachFrom: this.npc.eyeHeight, teleport: false, timeout: 10, maxNodes: 2500,
              avoid: (x, y, z) => x === j.x && z === j.z && (y === j.y || y === j.y - 1),
            });
            if (!this.inReach(j.x, j.y, j.z, reach + 0.5) && opts.scaffold !== false && j.y >= minY + 3) {
              pillar = await this.scaffoldTo(tok, j.x, j.y, j.z, footprint, minY);
            }
          }
          if (!j.air && j.def.solid) {
            if (this.playerIn(j.x, j.y, j.z)) {
              if (j.defers < 3) {
                j.defers++;
                queue.push(j);
                if (j.defers === 1 && this.npc.bubble && !this.npc.bubble.speaking) void this.npc.bubble.say('Mind out, coming through!');
                await this.sleep(tok, 0.3);
              } else skipped++;
              continue;
            }
            await this.stepOff(tok, j.x, j.y, j.z, j.def);
          }
          if (j.air) {
            this.npc.face(j.x + 0.5, j.z + 0.5);
            this.npc.swing();
            this.v.particles.burst(j.x + 0.5, j.y + 0.5, j.z + 0.5, blockColor(cur), 8);
            world.setBlock(j.x, j.y, j.z, BLOCK.air, { source, entity: this.npc });
          } else {
            this.putBlock(j.x, j.y, j.z, j.def, j.meta, j.facing, source);
            takeBag(this.npc.bag, j.def.name, 1);
            placedBlocks.push({ x: j.x, y: j.y, z: j.z, id: j.def.id, meta: world.getMeta(j.x, j.y, j.z) });
            placed++;
          }
          done++;
          progress(done, j.air ? 'clearing' : j.def.name);
          const f = done / total;
          if (lines.length > 2 && said === 1 && f >= 0.5) { narrate(Math.floor(lines.length / 2)); said = 2; }
          else if (lines.length > 3 && said === 2 && f >= 0.85) { narrate(lines.length - 2); said = 3; }
          await this.sleep(tok, 1 / bps);
        }
        if (pillar) {
          await this.descend(tok, pillar);
          pillar = null;
        }
      } finally {
        if (pillar) this.dropPillar(pillar, source);
        this.npc.kinematic = false;
        this.npc.carry(null);
      }
      if (opts.registerAs && placedBlocks.length) {
        this.v.registerBuilt({
          id: opts.registerAs.id,
          owner: opts.registerAs.owner ?? this.npc.def.id,
          kind: opts.registerAs.kind ?? 'custom',
          name: opts.registerAs.name ?? opts.registerAs.id,
          blocks: placedBlocks,
        });
      }
      if (lines.length) narrate(lines.length - 1);
      const extra = [skipped ? `${skipped} skipped` : '', ...warnings].filter(Boolean).join('; ');
      return ok(`built ${placed} blocks of ${total}${extra ? ` (${extra})` : ''}`, {
        placed, skipped, total, bounds: { min: [x0, minY, z0], max: [x1, maxY, z1] }, warnings: [...warnings],
      });
    });
  }

  // -- control ---------------------------------------------------------------------------------

  /** Cancels everything: the body action, overlays, follow/guard modes. */
  async cancel(reason = 'cancelled'): Promise<ActionResult> {
    const what = this.activity;
    this.body?.cancel(reason);
    for (const t of this.overlays) t.cancel(reason);
    this.clearMode();
    this.npc.stopMoving();
    this.npc.bubble?.clear();
    return ok(what === 'idle' ? 'nothing to cancel' : `cancelled ${what}`);
  }

  /** @internal Per-frame: follow/guard modes and guard combat. */
  update(dt: number): void {
    this.clock += dt;
    this.attackCooldown -= dt;
    const npc = this.npc;
    if (npc.removed) return;
    // Guards (and the golem) fight hostiles when not busy with an agent body action.
    if (npc.def.guard && !(this.body && this.body.priority === 'agent')) {
      const center = this.mode?.kind === 'guard' ? this.mode.at : npc.position;
      const foe = this.combatTarget && !this.combatTarget.removed && this.combatTarget.position.distanceTo(npc.position) < 22
        ? this.combatTarget
        : this.v.nearestHostile(center, npc.isGolem ? 16 : 14);
      if (foe) {
        if (this.body && this.body.priority === 'schedule') this.body.cancel('fighting');
        this.fight(foe, dt);
        return;
      }
      if (this.combatTarget) {
        this.combatTarget = null;
        npc.stopMoving();
        if (!npc.isGolem && this.v.posture !== 'hostile' && this.mode?.kind !== 'guard') npc.swordDrawn = false;
      }
    }
    const m = this.mode;
    if (!m || this.body) return;
    if (m.kind === 'follow') {
      const p = m.target.pos();
      const d = Math.hypot(p.x - npc.position.x, p.z - npc.position.z);
      m.repath -= dt;
      if (d > 40) {
        this.teleportNear(p, m.distance);
        return;
      }
      if (d > m.distance + 1.2 && (m.repath <= 0 || !npc.moving)) {
        m.repath = 0.8;
        const path = this.v.nav.path(npc.position, p, { reach: m.distance, reachFrom: 0, height: npc.isGolem ? 3 : 2, partial: true, maxNodes: 2500 });
        if (path && path.length) npc.followPath(path, d > 8);
      } else if (d <= m.distance) {
        npc.stopMoving();
        npc.lookAtTarget(m.target.entity ?? p, 1);
      }
    } else if (m.kind === 'guard') {
      const d = Math.hypot(m.at.x - npc.position.x, m.at.z - npc.position.z);
      if (d > 2.5 && !npc.moving) {
        const path = this.v.nav.path(npc.position, m.at, { reach: 1, reachFrom: 0, height: npc.isGolem ? 3 : 2, partial: true, maxNodes: 2500 });
        if (path && path.length) npc.followPath(path, false);
      }
    }
  }

  // -- internals -------------------------------------------------------------------------------

  private clearMode(): void {
    this.mode = null;
    if (!this.npc.isGolem && this.v.posture !== 'hostile') this.npc.swordDrawn = false;
  }

  private async run(action: string, opts: ActionOptions, isBody: boolean, fn: (tok: Token) => Promise<ActionResult>): Promise<ActionResult> {
    const pr = opts.priority ?? 'agent';
    if (isBody) {
      if (this.body) {
        if (this.body.priority === 'agent' && pr === 'schedule') return fail(`${this.npc.def.name} is busy (${this.body.action})`, { busy: true });
        this.body.cancel(`interrupted by ${action}`);
      }
      if (pr === 'schedule' && this.mode?.agent) return fail(`${this.npc.def.name} is ${this.activity}`, { busy: true });
    }
    const tok = new Token(action, pr, opts.signal);
    if (isBody) this.body = tok;
    else this.overlays.add(tok);
    if (pr === 'agent') this.lastAgent = this.clock;
    let res: ActionResult;
    try {
      res = await fn(tok);
    } catch (err) {
      if (err instanceof Cancelled || tok.cancelled) res = fail(`${action} cancelled (${tok.reason || 'cancelled'})`, { cancelled: true });
      else {
        console.error(`[village] ${this.npc.def.id}.${action} failed`, err);
        res = fail(`${action} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (isBody && this.body === tok) {
      this.body = null;
      if (!this.mode) this.npc.stopMoving();
    }
    this.overlays.delete(tok);
    if (pr === 'agent') {
      this.lastAgent = this.clock;
      this.v.emitAction(this.npc, action, res);
    }
    return res;
  }

  private async frame(tok: Token): Promise<number> {
    if (tok.cancelled) throw new Cancelled(tok.reason);
    const dt = await this.v.frame();
    if (tok.cancelled) throw new Cancelled(tok.reason);
    return dt;
  }

  private async sleep(tok: Token, seconds: number): Promise<void> {
    let t = 0;
    while (t < seconds) t += await this.frame(tok);
  }

  /** Distance from the NPC's eye to a block centre. */
  private inReach(x: number, y: number, z: number, reach: number): boolean {
    const p = this.npc.position;
    return Math.hypot(p.x - (x + 0.5), p.y + this.npc.eyeHeight - (y + 0.5), p.z - (z + 0.5)) <= reach;
  }

  private async reachBlock(tok: Token, x: number, y: number, z: number, reach: number): Promise<boolean> {
    if (this.inReach(x, y, z, reach)) return true;
    await this.goto(tok, pointTarget({ x: x + 0.5, y: y + 0.5, z: z + 0.5 }, `${x},${y},${z}`), {
      reach: reach - 0.3, reachFrom: this.npc.eyeHeight, teleport: false, timeout: 15,
      avoid: (ax, ay, az) => ax === x && az === z && (ay === y || ay === y - 1),
    });
    return this.inReach(x, y, z, reach + 0.6);
  }

  /** Path-follows to a target with re-pathing, stuck detection and a short-hop fallback. */
  private async goto(
    tok: Token,
    t: ResolvedTarget,
    o: { reach: number; run?: boolean; reachFrom?: number; avoid?: (x: number, y: number, z: number) => boolean; teleport?: boolean; timeout?: number; maxNodes?: number },
  ): Promise<ActionResult> {
    const npc = this.npc;
    npc.wake();
    const world = this.v.game.world;
    const reachFrom = o.reachFrom ?? 0;
    const height = npc.isGolem ? 3 : 2;
    const dist = () => {
      const g = t.pos();
      return Math.hypot(npc.position.x - g.x, npc.position.y + reachFrom - g.y, npc.position.z - g.z);
    };
    const start = t.pos();
    const timeout = o.timeout ?? 10 + Math.hypot(start.x - npc.position.x, start.z - npc.position.z) * 1.2;
    let elapsed = 0, attempts = 0;
    while (elapsed < timeout && attempts < 5) {
      if (dist() <= o.reach) {
        npc.stopMoving();
        return ok(`arrived at ${t.label}`);
      }
      const goal = t.pos();
      if (!world.isLoaded(npc.position.x, npc.position.z) || !world.isLoaded(goal.x, goal.z)) break;
      const path = this.v.nav.path(npc.position, goal, { reach: o.reach, reachFrom: reachFrom, height, avoid: o.avoid, partial: true, maxNodes: o.maxNodes });
      if (!path || path.length === 0) {
        attempts++;
        elapsed += await this.waitFrames(tok, 0.25);
        continue;
      }
      npc.followPath(path, o.run);
      let seg = 0;
      while (npc.moving) {
        const dt = await this.frame(tok);
        seg += dt;
        elapsed += dt;
        if (dist() <= o.reach) break;
        if (t.moving && seg > 1) break;
        if (npc.stuckTime > 1.5 || elapsed > timeout) break;
      }
      if (npc.stuckTime > 1.5) {
        npc.stuckTime = 0;
        attempts++;
      } else if (!t.moving && !npc.moving && dist() > o.reach) attempts++;
    }
    npc.stopMoving();
    if (dist() <= o.reach + 0.4) return ok(`arrived at ${t.label}`);
    if (o.teleport !== false && dist() < 96 && this.teleportNear(t.pos(), Math.max(0.5, o.reach - 0.5), reachFrom)) return ok(`arrived at ${t.label} (took a shortcut)`);
    return fail(`couldn't reach ${t.label}`);
  }

  private async waitFrames(tok: Token, seconds: number): Promise<number> {
    let t = 0;
    while (t < seconds) t += await this.frame(tok);
    return t;
  }

  /** Puts the NPC on a standable cell near a point (with a puff). Returns false if none. */
  teleportNear(p: Vec3Like, within = 1.5, reachFrom = 0): boolean {
    const nav = this.v.nav;
    const height = this.npc.isGolem ? 3 : 2;
    let best: Vec3Like | null = null, bd = Infinity;
    const bx = Math.floor(p.x), by = Math.floor(p.y - reachFrom), bz = Math.floor(p.z);
    for (let dy = -3; dy <= 3; dy++)
      for (let dz = -3; dz <= 3; dz++)
        for (let dx = -3; dx <= 3; dx++) {
          const x = bx + dx, y = by + dy, z = bz + dz;
          if (!nav.standable(x, y, z, height)) continue;
          const d = Math.hypot(x + 0.5 - p.x, y + reachFrom - p.y, z + 0.5 - p.z);
          const score = Math.abs(d - within * 0.8);
          if (score < bd) {
            bd = score;
            best = { x, y, z };
          }
        }
    if (!best) {
      if (this.v.game.world.isLoaded(p.x, p.z)) return false;
      best = { x: bx, y: this.v.game.terrain.heightAt(bx, bz) + 1, z: bz };
    }
    const n = this.npc;
    this.v.particles.burst(n.position.x, n.position.y + 1, n.position.z, 0xdddddd, 8, 1.5);
    n.teleport(best.x + 0.5, best.y, best.z + 0.5);
    this.v.particles.burst(n.position.x, n.position.y + 1, n.position.z, 0xdddddd, 8, 1.5);
    return true;
  }

  private playerIn(x: number, y: number, z: number): boolean {
    const p = this.v.game.player.position;
    return p.x + 0.3 > x && p.x - 0.3 < x + 1 && p.z + 0.3 > z && p.z - 0.3 < z + 1 && p.y < y + 1 && p.y + 1.8 > y;
  }

  private selfIn(x: number, y: number, z: number): boolean {
    const n = this.npc, hw = n.width / 2;
    const p = n.position;
    return p.x + hw > x && p.x - hw < x + 1 && p.z + hw > z && p.z - hw < z + 1 && p.y < y + 1 && p.y + n.height > y;
  }

  /** Gets out of a cell before a solid block goes there: hop on top when it's at the feet, else step aside. */
  private async stepOff(tok: Token, x: number, y: number, z: number, def: BlockDef): Promise<void> {
    if (!def.solid || !this.selfIn(x, y, z)) return;
    const n = this.npc;
    const nav = this.v.nav;
    if (Math.floor(n.position.y + 0.01) === y && nav.passable(x, y + 1, z) && nav.passable(x, y + 2, z) && Math.floor(n.position.x) === x && Math.floor(n.position.z) === z) {
      // Placed under the feet: the NPC ends up standing on it (handled after placing).
      this.hopAfter = { x, y, z };
      return;
    }
    const cands: Vec3Like[] = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const cx = x + dx, cz = z + dz;
      for (const dy of [0, 1, -1]) {
        const cy = Math.floor(n.position.y) + dy;
        if (nav.standable(cx, cy, cz)) cands.push({ x: cx, y: cy, z: cz });
      }
    }
    for (const c of cands) {
      n.teleport(c.x + 0.5, c.y, c.z + 0.5);
      if (!this.selfIn(x, y, z)) {
        await this.frame(tok);
        return;
      }
    }
  }

  private hopAfter: Vec3Like | null = null;

  /** Places a block (both door halves, wall-attached torches/ladders) with a swing and particles. */
  private putBlock(x: number, y: number, z: number, def: BlockDef, meta: number | null, facing: number | null, source: BlockSource): void {
    const world = this.v.game.world;
    const n = this.npc;
    n.face(x + 0.5, z + 0.5);
    n.lookAtTarget({ x: x + 0.5, y: y + 0.5, z: z + 0.5 }, 0.6);
    n.swing();
    n.carry(blockColor(def.id));
    const m = meta ?? this.placementMeta(def, x, y, z, facing);
    if (def.renderType === 'door') {
      world.setBlock(x, y, z, def.id, { meta: m & 7, source, entity: n });
      if (world.isReplaceable(x, y + 1, z) || world.getBlock(x, y + 1, z) === BLOCK.air) world.setBlock(x, y + 1, z, def.id, { meta: (m & 7) | 8, source, entity: n });
    } else world.setBlock(x, y, z, def.id, { meta: m, source, entity: n });
    this.v.particles.burst(x + 0.5, y + 0.5, z + 0.5, blockColor(def.id), 7, 2);
    if (this.hopAfter && this.hopAfter.x === x && this.hopAfter.y === y && this.hopAfter.z === z) {
      n.position.y = y + 1.001;
      n.velocity.y = 0;
    }
    this.hopAfter = null;
  }

  private placementMeta(def: BlockDef, x: number, y: number, z: number, facing: number | null): number {
    const world = this.v.game.world;
    const solid = (ax: number, ay: number, az: number) => (BLOCK_FLAGS[world.getBlock(ax, ay, az)] & F_SOLID) !== 0;
    if (def.renderType === 'torch') {
      if (solid(x, y - 1, z)) return 0;
      for (let f = 0; f < 4; f++) if (solid(x + FDX[f], y, z + FDZ[f])) return f + 1;
      return 0;
    }
    if (def.renderType === 'ladder') {
      if (facing !== null) return facing;
      for (let f = 0; f < 4; f++) if (solid(x + FDX[f], y, z + FDZ[f])) return f;
      return 0;
    }
    if (def.renderType === 'door' || def.orientable) {
      if (facing !== null) return facing;
      // Face the builder.
      const n = this.npc.position;
      const dx = n.x - (x + 0.5), dz = n.z - (z + 0.5);
      return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 1 : 3) : dz > 0 ? 2 : 0;
    }
    return 0;
  }

  private async mineAt(tok: Token, x: number, y: number, z: number, source: BlockSource): Promise<ActionResult> {
    const world = this.v.game.world;
    const id = world.getBlock(x, y, z);
    if (id === BLOCK.air) return fail(`nothing to mine at ${x},${y},${z}`);
    const def = blockById(id);
    if (def.hardness < 0 || def.liquid) return fail(`${def.name} can't be mined`);
    if (!(await this.reachBlock(tok, x, y, z, 4.6))) return fail(`can't reach ${def.name} at ${x},${y},${z}`);
    const n = this.npc;
    n.face(x + 0.5, z + 0.5);
    n.lookAtTarget({ x: x + 0.5, y: y + 0.5, z: z + 0.5 }, 3);
    const tool = { item: def.tool === 'axe' ? 'iron_axe' : def.tool === 'shovel' ? 'iron_shovel' : 'iron_pickaxe', count: 1 };
    const time = Math.max(0.35, Math.min(2.5, breakTime(def, tool)));
    let t = 0, swingT = 0;
    while (t < time) {
      const dt = await this.frame(tok);
      t += dt;
      swingT -= dt;
      if (swingT <= 0) {
        swingT = 0.3;
        n.swing();
        this.v.particles.burst(x + 0.5, y + 0.5, z + 0.5, blockColor(id), 2, 1.5);
      }
      if (world.getBlock(x, y, z) !== id) return fail(`the ${def.name} is gone`);
    }
    const drops = computeDrops(def, world.getMeta(x, y, z), tool);
    const res = this.v.game.breakBlock(x, y, z, { source, entity: n, drop: false, tool });
    if (!res) return fail(`couldn't break ${def.name}`);
    for (const d of drops) addBag(n.bag, d.item, d.count);
    this.v.particles.burst(x + 0.5, y + 0.5, z + 0.5, blockColor(id), 12, 2.5);
    return ok(`mined ${def.name}`, { drops });
  }

  /** Harvests ripe wheat on the village farms and replants it. */
  private async harvest(tok: Token, n: number, opts: ActionOptions): Promise<ActionResult> {
    const world = this.v.game.world;
    const cells = this.v.ripeWheat(this.npc.position, n * 2);
    if (!cells.length) return fail('no ripe wheat right now');
    let got = 0;
    for (const c of cells) {
      if (got >= n) break;
      if (world.getBlock(c.x, c.y, c.z) !== BLOCK.wheat || world.getMeta(c.x, c.y, c.z) < 7) continue;
      if (!(await this.reachBlock(tok, c.x, c.y, c.z, 3.5))) continue;
      this.npc.face(c.x + 0.5, c.z + 0.5);
      this.npc.lookAtTarget({ x: c.x + 0.5, y: c.y, z: c.z + 0.5 }, 1);
      this.npc.swing();
      await this.sleep(tok, 0.35);
      this.v.particles.burst(c.x + 0.5, c.y + 0.4, c.z + 0.5, 0xd8c050, 8, 1.8);
      world.setBlock(c.x, c.y, c.z, BLOCK.wheat, { meta: 0, source: 'village', entity: this.npc });
      addBag(this.npc.bag, 'wheat', 1);
      got++;
      opts.onProgress?.({ action: 'gather', done: got, total: n, detail: 'wheat' });
      await this.sleep(tok, 0.25);
    }
    return got > 0 ? ok(`harvested ${got}/${n} wheat (replanted)`, { count: got }) : fail("couldn't reach the ripe wheat");
  }

  /** Walks to the builder's yard and takes materials from the piles (unlimited in the demo). */
  private async fetchFromYard(tok: Token, list: [string, number][], opts: ActionOptions, quiet = false): Promise<ActionResult> {
    const yard = this.v.yard;
    if (!yard) return fail('there is no builder\'s yard');
    const dYard = Math.hypot(yard.center.x - this.npc.position.x, yard.center.z - this.npc.position.z);
    if (dYard > 120) {
      for (const [k, c] of list) addBag(this.npc.bag, k, c);
      return ok('had the materials on hand');
    }
    const visits = list.slice(0, 3);
    let i = 0;
    for (const [name] of visits) {
      const pile = yard.piles[name] ?? yard.piles.any;
      if (!pile) continue;
      const r = await this.goto(tok, pointTarget(pile.at, `the ${name.replace(/_/g, ' ')} pile`), { reach: 1.1 });
      if (!r.ok) continue;
      this.npc.face(pile.look.x + 0.5, pile.look.z + 0.5);
      this.npc.lookAtTarget({ x: pile.look.x + 0.5, y: pile.look.y + 0.5, z: pile.look.z + 0.5 }, 1.5);
      const def = findBlock(name);
      for (let s = 0; s < 2; s++) {
        this.npc.swing();
        if (def) this.v.particles.burst(pile.look.x + 0.5, pile.look.y + 0.6, pile.look.z + 0.5, blockColor(def.id), 4, 1.5);
        await this.sleep(tok, 0.3);
      }
      if (def) this.npc.carry(blockColor(def.id));
      i++;
      opts.onProgress?.({ action: 'fetch', done: i, total: visits.length, detail: name });
    }
    for (const [k, c] of list) addBag(this.npc.bag, k, c);
    const summary = list.map(([k, c]) => `${c} ${k}`).join(', ');
    if (!quiet && this.npc.bubble && !this.npc.bubble.speaking) void this.npc.bubble.say(`Got the ${list[0][0].replace(/_/g, ' ')}.`);
    return ok(`fetched ${summary} from the yard`, { materials: Object.fromEntries(list) });
  }

  /** Builds a dirt pillar next to the footprint and climbs it to reach (x, y, z). */
  private async scaffoldTo(tok: Token, x: number, y: number, z: number, fp: { x0: number; x1: number; z0: number; z1: number }, minY: number): Promise<Pillar | null> {
    const world = this.v.game.world;
    const nav = this.v.nav;
    const standY = y - 1;
    let best: { x: number; z: number; g: number } | null = null, bd = Infinity;
    for (let ring = 1; ring <= 2; ring++) {
      for (let cz = fp.z0 - ring; cz <= fp.z1 + ring; cz++)
        for (let cx = fp.x0 - ring; cx <= fp.x1 + ring; cx++) {
          const onRing = cx === fp.x0 - ring || cx === fp.x1 + ring || cz === fp.z0 - ring || cz === fp.z1 + ring;
          if (!onRing) continue;
          const g = world.findGround(cx, cz, standY + 1);
          if (g === null || g > standY || g < minY - 3) continue;
          let clear = true;
          for (let yy = g; yy <= standY + 1 && clear; yy++) if (!nav.passable(cx, yy, cz) || world.getBlock(cx, yy, cz) !== BLOCK.air && !world.isReplaceable(cx, yy, cz)) clear = false;
          if (!clear) continue;
          const d = Math.hypot(cx - x, cz - z);
          if (d < bd) {
            bd = d;
            best = { x: cx, z: cz, g };
          }
        }
      if (best) break;
    }
    const spot = best as { x: number; z: number; g: number } | null;
    if (!spot) return null;
    const r = await this.goto(tok, pointTarget({ x: spot.x + 0.5, y: spot.g, z: spot.z + 0.5 }, 'the scaffold spot'), { reach: 0.6 });
    if (!r.ok) return null;
    const n = this.npc;
    n.kinematic = true;
    n.teleport(spot.x + 0.5, spot.g, spot.z + 0.5);
    const pillar: Pillar = { x: spot.x, z: spot.z, ground: spot.g, top: spot.g - 1 };
    try {
      for (let yy = spot.g; yy < standY; yy++) {
        // Hop up, then put dirt under the feet.
        let t = 0;
        while (t < 0.2) {
          const dt = await this.frame(tok);
          t += dt;
          n.position.y = yy + Math.min(1, t / 0.2) * 1.05;
        }
        n.swing();
        world.setBlock(spot.x, yy, spot.z, BLOCK.dirt, { source: 'village', entity: n });
        this.v.particles.burst(spot.x + 0.5, yy + 0.5, spot.z + 0.5, blockColor(BLOCK.dirt), 5, 1.5);
        pillar.top = yy;
        n.position.y = yy + 1;
      }
    } finally {
      n.kinematic = false;
    }
    return pillar;
  }

  /** Climbs down a pillar, removing it block by block. */
  private async descend(tok: Token, p: Pillar): Promise<void> {
    const world = this.v.game.world;
    const n = this.npc;
    const onIt = Math.floor(n.position.x) === p.x && Math.floor(n.position.z) === p.z;
    if (!onIt) {
      this.dropPillar(p, 'village');
      return;
    }
    n.kinematic = true;
    try {
      for (let yy = p.top; yy >= p.ground; yy--) {
        if (world.getBlock(p.x, yy, p.z) === BLOCK.dirt) {
          n.swing();
          world.setBlock(p.x, yy, p.z, BLOCK.air, { source: 'village', entity: n });
          this.v.particles.burst(p.x + 0.5, yy + 0.5, p.z + 0.5, blockColor(BLOCK.dirt), 5, 1.5);
        }
        let t = 0;
        const from = n.position.y;
        while (t < 0.15) {
          const dt = await this.frame(tok);
          t += dt;
          n.position.y = from - Math.min(1, t / 0.15) * (from - yy);
        }
        n.position.y = yy;
        p.top = yy - 1;
      }
    } finally {
      n.kinematic = false;
    }
  }

  /** Removes what is left of a pillar at once (cancel / not standing on it). */
  private dropPillar(p: Pillar, source: BlockSource): void {
    const world = this.v.game.world;
    for (let yy = p.top; yy >= p.ground; yy--) {
      if (world.getBlock(p.x, yy, p.z) === BLOCK.dirt) world.setBlock(p.x, yy, p.z, BLOCK.air, { source, entity: this.npc });
    }
    const n = this.npc;
    if (Math.floor(n.position.x) === p.x && Math.floor(n.position.z) === p.z && n.position.y > p.ground) n.teleport(p.x + 0.5, p.ground, p.z + 0.5);
  }

  /** Close-combat loop for guards and the golem. */
  private fight(foe: Entity, dt: number): void {
    const npc = this.npc;
    this.combatTarget = foe;
    if (!npc.isGolem) npc.swordDrawn = true;
    const d = Math.hypot(foe.position.x - npc.position.x, foe.position.z - npc.position.z);
    const reach = npc.isGolem ? 2.8 : 2.2;
    npc.lookAtTarget(foe, 1);
    this.combatRepath -= dt;
    if (d > reach) {
      if (this.combatRepath <= 0 || !npc.moving) {
        this.combatRepath = 0.6;
        const path = this.v.nav.path(npc.position, foe.position, { reach: reach - 0.4, reachFrom: 0, height: npc.isGolem ? 3 : 2, partial: true, maxNodes: 1500 });
        if (path && path.length) npc.followPath(path, true);
      }
      return;
    }
    npc.stopMoving();
    npc.face(foe.position.x, foe.position.z);
    if (this.attackCooldown <= 0) {
      this.attackCooldown = npc.isGolem ? 1.1 : 0.8;
      npc.swing();
      if (npc.isGolem) npc.playEmote('stamp', 0.4);
      foe.hurt(npc.isGolem ? 12 : 6, { kind: 'melee', entity: npc });
      if (npc.isGolem) foe.velocity.y += 4;
    }
  }
}

interface Pillar {
  x: number;
  z: number;
  ground: number;
  top: number;
}

const EMOTE_TEXT: Record<string, string> = {
  wave: 'waves', nod: 'nods', yes: 'nods', shake: 'shakes head', no: 'shakes head', think: 'thinks', cheer: 'cheers', hammer: 'hammers away',
  glare: 'glares', stare: 'stares', laugh: 'laughs', shrug: 'shrugs', bow: 'bows', cry: 'sniffles', sad: 'sighs', creak: 'creaks',
  stamp: 'stamps', offer_flower: 'offers a poppy',
};

/** A fixed point as a resolved target. */
export function pointTarget(p: Vec3Like, label: string): ResolvedTarget {
  const fixed = { x: p.x, y: p.y, z: p.z };
  return { label, pos: () => fixed, moving: false };
}

function describe(t: Target): string {
  if (typeof t === 'string') return t;
  const p = 'position' in t ? t.position : t;
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
}

function addBag(bag: Map<string, number>, item: string, n: number): void {
  bag.set(item, (bag.get(item) ?? 0) + n);
}

function takeBag(bag: Map<string, number>, item: string, n: number): void {
  const have = bag.get(item) ?? 0;
  if (have <= n) bag.delete(item);
  else bag.set(item, have - n);
}


/**
 * Oakhollow at runtime: buildings and ownership, posts and plots, the named cast with their
 * controllers and schedules, trading, posture, the golem, repairs and statues.
 *
 * Import the singleton: `import { village } from '../village'`. It is attached to the game by the
 * village plugin; everything is safe to call before that (returns empty/null).
 */
import { BLOCK, blockById, findBlock, type BlockDef } from '../engine/blocks';
import type { DamageSource, Entity } from '../engine/entity';
import { findItem } from '../engine/items';
import type { Game } from '../game/game';
import type { BlockSource } from '../game/events';
import type { Rect } from './gen/decor';
import {
  anchorsFor, footprint, planVillage, recordBuilding, type BuildingSpec, type VillageLayout, type WorldPos,
} from './layout';
import { GridNavigator, type Vec3Like } from './nav';
import { NAMED_CAST, genericCast, type CastMember } from './npc/cast';
import { VillagerController, pointTarget, type ActionResult, type ExpandedPlanLike, type PlanBlock, type ResolvedTarget, type Target } from './npc/controller';
import { Particles, blockColor } from './npc/effects';
import { Npc, type NpcHost, type Posture } from './npc/npc';
import { ScheduleBrain } from './npc/schedule';
import { TradeScreen, type HaggleHandler, type HaggleRequest, type HaggleResult, type TradeSession } from './trade/screen';
import { BubbleLayer, type WorldLabel } from './ui/bubbles';
import { InteractMenu } from './ui/menu';
import './events';

export type { Posture } from './npc/npc';

/** An owned region: a building (generated or registered later). */
export interface Building {
  id: string;
  /** Villager id of the owner ('village' for statues). */
  owner: string;
  kind: string;
  name: string;
  /** Inclusive AABB in world blocks. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /** Lower half of the front door (null for open fronts / custom builds). */
  door: WorldPos | null;
  /** Floor cell just outside the entrance. */
  entrance: WorldPos;
  /** First bed (head/foot blocks, and where to stand before lying down). */
  bed: { head: WorldPos; foot: WorldPos; stand: WorldPos } | null;
  beds: { head: WorldPos; foot: WorldPos; stand: WorldPos }[];
  /** Work stand spots and what to face. */
  work: { at: WorldPos; look: WorldPos }[];
  /** True for buildings registered at runtime (buildPlan registerAs, statues). */
  dynamic: boolean;
}

/** A build plot (Bram's demo build site). */
export interface Plot {
  id: string;
  owner: string;
  /** Inclusive buildable rect (x/z) at ground stand level `origin.y`. */
  rect: Rect;
  /** Min corner at stand level: pass as `origin` to builder plans. */
  origin: WorldPos;
  /** [x, y, z] site size for `builder.plan`. */
  size: [number, number, number];
  /** Where the sign post stands. */
  sign: WorldPos;
  /** A good spot for the builder to stand while explaining. */
  front: WorldPos;
}

export interface VillageState {
  population: number;
  /** Ids of injured villagers. */
  injured: string[];
  posture: Posture;
  priceMult: number;
  /** Hostile mobs within the village. */
  hostilesNear: number;
  buildings: { id: string; owner: string; kind: string; damaged: number; total: number }[];
  damagedTotal: number;
  golemConfronting: boolean;
  npcs: { id: string; name: string; activity: string; injured: boolean; x: number; y: number; z: number }[];
}

/** Snapshot of a building's original blocks for measuring repairs. */
export interface RepairTracker {
  buildingId: string;
  owner: string;
  /** Original non-air blocks (template snapshot). */
  readonly original: ReadonlyArray<PlanBlock>;
  /** Original blocks that are currently missing or different. */
  missing(): PlanBlock[];
  /** Count of missing blocks now. */
  damaged(): number;
  /** 0..1: how much of the worst damage seen since the tracker was made has been restored. */
  restoreProgress(): number;
}

export type TalkHandler = (npc: Npc) => void;

const HOSTILE_TYPES = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'baby_zombie', 'husk', 'witch', 'raider']);

const BLOCK_ALIASES: Record<string, string> = {
  thatch: 'hay_bale', hay: 'hay_bale', straw: 'hay_bale', lantern: 'glow_lamp', lamp: 'glow_lamp', path: 'dirt_path',
  wool: 'white_wool', wood: 'oak_log', log: 'oak_log', logs: 'oak_log', planks: 'oak_planks', plank: 'oak_planks',
  wood_planks: 'oak_planks', brick: 'bricks', cobble: 'cobblestone', glass_pane: 'glass', window: 'glass',
  stone_brick: 'stone_bricks', moss: 'mossy_cobblestone', iron: 'iron_block', gold: 'gold_block', diamond: 'diamond_block',
};
const ITEM_ALIASES: Record<string, string> = {
  coin: 'coins', money: 'coins', gold: 'coins', emerald: 'coins', emeralds: 'coins', seeds: 'wheat_seeds', seed: 'wheat_seeds',
  pickaxe: 'iron_pickaxe', sword: 'iron_sword', axe: 'iron_axe', shovel: 'iron_shovel', loaf: 'bread', poppy: 'red_flower', flower: 'red_flower',
};

interface InternalBuilding extends Building {
  /** "x,y,z" → [id, meta] of the original blocks (non-air only). */
  original: Map<string, [number, number]>;
  footprint: Rect;
}

export class Village implements NpcHost {
  game!: Game;
  layout: VillageLayout | null = null;
  nav!: GridNavigator;
  readonly particles = new Particles();
  bubbles!: BubbleLayer;
  /** All villagers by id (named cast + generics + golem). */
  readonly npcs = new Map<string, Npc>();
  readonly buildings: Building[] = [];
  readonly plots: Plot[] = [];
  /** Named stand spots: gate, tower, well, mara_house, plaza (+ square, walls, farm, bram_plot, tower_base, yard). */
  readonly posts: Record<string, WorldPos> = {};
  /** Builder's yard piles (material → stand spot) and centre. */
  yard: { center: WorldPos; piles: Record<string, { at: WorldPos; look: WorldPos }> } | null = null;
  /** Where the village statue goes (min corner at stand level) and its footprint size. */
  statueSpot: { origin: WorldPos; size: [number, number, number] } | null = null;
  posture: Posture = 'calm';
  priceMult = 1;
  /** Daily schedules run while true. */
  schedulesEnabled = true;
  /** Built-in rules reactions (angry owners, golem confronts griefers). Turn off when V3 drives reactions. */
  autoReactions = true;
  /** V3 hook: Talk in the villager menu. Default: a rules bark. */
  onTalk: TalkHandler | null = null;
  /** V3 hook: the trade screen's Haggle button. Default: a rules haggle. */
  onHaggle: HaggleHandler | null = null;
  clock = 0;
  private attached = false;
  private readonly internal = new Map<string, InternalBuilding>();
  private readonly brains = new Map<string, ScheduleBrain>();
  private frameWaiters: ((dt: number) => void)[] = [];
  private trade!: TradeScreen;
  private menu!: InteractMenu;
  private readonly openDoors = new Map<string, { x: number; y: number; z: number; since: number; keep: boolean }>();
  private festive: [number, number, number, number][] = [];
  private griefLog: number[] = [];
  private hitLog: number[] = [];
  private confrontUntil = 0;
  private pushCooldown = 0;
  private growTimer = 0;
  private stateCache: { at: number; value: VillageState } | null = null;
  private statueCount = 0;
  private plotLabel: WorldLabel | null = null;
  private readyResolve: (() => void) | null = null;
  /** Resolves once the villagers have spawned. */
  readonly ready: Promise<void> = new Promise((r) => (this.readyResolve = r));

  // -- setup -----------------------------------------------------------------------------------

  /** @internal Called by the plugin. */
  attach(game: Game): void {
    if (this.attached) return;
    this.attached = true;
    this.game = game;
    this.nav = new GridNavigator(game.world);
    game.scene.add(this.particles.group);
    this.bubbles = new BubbleLayer(game);
    const self = this;
    this.trade = new TradeScreen({ game, get priceMult() { return self.priceMult; }, haggle: (r) => this.haggle(r) });
    this.menu = new InteractMenu(this);
    const site = game.villageSite;
    if (!site) {
      console.warn('[village] this seed has no village site');
      return;
    }
    this.layout = planVillage(game.seed, site);
    this.buildRegions(this.layout);
  }

  private buildRegions(l: VillageLayout): void {
    for (const b of l.buildings) this.addGenerated(b, l.y0);
    const pr = l.plot.rect;
    this.plots.push({
      id: l.plot.id,
      owner: l.plot.owner,
      rect: pr,
      origin: { x: pr.x0, y: l.y0 + 1, z: pr.z0 },
      size: [pr.x1 - pr.x0 + 1, 16, pr.z1 - pr.z0 + 1],
      sign: { x: l.plot.sign.x, y: l.y0 + 1, z: l.plot.sign.z },
      front: { ...l.posts.bram_plot },
    });
    Object.assign(this.posts, l.posts);
    const tower = this.internal.get('guard_tower');
    if (tower) this.posts.tower_base = { ...tower.entrance };
    const yardB = this.internal.get('builders_yard');
    if (yardB) {
      const spec = l.buildings.find((b) => b.id === 'builders_yard')!;
      const a = anchorsFor(spec, l.y0);
      this.yard = { center: a.piles?.any?.at ?? a.entrance, piles: a.piles ?? {} };
      this.posts.yard = { ...this.yard.center };
    }
    this.statueSpot = { origin: { x: l.ox + 2, y: l.y0 + 1, z: l.oz + 2 }, size: [4, 8, 4] };
  }

  private addGenerated(b: BuildingSpec, y0: number): void {
    const a = anchorsFor(b, y0);
    const rec = recordBuilding(b, y0);
    const original = new Map<string, [number, number]>();
    let minY = Infinity, maxY = -Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [k, v] of rec) {
      if (v[0] === BLOCK.air) continue;
      const [x, y, z] = k.split(',').map(Number);
      if (y < y0) continue;
      original.set(k, v);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    const fp = footprint(b);
    const ib: InternalBuilding = {
      id: b.id, owner: b.owner, kind: b.kind, name: b.name,
      bounds: { min: [Math.min(x0, fp.x0), y0, Math.min(z0, fp.z0)], max: [Math.max(x1, fp.x1), maxY, Math.max(z1, fp.z1)] },
      door: a.door, entrance: a.entrance, bed: a.beds[0] ?? null, beds: a.beds, work: a.work, dynamic: false,
      original, footprint: fp,
    };
    this.internal.set(b.id, ib);
    this.buildings.push(publicView(ib));
  }

  /** @internal Called by the plugin once the world is playable. */
  spawnCast(saved?: SavedVillage): void {
    const l = this.layout;
    if (!l || this.npcs.size) {
      this.readyResolve?.();
      return;
    }
    const cast: CastMember[] = [...NAMED_CAST, ...genericCast(l.generics)];
    for (const def of cast) {
      const npc = new Npc(this, def);
      npc.controller = new VillagerController(npc, this);
      npc.bubble = this.bubbles.add(() => ({ x: npc.position.x, y: npc.position.y + npc.height + 0.35, z: npc.position.z }), def.name, def.id.startsWith('villager_') ? undefined : def.role);
      this.npcs.set(def.id, npc);
      const brain = new ScheduleBrain(npc, this);
      this.brains.set(def.id, brain);
      const s = saved?.npcs?.[def.id];
      if (s) for (const [k, n] of s.bag ?? []) npc.bag.set(k, n);
      this.game.entities.add(npc);
      this.placeAtStart(npc, brain, s);
    }
    const plot = this.plots[0];
    if (plot) this.plotLabel = this.bubbles.label({ x: plot.sign.x + 0.5, y: plot.sign.y + 2.3, z: plot.sign.z + 0.5 }, "Bram's Plot · build site", 26);
    this.readyResolve?.();
  }

  private placeAtStart(npc: Npc, brain: ScheduleBrain, saved?: { x: number; y: number; z: number }): void {
    const want = brain.desired();
    const home = this.homeOf(npc);
    if (want === 'home' && home?.bed) {
      npc.position.set(home.bed.stand.x + 0.5, home.bed.stand.y, home.bed.stand.z + 0.5);
      npc.lieDown(home.bed.foot, home.bed.head);
      brain.activity = 'home';
      return;
    }
    if (saved && Number.isFinite(saved.x)) {
      npc.position.set(saved.x, saved.y + 0.05, saved.z);
      return;
    }
    let p: WorldPos | null = null;
    if (npc.isGolem) p = this.posts.plaza;
    else if (npc.def.guard) p = this.posts.gate;
    else {
      const spots = this.workSpots(npc.def.work);
      p = spots.length ? spots[0].at : home?.entrance ?? this.posts.plaza;
    }
    if (p) npc.position.set(p.x + 0.5, p.y, p.z + 0.5);
  }

  // -- public API ------------------------------------------------------------------------------

  /** Owner of the building at a block, or null. Exact for template blocks; footprint for additions. */
  ownerAt(x: number, y: number, z: number): { buildingId: string; owner: string } | null {
    x = Math.floor(x); y = Math.floor(y); z = Math.floor(z);
    for (const b of this.internal.values()) {
      const { min, max } = b.bounds;
      if (x < min[0] || x > max[0] || y < min[1] || y > max[1] || z < min[2] || z > max[2]) continue;
      const inFoot = x >= b.footprint.x0 && x <= b.footprint.x1 && z >= b.footprint.z0 && z <= b.footprint.z1;
      if (inFoot || b.original.has(`${x},${y},${z}`)) return { buildingId: b.id, owner: b.owner };
    }
    return null;
  }

  /** A building by id. */
  building(id: string): Building | undefined {
    return this.buildings.find((b) => b.id === id);
  }

  /** A villager by id, alias (e.g. 'captain_rowan', 'golem') or name. */
  npc(id: string): Npc | undefined {
    const k = String(id ?? '').trim().toLowerCase();
    const direct = this.npcs.get(k);
    if (direct) return direct;
    for (const n of this.npcs.values()) if (n.def.aliases.includes(k) || n.def.name.toLowerCase() === k) return n;
    return undefined;
  }

  /** The controller (action API) of a villager. */
  controller(id: string): VillagerController | undefined {
    return this.npc(id)?.controller;
  }

  /** Sets the village-wide price multiplier (posture); open trade screens re-price live. */
  setPriceMult(mult: number): void {
    const m = Number(mult);
    if (!Number.isFinite(m) || m <= 0) return;
    this.priceMult = Math.max(0.25, Math.min(4, m));
    this.trade?.refresh();
    this.markDirty();
  }

  /** Changes the village posture: faces, idle behaviour, doors/guards (hostile), bunting (festive). */
  setPosture(p: Posture): void {
    if (!['calm', 'wary', 'hostile', 'festive'].includes(p) || p === this.posture) return;
    const prev = this.posture;
    this.posture = p;
    if (prev === 'festive') this.removeFestive();
    if (p === 'festive') this.placeFestive();
    if (p === 'hostile') {
      for (const b of this.internal.values()) if (b.door) this.setDoor(b.door.x, b.door.y, b.door.z, false);
      for (const n of this.npcs.values()) if (n.def.guard && !n.isGolem) n.swordDrawn = true;
    } else for (const n of this.npcs.values()) if (!n.isGolem && n.controller.currentMode !== 'guard') n.swordDrawn = false;
    for (const b of this.brains.values()) b.poke();
    this.game.events.emit('villagePosture', { posture: p, prev });
    this.markDirty();
  }

  /** Snapshot for V3's village mind. */
  state(): VillageState {
    if (this.stateCache && this.clock - this.stateCache.at < 0.5) return this.stateCache.value;
    const npcs = [...this.npcs.values()].filter((n) => !n.removed);
    const buildings = [...this.internal.values()].map((b) => ({ id: b.id, owner: b.owner, kind: b.kind, damaged: this.damageOf(b), total: b.original.size }));
    const value: VillageState = {
      population: npcs.length,
      injured: npcs.filter((n) => n.injured).map((n) => n.def.id),
      posture: this.posture,
      priceMult: this.priceMult,
      hostilesNear: this.layout ? this.hostilesIn(this.center(), 48) : 0,
      buildings,
      damagedTotal: buildings.reduce((s, b) => s + b.damaged, 0),
      golemConfronting: this.clock < this.confrontUntil,
      npcs: npcs.map((n) => ({ id: n.def.id, name: n.def.name, activity: n.controller.activity, injured: n.injured, x: n.position.x, y: n.position.y, z: n.position.z })),
    };
    this.stateCache = { at: this.clock, value };
    return value;
  }

  /** Snapshot of a building's original blocks for measuring repair progress. */
  repairTracker(buildingId: string): RepairTracker | null {
    const b = this.internal.get(buildingId);
    if (!b) return null;
    const original: PlanBlock[] = [...b.original].map(([k, [id, meta]]) => {
      const [x, y, z] = k.split(',').map(Number);
      return { x, y, z, block: blockById(id).name, meta };
    });
    let peak = this.damageOf(b);
    const self = this;
    return {
      buildingId: b.id,
      owner: b.owner,
      original,
      missing: () => self.missingOf(b),
      damaged() {
        const d = self.damageOf(b);
        peak = Math.max(peak, d);
        return d;
      },
      restoreProgress() {
        const d = self.damageOf(b);
        peak = Math.max(peak, d);
        return peak === 0 ? 1 : 1 - d / peak;
      },
    };
  }

  /** The missing blocks of a building as a plan, bottom-up (feed it to `buildPlan` for a co-build repair). */
  repairPlan(buildingId: string): ExpandedPlanLike {
    const b = this.internal.get(buildingId);
    if (!b) return { blocks: [] };
    const blocks = this.missingOf(b).sort((a, c) => a.y - c.y);
    return { blocks };
  }

  /**
   * Places a statue plan (expanded blocks, relative to `at`) progressively with particles, and
   * registers it as a village-owned region. `at` defaults to the plaza statue spot.
   */
  async spawnStatue(expanded: ExpandedPlanLike, at?: Vec3Like | string, opts: { blocksPerSecond?: number; source?: BlockSource; id?: string; name?: string } = {}): Promise<ActionResult> {
    if (!this.attached || !expanded?.blocks?.length) return { ok: false, detail: 'no statue blocks' };
    let o: Vec3Like | null = null;
    if (typeof at === 'string') o = this.resolveTarget(at, null)?.pos() ?? null;
    else if (at) o = at;
    else o = this.statueSpot?.origin ?? null;
    if (!o) return { ok: false, detail: 'no place for the statue' };
    const world = this.game.world;
    const bps = Math.max(1, Math.min(200, opts.blocksPerSecond ?? 40));
    const source = opts.source ?? 'village';
    const placed: { x: number; y: number; z: number; id: number; meta: number }[] = [];
    const sorted = [...expanded.blocks].sort((a, b) => a.y - b.y);
    let acc = 0;
    for (const b of sorted) {
      const name = this.normalizeBlock(b.block);
      const x = Math.floor(b.x + o.x), y = Math.floor(b.y + o.y), z = Math.floor(b.z + o.z);
      if (name === 'air') {
        world.setBlock(x, y, z, BLOCK.air, { source });
        continue;
      }
      const def = this.blockDef(name) ?? blockById(BLOCK.stone_bricks);
      const meta = typeof b.meta === 'number' ? b.meta : b.facing ? ({ north: 0, east: 1, south: 2, west: 3 } as const)[b.facing] : 0;
      if (world.setBlock(x, y, z, def.id, { meta, source })) {
        placed.push({ x, y, z, id: def.id, meta });
        if (placed.length % 3 === 0) this.particles.burst(x + 0.5, y + 0.5, z + 0.5, blockColor(def.id), 4, 2);
      }
      acc += 1 / bps;
      while (acc > 0) acc -= await this.frame();
    }
    const id = opts.id ?? `statue_${++this.statueCount}`;
    if (placed.length) this.registerBuilt({ id, owner: 'village', kind: 'statue', name: opts.name ?? 'Statue', blocks: placed });
    return { ok: true, detail: `raised ${id} (${placed.length} blocks)`, data: { id, placed: placed.length } };
  }

  /** Shows or hides villager name tags (speech bubbles always show). */
  setNameTags(visible: boolean): void {
    if (this.bubbles) this.bubbles.tagsVisible = visible;
  }

  /** Makes the golem confront the player for a while (pushes back, angry face; no damage). */
  golemConfront(seconds = 20, reason = 'griefing'): boolean {
    const g = this.npc('iron_golem');
    if (!g || g.removed) return false;
    const already = this.clock < this.confrontUntil;
    this.confrontUntil = this.clock + seconds;
    g.setExpressionFor('hostile', seconds);
    if (!already) {
      void g.controller.follow('player', { distance: 2, priority: 'schedule' });
      void g.controller.emote('stamp', { priority: 'schedule', seconds: 1.2 });
      this.game.events.emit('golemConfront', { active: true, reason });
    }
    return true;
  }

  /** Opens the villager interaction menu for the player. */
  openMenu(npc: Npc): void {
    this.menu.open(npc);
  }

  /** Talk: calls the V3 hook, or says a rules bark. */
  talk(npc: Npc): void {
    this.game.events.emit('villagerTalk', { npc: npc.def.id });
    npc.lookAtTarget(this.game.player, 6);
    if (this.onTalk) {
      try {
        this.onTalk(npc);
        return;
      } catch (err) {
        console.error('[village] onTalk hook failed', err);
      }
    }
    const line = npc.isGolem ? pick(npc.def.barks) : Math.random() < 0.35 ? npc.def.greeting : this.barkFor(npc);
    void npc.controller.say(line, { priority: 'schedule', emote: npc.isGolem ? undefined : 'nod' });
  }

  // -- helpers used by controllers, brains and the plugin ----------------------------------------

  /** Resolves a target name/point/entity to a (possibly moving) point. */
  resolveTarget(t: Target, forNpc: Npc | null): ResolvedTarget | null {
    if (t && typeof t === 'object') {
      if ('position' in t) {
        const e = t as { position: Vec3Like };
        const label = e === this.game.player ? 'the player' : (e as Npc).def?.name ?? 'them';
        return { label, pos: () => e.position, moving: true, entity: e };
      }
      if (Number.isFinite(t.x) && Number.isFinite(t.z)) return pointTarget({ x: t.x, y: Number.isFinite(t.y) ? t.y : this.game.world.findGround(t.x, t.z) ?? 64, z: t.z }, `${Math.floor(t.x)},${Math.floor(t.y)},${Math.floor(t.z)}`);
      return null;
    }
    const raw = String(t ?? '').trim();
    if (!raw) return null;
    const k = raw.toLowerCase().replace(/\s+/g, '_');
    const nums = raw.split(/[\s,]+/).map(Number);
    if (nums.length === 3 && nums.every(Number.isFinite)) return pointTarget({ x: nums[0], y: nums[1], z: nums[2] }, raw);
    if (k === 'player' || k === 'me' || k.startsWith('player:') || k === 'you') return { label: 'the player', pos: () => this.game.player.position, moving: true, entity: this.game.player };
    const at = (p: WorldPos, label: string) => pointTarget({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, label);
    if (k === 'home' && forNpc) {
      const h = this.homeOf(forNpc);
      return h ? at(h.entrance, `${forNpc.def.name}'s home`) : null;
    }
    if (k.startsWith('home:')) {
      const n = this.npc(k.slice(5));
      const h = n ? this.homeOf(n) : undefined;
      return h ? at(h.entrance, h.name) : null;
    }
    if ((k === 'work' || k === 'workplace') && forNpc) {
      const s = this.workSpots(forNpc.def.work)[0];
      return s ? at(s.at, `${forNpc.def.name}'s work`) : null;
    }
    if (k === 'plot' || k === 'bram_plot' || k === 'build_site') {
      const p = this.plots[0];
      return p ? at(p.front, "Bram's plot") : null;
    }
    if (k === 'statue' && this.statueSpot) return at(this.statueSpot.origin, 'the statue spot');
    const post = this.post(k);
    if (post) return at(post, k.replace(/_/g, ' '));
    const b = this.internal.get(k) ?? [...this.internal.values()].find((x) => x.name.toLowerCase() === raw.toLowerCase());
    if (b) return at(b.entrance, b.name);
    const n = this.npc(k);
    if (n && n !== forNpc) return { label: n.def.name, pos: () => n.position, moving: true, entity: n };
    if (k === 'smithy' || k === 'library' || k === 'farm_hut') return null;
    return null;
  }

  /** A named post (gate, tower, tower_base, well, mara_house, plaza, square, walls, farm, bram_plot, yard). */
  post(name: string): WorldPos | null {
    const k = String(name).toLowerCase();
    if (k === 'farm' || k === 'farms') return this.posts.farm ?? null;
    return this.posts[k] ?? null;
  }

  homeOf(npc: Npc): (Building & { bed: Building['bed'] }) | undefined {
    if (!npc.def.home) return undefined;
    const b = this.internal.get(npc.def.home);
    if (!b) return undefined;
    // Second resident of a two-bed house takes the second bed.
    const residents = [...this.npcs.values()].filter((n) => n.def.home === b.id);
    const idx = residents.indexOf(npc);
    const bed = b.beds[idx >= 0 && idx < b.beds.length ? idx : 0] ?? null;
    return { ...publicView(b), bed };
  }

  /** Work stand spots for a work kind. */
  workSpots(kind: string): { at: WorldPos; look: WorldPos }[] {
    const map: Record<string, string> = { smithy: 'smithy', library: 'library', yard: 'builders_yard' };
    const b = map[kind] ? this.internal.get(map[kind]) : undefined;
    if (b) return b.work;
    if (kind === 'farm') {
      const s = this.farmSpot();
      return s ? [{ at: s, look: s }] : [];
    }
    if (kind === 'gate' && this.posts.gate) return [{ at: this.posts.gate, look: { ...this.posts.gate, x: this.posts.gate.x + 5 } }];
    if (this.posts.plaza) return [{ at: this.posts.plaza, look: this.posts.well }];
    return [];
  }

  /** A random walkable spot at the edge of a farm. */
  farmSpot(): WorldPos | null {
    const l = this.layout;
    if (!l) return null;
    const f = l.farms[Math.floor(Math.random() * l.farms.length)];
    const side = Math.random() < 0.5;
    const x = side ? f.rect.x1 + 1 : f.rect.x0 + Math.floor(Math.random() * (f.rect.x1 - f.rect.x0));
    const z = side ? f.rect.z0 + Math.floor(Math.random() * (f.rect.z1 - f.rect.z0)) : f.rect.z0 - 1;
    return { x, y: l.y0 + 1, z };
  }

  /** A random point to potter about near the plaza or another spot. */
  wanderSpot(where: string): WorldPos {
    const l = this.layout!;
    const base = where === 'library' ? this.internal.get('library')?.entrance ?? this.posts.plaza : this.posts.plaza;
    const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * 5;
    return { x: Math.floor(base.x + Math.cos(a) * r), y: l.y0 + 1, z: Math.floor(base.z + Math.sin(a) * r) };
  }

  /** A spot in the evening ring around the well (or the party ring), facing the centre. */
  gatherSpot(npc: Npc, party: boolean): { at: WorldPos; look: WorldPos } {
    const l = this.layout!;
    const ids = [...this.npcs.keys()];
    const i = Math.max(0, ids.indexOf(npc.def.id));
    const a = (i / Math.max(1, ids.length)) * Math.PI * 2 + 0.3;
    const r = party ? 4.2 : 3.6;
    const cx = l.ox - 0.5, cz = l.oz - 0.5;
    return { at: { x: Math.floor(cx + Math.cos(a) * r), y: l.y0 + 1, z: Math.floor(cz + Math.sin(a) * r) }, look: { x: cx, y: l.y0 + 2, z: cz } };
  }

  /** Nearest other villager within r. */
  nearestNpc(npc: Npc, r: number): Npc | null {
    let best: Npc | null = null, bd = r;
    for (const n of this.npcs.values()) {
      if (n === npc || n.removed || n.isGolem) continue;
      const d = n.position.distanceTo(npc.position);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  /** A bark for a villager that fits the time, weather and posture. */
  barkFor(npc: Npc): string {
    const p = this.posture;
    if (p === 'hostile') return pick(['Keep your distance.', 'We know what you did.', 'Guards! Watch that one.']);
    if (p === 'wary') return pick(['Hm. I\'ve got my eye on you.', 'Careful where you swing that.', ...npc.def.barks]);
    if (p === 'festive') return pick(['What a day!', 'Music tonight, they say!', 'Have you tried the bread?', ...npc.def.barks]);
    if (this.game.weather.current === 'rain' || this.game.weather.current === 'storm') return pick(['Wet one today.', 'Good for the wheat, at least.', ...npc.def.barks]);
    if (this.game.time.phase === 'dusk') return pick(['Lamps on soon.', 'Long day.', ...npc.def.barks]);
    return pick(npc.def.barks);
  }

  /** Smithy sparks at a point. */
  sparks(p: Vec3Like): void {
    this.particles.burst(p.x + 0.5, p.y + 1, p.z + 0.5, 0xffb33a, 5, 2.5);
  }

  /** Ripe wheat cells on the farms (stage 7), nearest first. */
  ripeWheat(near: Vec3Like, limit: number): WorldPos[] {
    const l = this.layout;
    if (!l) return [];
    const world = this.game.world;
    const out: WorldPos[] = [];
    for (const f of l.farms)
      for (let z = f.rect.z0 + 1; z < f.rect.z1; z++)
        for (let x = f.rect.x0 + 1; x < f.rect.x1; x++) {
          const y = l.y0 + 1;
          if (world.getBlock(x, y, z) === BLOCK.wheat && world.getMeta(x, y, z) >= 7) out.push({ x, y, z });
        }
    out.sort((a, b) => Math.hypot(a.x - near.x, a.z - near.z) - Math.hypot(b.x - near.x, b.z - near.z));
    return out.slice(0, limit);
  }

  /** Exposed blocks of a type near a point (nearest first). */
  findExposed(id: number, near: Vec3Like, radius: number, limit: number): WorldPos[] {
    const world = this.game.world;
    const out: WorldPos[] = [];
    const bx = Math.floor(near.x), by = Math.floor(near.y), bz = Math.floor(near.z);
    const r = Math.min(32, radius);
    for (let y = by - 8; y <= by + 10; y++)
      for (let z = bz - r; z <= bz + r; z++)
        for (let x = bx - r; x <= bx + r; x++) {
          if (world.getBlock(x, y, z) !== id) continue;
          if (this.ownerAt(x, y, z)) continue;
          const exposed = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => !world.isOpaque(x + dx, y + dy, z + dz));
          if (exposed) out.push({ x, y, z });
        }
    out.sort((a, b) => Math.hypot(a.x - near.x, a.y - near.y, a.z - near.z) - Math.hypot(b.x - near.x, b.y - near.y, b.z - near.z));
    return out.slice(0, limit);
  }

  /** True if the builder's yard supplies this block (unlimited in the demo). */
  isYardMaterial(name: string): boolean {
    const d = findBlock(name);
    if (!d || d.id === BLOCK.air || d.liquid || d.hardness < 0) return false;
    if (d.renderType === 'cross' || d.tags.includes('ore') || d.name === 'farmland') return false;
    return true;
  }

  /** Normalises a block name (aliases, plurals, spaces). */
  normalizeBlock(name: string): string {
    let k = String(name ?? '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_');
    if (k === 'air' || k === 'empty') return 'air';
    if (findBlock(k)) return k;
    if (BLOCK_ALIASES[k]) return BLOCK_ALIASES[k];
    if (k.endsWith('s') && findBlock(k.slice(0, -1))) return k.slice(0, -1);
    if (findBlock(`${k}s`)) return `${k}s`;
    k = k.replace(/_block$/, '');
    return findBlock(k) ? k : BLOCK_ALIASES[k] ?? k;
  }

  normalizeItem(name: string): string {
    const k = String(name ?? '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_');
    if (findItem(k)) return k;
    if (ITEM_ALIASES[k]) return ITEM_ALIASES[k];
    if (k.endsWith('s') && findItem(k.slice(0, -1))) return k.slice(0, -1);
    const b = this.normalizeBlock(k);
    return findItem(b) ? b : k;
  }

  blockDef(name: string): BlockDef | undefined {
    const n = this.normalizeBlock(name);
    const d = findBlock(n);
    return d && d.id !== BLOCK.air ? d : undefined;
  }

  /** Opens a villager's trade screen. */
  openTrade(npc: Npc, opts: { priceMultiplier?: number } = {}): TradeSession | null {
    this.menu.close();
    return this.trade.open(npc, opts);
  }

  /** @internal Trade screen haggle → V3 hook or the rules default. */
  async haggle(req: HaggleRequest): Promise<HaggleResult> {
    if (this.onHaggle) {
      try {
        const r = await this.onHaggle(req);
        if (r) return r;
      } catch (err) {
        console.error('[village] onHaggle hook failed', err);
      }
    }
    if (this.posture === 'hostile') return { accepted: false, line: 'After what you did? Full price.' };
    const chance = req.attempts === 1 ? 0.55 : 0.25;
    if (Math.random() < chance) return { accepted: true, multiplier: req.multiplier * 0.9, line: pick(['Fine. A little off, just for you.', 'You drive a hard bargain.', 'Alright, alright.']) };
    return { accepted: false, line: pick(['Those are fair prices.', 'Not a coin less.', "I've got a family to feed."]) };
  }

  /** @internal Agent action finished. */
  emitAction(npc: Npc, action: string, res: ActionResult): void {
    this.game.events.emit('villagerAction', { npc: npc.def.id, action, ok: res.ok, detail: res.detail });
  }

  /** Registers a runtime-built structure as an owned region (repair tracking, ownerAt). */
  registerBuilt(b: { id: string; owner: string; kind: string; name: string; blocks: { x: number; y: number; z: number; id: number; meta: number }[] }): Building {
    const original = new Map<string, [number, number]>();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of b.blocks) {
      if (p.id === BLOCK.air) continue;
      original.set(`${p.x},${p.y},${p.z}`, [p.id, p.meta]);
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
    }
    const prev = this.internal.get(b.id);
    if (prev) for (const [k, v] of prev.original) if (!original.has(k)) original.set(k, v);
    const entrance = { x: Math.floor((x0 + x1) / 2), y: y0, z: z1 + 1 };
    const ib: InternalBuilding = {
      id: b.id, owner: b.owner, kind: b.kind, name: b.name,
      bounds: { min: [x0, y0, z0], max: [x1, y1, z1] },
      door: null, entrance, bed: null, beds: [], work: [], dynamic: true,
      original, footprint: { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity },
    };
    this.internal.set(b.id, ib);
    const i = this.buildings.findIndex((x) => x.id === b.id);
    const view = publicView(ib);
    if (i >= 0) this.buildings[i] = view;
    else this.buildings.push(view);
    this.markDirty();
    return view;
  }

  /** Next simulated frame (resolves with dt). */
  frame(): Promise<number> {
    return new Promise((r) => this.frameWaiters.push(r));
  }

  /** Nearest hostile mob within r of a point. */
  nearestHostile(p: Vec3Like, r: number): Entity | null {
    if (!this.game) return null;
    return this.game.entities.nearest(p, r, isHostile);
  }

  private hostilesIn(p: Vec3Like, r: number): number {
    return this.game.entities.query(p, r, isHostile).length;
  }

  private center(): Vec3Like {
    const l = this.layout!;
    return { x: l.ox, y: l.y0 + 1, z: l.oz };
  }

  // -- doors -----------------------------------------------------------------------------------

  /** NpcHost: opens a closed door for a passing NPC. */
  openDoor(x: number, y: number, z: number, _by: Npc): void {
    const world = this.game.world;
    if (world.getBlock(x, y, z) !== BLOCK.door) return;
    const meta = world.getMeta(x, y, z);
    const baseY = meta & 8 ? y - 1 : y;
    const k = `${x},${baseY},${z}`;
    const lower = world.getMeta(x, baseY, z);
    if (lower & 4) {
      const e = this.openDoors.get(k);
      if (e) e.since = this.clock;
      return;
    }
    this.setDoor(x, baseY, z, true);
    this.openDoors.set(k, { x, y: baseY, z, since: this.clock, keep: false });
  }

  /** Closes the front door of a building (if nobody stands in it). */
  closeDoorsOf(buildingId: string): void {
    const b = this.internal.get(buildingId);
    if (b?.door) this.setDoor(b.door.x, b.door.y, b.door.z, false);
  }

  private setDoor(x: number, y: number, z: number, open: boolean): void {
    const world = this.game.world;
    if (world.getBlock(x, y, z) !== BLOCK.door) return;
    const lower = world.getMeta(x, y, z);
    if (lower & 8) return this.setDoor(x, y - 1, z, open);
    if (((lower & 4) !== 0) === open) return;
    if (!open && this.someoneIn(x, y, z)) return;
    const m = (lower & 3) | (open ? 4 : 0);
    world.setBlock(x, y, z, BLOCK.door, { meta: m, source: 'village' });
    if (world.getBlock(x, y + 1, z) === BLOCK.door) world.setBlock(x, y + 1, z, BLOCK.door, { meta: m | 8, source: 'village' });
    if (!open) this.openDoors.delete(`${x},${y},${z}`);
  }

  private someoneIn(x: number, y: number, z: number): boolean {
    const c = { x: x + 0.5, y, z: z + 0.5 };
    const p = this.game.player.position;
    if (Math.hypot(p.x - c.x, p.z - c.z) < 0.9 && Math.abs(p.y - y) < 2) return true;
    for (const n of this.npcs.values()) if (Math.hypot(n.position.x - c.x, n.position.z - c.z) < 1.0 && Math.abs(n.position.y - y) < 2) return true;
    return false;
  }

  private updateDoors(): void {
    for (const [k, d] of this.openDoors) {
      if (this.clock - d.since < 1.4) continue;
      let near = false;
      for (const n of this.npcs.values()) if (Math.hypot(n.position.x - (d.x + 0.5), n.position.z - (d.z + 0.5)) < 1.7 && Math.abs(n.position.y - d.y) < 2) near = true;
      if (near) {
        d.since = this.clock - 0.6;
        continue;
      }
      this.setDoor(d.x, d.y, d.z, false);
      this.openDoors.delete(k);
    }
  }

  // -- reactions -------------------------------------------------------------------------------

  /** NpcHost: a villager was hurt. */
  onNpcHurt(npc: Npc, _amount: number, source: DamageSource): void {
    if (!source.player) return;
    this.hitLog.push(this.clock);
    this.hitLog = this.hitLog.filter((t) => this.clock - t < 30);
    if (!this.autoReactions) return;
    if (!npc.isGolem) {
      npc.lookAtTarget(this.game.player, 4);
      npc.playEmote('glare', 1.5);
      void npc.bubble?.say(pick(['Ow! Hey!', 'What was that for?', 'Watch it!']));
    }
    if (this.hitLog.length >= 2 || npc.isGolem) this.golemConfront(20, 'attacked a villager');
  }

  private onPlayerBroke(x: number, y: number, z: number, id: number): void {
    const own = this.ownerAt(x, y, z);
    if (!own) return;
    this.game.events.emit('villageDamaged', { buildingId: own.buildingId, owner: own.owner, x, y, z, block: blockById(id).name });
    this.markDirty();
    if (!this.autoReactions) return;
    this.griefLog.push(this.clock);
    this.griefLog = this.griefLog.filter((t) => this.clock - t < 60);
    const owner = this.npc(own.owner);
    if (owner && owner.position.distanceTo(this.game.player.position) < 28 && !owner.bubble?.speaking) {
      owner.lookAtTarget(this.game.player, 5);
      owner.playEmote('glare', 2);
      void owner.bubble?.say(pick(['Oi! That\'s my house!', 'Put that back!', 'What do you think you\'re doing?!', 'If you break it, you mend it!']));
    }
    for (const n of this.npcs.values()) if (n !== owner && !n.isGolem && n.position.distanceTo(this.game.player.position) < 14) n.playEmote('glare', 1.5);
    if (this.griefLog.length >= 3) this.golemConfront(20, 'griefing');
  }

  private updateConfront(dt: number): void {
    const g = this.npc('iron_golem');
    if (!g) return;
    if (this.confrontUntil > 0 && this.clock >= this.confrontUntil) {
      this.confrontUntil = 0;
      void g.controller.stopFollow().then(() => g.controller.releaseToSchedule());
      void g.controller.emote('creak', { priority: 'schedule' });
      this.game.events.emit('golemConfront', { active: false, reason: 'calmed down' });
      return;
    }
    if (this.clock >= this.confrontUntil) return;
    this.pushCooldown -= dt;
    const p = this.game.player;
    const dx = p.position.x - g.position.x, dz = p.position.z - g.position.z;
    const d = Math.hypot(dx, dz);
    if (d < 2.7 && this.pushCooldown <= 0 && Math.abs(p.position.y - g.position.y) < 2.5) {
      this.pushCooldown = 1.4;
      g.face(p.position.x, p.position.z);
      g.swing();
      g.playEmote('stamp', 0.6);
      const k = 1 / (d || 1);
      p.velocity.x += dx * k * 9;
      p.velocity.z += dz * k * 9;
      p.velocity.y = Math.max(p.velocity.y, 6.5);
      this.particles.burst(g.position.x, g.position.y + 0.1, g.position.z, 0x8a7a66, 6, 2);
    }
  }

  // -- posture visuals -------------------------------------------------------------------------

  private placeFestive(): void {
    const l = this.layout;
    if (!l) return;
    const world = this.game.world;
    const colors = [BLOCK.red_wool, BLOCK.yellow_wool, BLOCK.blue_wool, BLOCK.green_wool, BLOCK.white_wool];
    const y = l.y0 + 5;
    const put = (x: number, yy: number, z: number, id: number) => {
      if (world.getBlock(x, yy, z) !== BLOCK.air || !world.isLoaded(x, z)) return;
      if (world.setBlock(x, yy, z, id, { source: 'village' })) this.festive.push([x, yy, z, id]);
    };
    // Bunting along the plaza edges, between the glow lamps.
    let i = 0;
    for (let x = l.plaza.x0 + 1; x < l.plaza.x1; x++) {
      put(x, y - (i % 2), l.plaza.z0, colors[i % colors.length]);
      put(x, y - (i % 2), l.plaza.z1, colors[(i + 2) % colors.length]);
      i++;
    }
    i = 0;
    for (let z = l.plaza.z0 + 1; z < l.plaza.z1; z++) {
      put(l.plaza.x0, y - (i % 2), z, colors[(i + 1) % colors.length]);
      put(l.plaza.x1, y - (i % 2), z, colors[(i + 3) % colors.length]);
      i++;
    }
    // Banners on the house fronts, beside the door torches.
    for (const b of this.internal.values()) {
      if (!b.door || b.dynamic) continue;
      const e = b.entrance;
      const dx = e.x - b.door.x, dz = e.z - b.door.z;
      const side = { x: dz !== 0 ? 2 : 0, z: dx !== 0 ? 2 : 0 };
      for (const s of [-1, 1]) {
        const bx = e.x + side.x * s, bz = e.z + side.z * s;
        put(bx, b.door.y + 3, bz, colors[(Math.abs(bx + bz) + (s > 0 ? 1 : 0)) % colors.length]);
        put(bx, b.door.y + 2, bz, colors[(Math.abs(bx + bz) + (s > 0 ? 1 : 0)) % colors.length]);
      }
    }
  }

  private removeFestive(): void {
    const world = this.game.world;
    for (const [x, y, z, id] of this.festive) if (world.getBlock(x, y, z) === id) world.setBlock(x, y, z, BLOCK.air, { source: 'village' });
    this.festive = [];
  }

  // -- per-frame -------------------------------------------------------------------------------

  /** @internal The village system update (runs while the game is not paused). */
  update(dt: number): void {
    this.clock += dt;
    const waiters = this.frameWaiters;
    this.frameWaiters = [];
    for (const w of waiters) w(dt);
    this.particles.update(dt);
    this.bubbles?.tick(dt);
    for (const n of this.npcs.values()) {
      if (n.removed) continue;
      n.controller.update(dt);
      this.brains.get(n.def.id)?.update(dt);
    }
    this.updateDoors();
    this.updateConfront(dt);
    this.growCrops(dt);
  }

  /** @internal Places DOM overlays (every rendered frame). */
  render(): void {
    this.bubbles?.place();
  }

  private growCrops(dt: number): void {
    const l = this.layout;
    if (!l) return;
    this.growTimer -= dt;
    if (this.growTimer > 0) return;
    this.growTimer = 2.5;
    const world = this.game.world;
    const f = l.farms[Math.floor(Math.random() * l.farms.length)];
    const x = f.rect.x0 + 1 + Math.floor(Math.random() * (f.rect.x1 - f.rect.x0 - 1));
    const z = f.rect.z0 + 1 + Math.floor(Math.random() * (f.rect.z1 - f.rect.z0 - 1));
    const y = l.y0 + 1;
    if (!world.isLoaded(x, z) || world.getBlock(x, y, z) !== BLOCK.wheat) return;
    const m = world.getMeta(x, y, z);
    if (m < 7) world.setBlock(x, y, z, BLOCK.wheat, { meta: m + 1, source: 'village' });
  }

  /** @internal */
  handleBlockBroken(x: number, y: number, z: number, id: number, source: string): void {
    if (source === 'player') this.onPlayerBroke(x, y, z, id);
    else if (this.ownerAt(x, y, z)) this.markDirty();
  }

  // -- damage ----------------------------------------------------------------------------------

  private damageOf(b: InternalBuilding): number {
    const world = this.game?.world;
    if (!world) return 0;
    let n = 0;
    for (const [k, [id]] of b.original) {
      const [x, y, z] = k.split(',').map(Number);
      if (!world.isLoaded(x, z)) continue;
      if (world.getBlock(x, y, z) !== id) n++;
    }
    return n;
  }

  private missingOf(b: InternalBuilding): PlanBlock[] {
    const world = this.game.world;
    const out: PlanBlock[] = [];
    for (const [k, [id, meta]] of b.original) {
      const [x, y, z] = k.split(',').map(Number);
      if (world.isLoaded(x, z) && world.getBlock(x, y, z) !== id) out.push({ x, y, z, block: blockById(id).name, meta });
    }
    return out;
  }

  private markDirty(): void {
    this.stateCache = null;
    this.game?.save.markDirty('village');
  }

  // -- save ------------------------------------------------------------------------------------

  /** @internal */
  serialize(): SavedVillage {
    const npcs: SavedVillage['npcs'] = {};
    for (const n of this.npcs.values()) npcs[n.def.id] = { x: n.position.x, y: n.position.y, z: n.position.z, bag: [...n.bag] };
    const built = [...this.internal.values()].filter((b) => b.dynamic).map((b) => ({
      id: b.id, owner: b.owner, kind: b.kind, name: b.name,
      blocks: [...b.original].map(([k, [id, meta]]) => {
        const [x, y, z] = k.split(',').map(Number);
        return [x, y, z, id, meta] as [number, number, number, number, number];
      }),
    }));
    return { v: 1, posture: this.posture, priceMult: this.priceMult, npcs, festive: this.festive, built, statues: this.statueCount };
  }

  /** @internal */
  restore(d: SavedVillage): void {
    if (!d || d.v !== 1) return;
    this.posture = d.posture ?? 'calm';
    this.priceMult = d.priceMult ?? 1;
    this.festive = d.festive ?? [];
    this.statueCount = d.statues ?? 0;
    for (const b of d.built ?? []) this.registerBuilt({ id: b.id, owner: b.owner, kind: b.kind, name: b.name, blocks: b.blocks.map(([x, y, z, id, meta]) => ({ x, y, z, id, meta })) });
  }
}

export interface SavedVillage {
  v: 1;
  posture: Posture;
  priceMult: number;
  npcs: Record<string, { x: number; y: number; z: number; bag: [string, number][] }>;
  festive: [number, number, number, number][];
  built: { id: string; owner: string; kind: string; name: string; blocks: [number, number, number, number, number][] }[];
  statues: number;
}

function isHostile(e: Entity): boolean {
  if (e.removed) return false;
  if (e.data.hostile === true) return true;
  if (e.data.villager) return false;
  return HOSTILE_TYPES.has(e.type);
}

function publicView(b: InternalBuilding): Building {
  return {
    id: b.id, owner: b.owner, kind: b.kind, name: b.name, bounds: b.bounds, door: b.door, entrance: b.entrance,
    bed: b.bed, beds: b.beds, work: b.work, dynamic: b.dynamic,
  };
}

function pick<T>(a: T[]): T {
  return a[Math.floor(Math.random() * a.length)];
}

/** The village singleton (attached by the village plugin). */
export const village = new Village();

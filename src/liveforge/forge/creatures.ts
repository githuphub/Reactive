/**
 * Forged creatures: a creature thing is a spawn egg; right-clicking a block with it spawns a living mob built from
 * the voxel model (scaled to the creature's `size`, 0.5–3 blocks), with limb animation from `parts` (legs swing,
 * wings flap, head bobs, tail wags; a whole-body waddle when there are none) and behaviour:
 *
 * - passive: wanders; neutral: fights back when hit; hostile: hunts the player;
 * - pet: follows you, sits while you sneak (right-click toggles "stay");
 * - guard: follows you and attacks hostiles near you;
 * - flying: hovers and flaps with a sine bob; swimming: keeps to water.
 *
 * Sounds become speech bubbles now and then, `lays` drops that item every ~60 s, `drops` fall on death, and
 * right-clicking with its `tameWith` item tames it (hearts). Spawned creatures are saved (`lf_creatures`).
 */
import * as THREE from 'three';
import type { BoxModel } from '../../engine/box-model';
import { moveBody, type StepInput } from '../../engine/physics';
import { BLOCK } from '../../engine/blocks';
import type { Game } from '../../game/game';
import { Mob, getSpawnDirector, registerMobType, seek, turnTowards, yawTo, type MobStats } from '../../mobs';
import { dropItem, getParticles } from '../../survival';
import { village } from '../../village';
import type { Bubble } from '../../village/ui/bubbles';
import { getHub } from '../hub';
import { itemIdOf, thingSpec, useOf, type LcThing } from './things';
import { expand, splitParts, voxelBounds, voxelGeometry, type SplitPart } from './voxel-model';

export const CREATURE_TYPE = 'lf_creature';

interface Built {
  body: THREE.BufferGeometry;
  parts: { part: SplitPart; geo: THREE.BufferGeometry }[];
  scale: number;
  centre: [number, number, number];
  height: number;
  width: number;
}

const built = new Map<string, Built>();

function buildFor(t: LcThing): Built {
  const key = `${t.id}:${t.version}`;
  const hit = built.get(key);
  if (hit) return hit;
  const model = t.thing.model;
  const c = t.thing.creature;
  const { voxels } = expand(model);
  const b = voxelBounds(voxels);
  const hv = Math.max(1, b.max[1]);
  const height = Math.max(0.5, Math.min(3, c?.size ?? 1));
  const scale = height / hv;
  const centre: [number, number, number] = [(b.min[0] + b.max[0]) / 2, 0, (b.min[2] + b.max[2]) / 2];
  const split = splitParts(model, c?.parts);
  const unit = 1;
  const out: Built = {
    body: voxelGeometry(model, { unit, origin: centre, subset: split.body }),
    parts: split.parts.map((part) => ({ part, geo: voxelGeometry(model, { unit, origin: part.joint, subset: part.voxels }) })),
    scale,
    centre,
    height,
    width: Math.max(0.35, Math.min(2.6, Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) * scale * 0.85)),
  };
  built.set(key, out);
  return out;
}

/** A BoxModel-compatible voxel body (the Mob base class animates, tints and tips it over like any mob). */
function voxelBoxModel(t: LcThing): BoxModel & { inner: THREE.Group; limbs: { group: THREE.Group; part: SplitPart }[] } {
  const b = buildFor(t);
  const root = new THREE.Group();
  const inner = new THREE.Group();
  inner.rotation.y = Math.PI; // models face +Z, entities face -Z
  inner.scale.setScalar(b.scale);
  root.add(inner);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const body = new THREE.Mesh(b.body, mat);
  inner.add(body);
  const parts: Record<string, THREE.Group> = { body: inner };
  const limbs: { group: THREE.Group; part: SplitPart }[] = [];
  for (const p of b.parts) {
    const g = new THREE.Group();
    g.position.set(p.part.joint[0] - b.centre[0], p.part.joint[1], p.part.joint[2] - b.centre[2]);
    g.add(new THREE.Mesh(p.geo, mat));
    inner.add(g);
    parts[p.part.name] = g;
    limbs.push({ group: g, part: p.part });
  }
  let flash = 0;
  let bright = 1;
  const apply = () => mat.color.setRGB(bright + flash * 0.8, bright * (1 - flash * 0.6), bright * (1 - flash * 0.6));
  const model = {
    root,
    parts,
    inner,
    limbs,
    setBrightness(v: number) {
      bright = v;
      apply();
    },
    flash(seconds = 0.35) {
      flash = Math.max(flash, Math.min(1, seconds / 0.35));
      apply();
    },
    tick(dt: number) {
      if (flash > 0) {
        flash = Math.max(0, flash - dt * 3);
        apply();
      }
    },
    dispose() {
      mat.dispose();
    },
  };
  root.userData.boxModel = model;
  return model;
}

/** A living forged creature. `data.thing` is its item (spawn egg) id. */
export class ForgedCreature extends Mob {
  readonly type = CREATURE_TYPE;
  readonly spec: LcThing;
  readonly vmodel: ReturnType<typeof voxelBoxModel>;
  tamed = false;
  stay = false;
  private bubble: Bubble | null = null;
  private soundTimer = 6 + Math.random() * 12;
  private layTimer = 40 + Math.random() * 30;
  private flyGoal = new THREE.Vector3(NaN, 0, 0);
  private flyTimer = 0;
  private swimTimer = 0;
  private clock = Math.random() * 10;
  private sitting = false;

  constructor(spec: LcThing) {
    const c = spec.thing.creature;
    const b = buildFor(spec);
    const beh = c?.behaviour ?? 'passive';
    const fights = beh === 'hostile' || beh === 'neutral' || beh === 'guard';
    const stats: MobStats = {
      maxHealth: Math.max(2, Math.min(200, Math.round(c?.health ?? 10))),
      speed: Math.max(0.6, Math.min(8, c?.speed ?? 2)),
      attackDamage: fights ? Math.max(1, Math.min(12, Math.round(spec.thing.stats.damage || 2 + b.height * 1.5))) : 0,
      attackCooldown: 1,
      reach: 0.6,
      followRange: beh === 'hostile' ? 18 : 12,
      hostility: beh === 'hostile' ? 'hostile' : beh === 'neutral' ? 'neutral' : 'passive',
      burnsInDaylight: false,
      drops: (c?.drops ?? []).map((d) => ({ item: itemIdOf(d), count: [1, 2] as [number, number] })),
      path: { height: Math.max(1, Math.ceil(b.height)) },
    };
    const model = voxelBoxModel(spec);
    super(model, stats, { width: b.width, height: b.height });
    this.spec = spec;
    this.vmodel = model;
    this.data.thing = spec.id;
  }

  get category(): 'hostile' | 'animal' {
    return this.behaviour === 'hostile' && !this.tamed ? 'hostile' : 'animal';
  }

  /** Current behaviour (a tamed creature is a pet). */
  get behaviour(): string {
    return this.tamed ? (this.spec.thing.creature?.behaviour === 'guard' ? 'guard' : 'pet') : this.spec.thing.creature?.behaviour ?? 'passive';
  }

  get flying(): boolean {
    return this.spec.thing.creature?.behaviour === 'flying';
  }

  /** Tames the creature (hearts; it follows you from now on). */
  tame(): void {
    this.tamed = true;
    this.stats.hostility = 'passive';
    this.stats.attackDamage = this.spec.thing.creature?.behaviour === 'guard' ? this.stats.attackDamage : 0;
    this.target = null;
    this.forcedTarget = null;
    this.hearts();
    this.updateName();
  }

  hearts(): void {
    getParticles(this.game).burst({ x: this.position.x, y: this.position.y + this.height + 0.2, z: this.position.z, count: 10, color: ['#ff4a6a', '#ff8aa0', '#ffd0d8'], speed: 0.8, up: 1.6, gravity: -0.6, size: 0.12, life: 1, spread: this.width / 2 });
  }

  /** Says one of its sounds in a speech bubble. */
  speak(text?: string): void {
    const sounds = this.spec.thing.creature?.sounds ?? [];
    const line = text ?? sounds[Math.floor(Math.random() * sounds.length)];
    if (!line) return;
    this.ensureBubble();
    void this.bubble?.say(line, { seconds: 2 });
  }

  private ensureBubble(): void {
    if (this.bubble || !this.game) return;
    try {
      this.bubble = village.bubbles.add(() => ({ x: this.position.x, y: this.position.y + this.height + 0.3, z: this.position.z }), this.label());
    } catch {
      this.bubble = null;
    }
  }

  private label(): string {
    return `${this.tamed ? '♥ ' : ''}${this.spec.thing.name}`;
  }

  updateName(): void {
    this.bubble?.setName(this.label());
  }

  update(dt: number): void {
    this.clock += dt;
    super.update(dt);
    if (this.removed || this.health <= 0) return;
    const p = this.game.player.position;
    const near = this.position.distanceTo(p) < 16;
    this.soundTimer -= dt;
    if (this.soundTimer <= 0) {
      this.soundTimer = 10 + Math.random() * 16;
      if (near) this.speak();
    }
    const lays = this.spec.thing.creature?.lays;
    if (lays) {
      this.layTimer -= dt;
      if (this.layTimer <= 0) {
        this.layTimer = 50 + Math.random() * 20;
        if (this.position.distanceTo(p) < 48) {
          dropItem(this.game, { item: itemIdOf(lays), count: 1 }, { x: this.position.x, y: this.position.y + 0.3, z: this.position.z });
          getParticles(this.game).burst({ x: this.position.x, y: this.position.y + 0.3, z: this.position.z, count: 6, color: ['#fff6c8', '#ffe27a'], speed: 0.8, up: 1, size: 0.06, life: 0.5 });
          if (near) this.speak();
        }
      }
    }
  }

  protected behave(dt: number): StepInput {
    const beh = this.behaviour;
    const g = this.game;
    const p = g.player.position;
    const dist = this.position.distanceTo(p);
    this.sitting = false;
    if (beh === 'guard') {
      const foe = g.entities.nearest(p, 12, (e) => e !== this && (e as Partial<Mob>).category === 'hostile' && e.health > 0 && !e.removed);
      if (foe) this.forcedTarget = { kind: 'entity', entity: foe };
      else if (this.forcedTarget?.kind === 'entity') this.forcedTarget = null;
      if (this.target) return this.flying ? {} : this.chase(dt, this.target, true);
    }
    if (beh === 'pet' || beh === 'guard') {
      if (g.player.sneaking || this.stay) {
        this.sitting = true;
        this.brain.stop();
        return { moveX: 0, moveZ: 0, jump: this.inWater };
      }
      if (dist > 24) {
        this.position.set(p.x + (Math.random() - 0.5) * 2, p.y + 0.2, p.z + (Math.random() - 0.5) * 2);
        this.velocity.set(0, 0, 0);
        this.brain.stop();
      }
      if (this.flying) return {};
      this.brain.speed = this.stats.speed * 1.2;
      if (dist > 3) this.brain.moveTo(p.x, p.y, p.z);
      else this.brain.stop();
      this.brain.lookTarget = tmpLook.set(p.x, p.y + 1, p.z);
      return this.brain.update(dt);
    }
    this.brain.lookTarget = null;
    if (this.flying) return {};
    if (this.spec.thing.creature?.behaviour === 'swimming') return this.swim(dt);
    return super.behave(dt);
  }

  private swim(dt: number): StepInput {
    const w = this.game.world;
    if (!this.inWater) return this.wander(dt);
    this.swimTimer -= dt;
    if (this.swimTimer <= 0 || Number.isNaN(this.flyGoal.x)) {
      this.swimTimer = 3 + Math.random() * 4;
      for (let i = 0; i < 8; i++) {
        const x = this.position.x + (Math.random() - 0.5) * 12, z = this.position.z + (Math.random() - 0.5) * 12;
        if (w.getBlock(Math.floor(x), Math.floor(this.position.y + 0.3), Math.floor(z)) === BLOCK.water) {
          this.flyGoal.set(x, this.position.y, z);
          break;
        }
      }
    }
    if (Number.isNaN(this.flyGoal.x)) return { jump: true };
    const input = seek(this, this.flyGoal.x, this.flyGoal.z, this.stats.speed * 0.8);
    input.jump = w.getBlock(Math.floor(this.position.x), Math.floor(this.position.y + this.height), Math.floor(this.position.z)) === BLOCK.water ? Math.random() < 0.5 : false;
    this.yaw = Math.atan2(-(input.moveX ?? 0), -(input.moveZ ?? 0));
    return input;
  }

  protected move(dt: number, input?: StepInput): number {
    if (!this.flying) return super.move(dt, input);
    // hover: steer towards a goal a few blocks above the ground (or the owner), no gravity, a gentle sine bob
    const g = this.game;
    const p = g.player.position;
    const pet = this.behaviour === 'pet' || this.behaviour === 'guard';
    this.flyTimer -= dt;
    if (pet && !this.sitting) this.flyGoal.set(p.x + Math.sin(this.clock * 0.7) * 2, p.y + 2.4, p.z + Math.cos(this.clock * 0.7) * 2);
    else if (this.target && !pet) {
      const tp = this.targetPosition(this.target, tmpLook);
      this.flyGoal.set(tp.x, tp.y + 1, tp.z);
    } else if (this.flyTimer <= 0 || Number.isNaN(this.flyGoal.x)) {
      this.flyTimer = 4 + Math.random() * 4;
      const x = this.position.x + (Math.random() - 0.5) * 16, z = this.position.z + (Math.random() - 0.5) * 16;
      const ground = g.world.findGround(x, z, Math.floor(this.position.y) + 8) ?? this.position.y;
      this.flyGoal.set(x, ground + 2 + Math.random() * 3, z);
    }
    const sit = this.sitting;
    const dx = this.flyGoal.x - this.position.x, dy = this.flyGoal.y - this.position.y + Math.sin(this.clock * 2.4) * 0.4, dz = this.flyGoal.z - this.position.z;
    const d = Math.hypot(dx, dy, dz) || 1;
    const sp = sit ? 0 : Math.min(this.stats.speed * this.speedMul, d * 1.5);
    const k = 1 - Math.exp(-3 * dt);
    this.velocity.x += ((dx / d) * sp - this.velocity.x) * k;
    this.velocity.y += ((sit ? -2 : (dy / d) * sp) - this.velocity.y) * k;
    this.velocity.z += ((dz / d) * sp - this.velocity.z) * k;
    if (Math.hypot(dx, dz) > 0.3 && !sit) turnTowards(this, yawTo(this, this.flyGoal.x, this.flyGoal.z), dt, 4);
    moveBody(g.world, this, dt);
    this.fallDistance = 0;
    if (this.target && !pet && this.attackTimer <= 0 && this.stats.attackDamage > 0) {
      const tp = this.targetPosition(this.target, tmpLook);
      if (this.position.distanceTo(tp) < this.stats.reach + 1.2) {
        this.attackTimer = this.stats.attackCooldown;
        this.meleeAttack(this.target);
      }
    }
    return 0;
  }

  protected animate(_dt: number): void {
    const m = this.vmodel;
    const t = this.clock;
    const walk = this.walkAmount;
    const flying = this.flying;
    const inner = m.inner;
    if (!m.limbs.length) {
      inner.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.08 * walk + (flying ? Math.sin(t * 3) * 0.08 : 0);
      inner.rotation.z = Math.sin(this.walkPhase) * 0.1 * walk;
    } else inner.position.y = flying ? Math.sin(t * 3) * 0.08 : 0;
    inner.rotation.x = this.sitting && !flying ? -0.12 : 0;
    for (const { group, part } of m.limbs) {
      if (part.kind === 'leg') {
        const off = (part.side < 0 ? 0 : Math.PI) + (part.fore < 0 ? 0 : Math.PI);
        group.rotation.x = flying ? 0.5 : this.sitting ? -1.2 : Math.sin(this.walkPhase + off) * 0.7 * walk;
      } else if (part.kind === 'wing') {
        const flap = flying ? Math.sin(t * 14) * 0.7 : Math.sin(t * 2) * 0.05 + (walk > 0.5 ? Math.sin(t * 10) * 0.25 : 0);
        group.rotation.z = (part.side || 1) * flap;
      } else if (part.kind === 'head') group.rotation.x = Math.sin(t * 2) * 0.08 + (walk > 0.2 ? Math.sin(this.walkPhase * 2) * 0.15 : 0);
      else if (part.kind === 'tail') group.rotation.y = Math.sin(t * 6) * 0.3;
    }
    if (this.swingTimer > 0) inner.rotation.x = -Math.sin((1 - this.swingTimer / 0.35) * Math.PI) * 0.25;
  }

  onDeath(source: Parameters<Mob['onDeath']>[0]): void {
    this.bubble?.remove();
    this.bubble = null;
    if (this.tamed) this.game.ui.toast(`${this.spec.thing.name} died`, { kind: 'warn' });
    super.onDeath(source);
  }

  onRemoved(): void {
    this.bubble?.remove();
    this.bubble = null;
    super.onRemoved();
  }
}

const tmpLook = new THREE.Vector3();

interface SavedCreature {
  thing: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  tamed?: boolean;
  stay?: boolean;
  health?: number;
}

/** Spawns, tames and saves forged creatures. */
export class Creatures {
  private pending: SavedCreature[] = [];

  constructor(private readonly game: Game) {
    registerMobType(CREATURE_TYPE, (o) => {
      const spec = thingSpec(String(o.data?.thing ?? ''));
      if (!spec) throw new Error(`no forged creature "${String(o.data?.thing)}"`);
      return new ForgedCreature(spec);
    });
    game.save.register('lf_creatures', () => this.serialize(), (d: SavedCreature[]) => {
      this.pending = Array.isArray(d) ? d : [];
      if (game.ready) this.restore();
    });
    game.events.on('ready', () => this.restore());
    // spawn eggs: right-click a block
    game.events.on('blockInteract', (e) => {
      const t = thingSpec(e.item?.item);
      if (!t || useOf(t) !== 'creature') return;
      e.handled = true;
      const hit = game.interaction.target;
      const at = hit ? hit.place : { x: e.x, y: e.y + 1, z: e.z };
      const mob = this.spawn(t, { x: at.x + 0.5, y: at.y, z: at.z + 0.5 });
      if (!mob) return;
      if (!game.inventory.infinite && game.player.mode !== 'creative') game.inventory.consumeSelected(1);
      mob.puff('#fff6d0');
      mob.speak();
      getHub().caption(`🥚 ${t.thing.name} hatched${t.thing.creature?.lays ? ` · it lays ${t.thing.creature.lays.replace(/_/g, ' ')}` : ''}${t.thing.creature?.tameWith ? ` · tame it with ${t.thing.creature.tameWith.replace(/_/g, ' ')}` : ''}`, 6);
      game.save.markDirty('lf_creatures');
    });
    // taming / stay
    game.events.on('entityInteract', (e) => {
      if (!(e.entity instanceof ForgedCreature)) return;
      const c = e.entity;
      e.handled = true;
      const tameWith = c.spec.thing.creature?.tameWith;
      const held = e.item?.item ?? '';
      if (!c.tamed && tameWith && held && (held === itemIdOf(tameWith) || held.includes(itemIdOf(tameWith)) || itemIdOf(tameWith).includes(held))) {
        if (!game.inventory.infinite && game.player.mode !== 'creative') game.inventory.consumeSelected(1);
        c.tame();
        c.speak();
        game.ui.toast(`♥ ${c.spec.thing.name} is now your pet`, { kind: 'good' });
        game.save.markDirty('lf_creatures');
      } else if (c.tamed) {
        c.stay = !c.stay;
        game.ui.toast(c.stay ? `${c.spec.thing.name} stays here` : `${c.spec.thing.name} follows you`, { seconds: 1.5 });
        c.hearts();
      } else {
        c.speak();
        if (tameWith) game.ui.toast(`Tame it with ${tameWith.replace(/_/g, ' ')}`, { seconds: 2 });
      }
    });
    game.events.on('entityDied', (e) => {
      if (e.entity instanceof ForgedCreature) game.save.markDirty('lf_creatures');
    });
  }

  /** Spawns a creature thing at a feet position. */
  spawn(t: LcThing, pos: { x: number; y: number; z: number }): ForgedCreature | null {
    const m = getSpawnDirector(this.game).spawnMob(CREATURE_TYPE, pos, { data: { thing: t.id }, persistent: true, reason: 'forge' });
    return m instanceof ForgedCreature ? m : null;
  }

  /** Every forged creature in the world. */
  all(): ForgedCreature[] {
    return this.game.entities.ofType<ForgedCreature>(CREATURE_TYPE).filter((c) => !c.removed && c.health > 0);
  }

  /** Rebuilds creatures of a thing that was refined (same item id, new model and behaviour). */
  refresh(t: LcThing): void {
    for (const c of this.all()) {
      if (c.spec.id !== t.id) continue;
      const m = this.spawn(t, c.position);
      if (m) {
        m.yaw = c.yaw;
        if (c.tamed) m.tame();
        m.stay = c.stay;
        m.speak();
      }
      c.remove();
    }
    this.game.save.markDirty('lf_creatures');
  }

  private serialize(): SavedCreature[] {
    const out: SavedCreature[] = this.all().map((c) => ({ thing: c.spec.id, x: c.position.x, y: c.position.y, z: c.position.z, yaw: c.yaw, ...(c.tamed ? { tamed: true } : {}), ...(c.stay ? { stay: true } : {}), health: c.health }));
    return [...out, ...this.pending];
  }

  private restore(): void {
    const list = this.pending;
    this.pending = [];
    for (const s of list) {
      const t = thingSpec(s.thing);
      if (!t) continue;
      const m = this.spawn(t, s);
      if (!m) continue;
      m.yaw = s.yaw ?? 0;
      if (s.tamed) {
        m.tamed = true;
        m.stats.hostility = 'passive';
        m.updateName();
      }
      m.stay = !!s.stay;
      if (s.health) m.health = Math.min(m.maxHealth, s.health);
    }
  }
}


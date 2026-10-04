/**
 * Forged vehicles (`forge.thing` category "vehicle"): the item places the vehicle (right-click a block); right-click
 * or E on it mounts it. W/S throttle towards `vehicle.speed`, A/D steer, Shift gets off (beside it).
 *
 * - ground / rail: gravity, climbs 1-block steps on its own, stopped by walls 2+ high, a wheel bob (rail puffs smoke);
 * - water: floats on the surface and crawls on land;
 * - air: Space climbs, Ctrl / C descends, banks into turns, no gravity while mounted (sinks slowly when empty).
 *
 * At speed it knocks mobs aside. Left-click it a few times (not mounted) to break it and get the item back.
 * Saved in `lf_vehicles` (item + position + yaw).
 */
import * as THREE from 'three';
import { Entity, type DamageSource } from '../../../engine/entity';
import { BLOCK, BLOCK_FLAGS, F_SOLID } from '../../../engine/blocks';
import { moveBody, stepBody } from '../../../engine/physics';
import type { Game } from '../../../game/game';
import type { Mob } from '../../../mobs';
import { getParticles, giveItem } from '../../../survival';
import { getHub } from '../../hub';
import { displayModel, thingSpec, useOf, type LcThing } from '../things';
import { expand, voxelBounds, voxelGeometry } from '../voxel-model';

export const VEHICLE_TYPE = 'lf_vehicle';

type Mode = 'ground' | 'rail' | 'water' | 'air';

/** The vehicle settings of a thing (defaults when the answer has none). */
export function vehicleOf(t: LcThing): { mode: Mode; speed: number; seats: number } {
  const v = (t.thing as { vehicle?: { mode?: string; speed?: number; seats?: number } | null }).vehicle ?? null;
  const words = `${t.thing.name} ${t.thing.tags.join(' ')}`.toLowerCase();
  const guess: Mode = /boat|ship|raft|canoe|yacht|submarine/.test(words) ? 'water' : /plane|rocket|jet|helicopter|airship|balloon|ufo|glider|dragon/.test(words) ? 'air' : /train|tram|locomotive|rail/.test(words) ? 'rail' : 'ground';
  const mode = (['ground', 'rail', 'water', 'air'] as Mode[]).includes(v?.mode as Mode) ? (v!.mode as Mode) : guess;
  return { mode, speed: Math.max(2, Math.min(30, v?.speed ?? 10)), seats: Math.max(1, Math.min(4, Math.round(v?.seats ?? 1))) };
}

const geoCache = new Map<string, { geo: THREE.BufferGeometry; scale: number; w: number; d: number; h: number }>();
function built(t: LcThing) {
  const k = `${t.id}:${t.version}`;
  let g = geoCache.get(k);
  if (!g) {
    const model = displayModel(t);
    const b = voxelBounds(expand(model).voxels);
    const w = b.max[0] - b.min[0], d = b.max[2] - b.min[2], h = b.max[1] - b.min[1];
    // world size: the long side becomes 2.5–6 blocks (a 16-voxel model is 3 blocks long)
    const long = Math.max(w, d, 1);
    const scale = Math.max(2.5, Math.min(6, (long / 16) * 3)) / long;
    g = { geo: voxelGeometry(model, { unit: scale, origin: [(b.min[0] + b.max[0]) / 2, b.min[1], (b.min[2] + b.max[2]) / 2] }), scale, w: w * scale, d: d * scale, h: h * scale };
    geoCache.set(k, g);
  }
  return g;
}

/** A placed vehicle. `control` is set by the rider every frame. */
export class Vehicle extends Entity {
  readonly type = VEHICLE_TYPE;
  readonly spec: LcThing;
  readonly mode: Mode;
  readonly topSpeed: number;
  readonly control = { throttle: 0, steer: 0, lift: 0 };
  rider = false;
  /** Signed forward speed (blocks/s). */
  speed = 0;
  private readonly inner: THREE.Mesh;
  private readonly mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private hits = 0;
  private hitDecay = 0;
  private dist = 0;
  private bank = 0;
  private smoke = 0;

  constructor(spec: LcThing) {
    super();
    this.spec = spec;
    const v = vehicleOf(spec);
    this.mode = v.mode;
    this.topSpeed = v.speed;
    const b = built(spec);
    this.width = Math.max(0.8, Math.min(2.2, Math.min(b.w, b.d)));
    this.height = Math.max(0.6, Math.min(2.5, b.h));
    this.maxHealth = this.health = 1000;
    const group = new THREE.Group();
    this.inner = new THREE.Mesh(b.geo, this.mat);
    this.inner.rotation.order = 'YXZ';
    this.inner.rotation.y = Math.PI;
    group.add(this.inner);
    this.object3d = group;
    this.data.thing = spec.id;
  }

  /** Seat height above the vehicle's feet. */
  get seatY(): number {
    return Math.max(0.3, this.height * 0.45);
  }

  update(dt: number): void {
    const g = this.game;
    const w = g.world;
    const c = this.control;
    const air = this.mode === 'air';
    const water = this.mode === 'water';
    this.hitDecay -= dt;
    if (this.hitDecay <= 0) this.hits = 0;
    // throttle
    const target = this.rider ? (c.throttle > 0 ? this.topSpeed : c.throttle < 0 ? -this.topSpeed * 0.4 : 0) : 0;
    const landBoat = water && !this.inWater && this.onGround;
    const cap = landBoat ? this.topSpeed * 0.12 : this.topSpeed;
    const accel = (target === 0 ? 6 : 3 + this.topSpeed * 0.25) * dt;
    this.speed += Math.max(-accel, Math.min(accel, target - this.speed));
    this.speed = Math.max(-cap, Math.min(cap, this.speed));
    if (landBoat) this.speed *= Math.pow(0.2, dt);
    // steering (reverse steers the other way); turning slows with speed a little
    const turn = c.steer * dt * (1.9 - Math.min(0.9, Math.abs(this.speed) / 30)) * (this.speed < -0.2 ? -1 : 1) * (Math.abs(this.speed) > 0.3 || air ? 1 : 0.4);
    this.yaw += turn;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    this.velocity.x = fx * this.speed;
    this.velocity.z = fz * this.speed;

    if (air) {
      if (this.rider) this.velocity.y += (c.lift * Math.max(3, this.topSpeed * 0.4) - this.velocity.y) * Math.min(1, dt * 3);
      else this.velocity.y = this.onGround ? 0 : -0.8;
      moveBody(w, this, dt);
      this.fallDistance = 0;
    } else if (water) {
      const wetHigh = w.getBlock(Math.floor(this.position.x), Math.floor(this.position.y + 0.45), Math.floor(this.position.z)) === BLOCK.water;
      const wetLow = w.getBlock(Math.floor(this.position.x), Math.floor(this.position.y + 0.1), Math.floor(this.position.z)) === BLOCK.water;
      if (wetHigh) {
        this.velocity.y = 1.8;
        moveBody(w, this, dt);
      } else if (wetLow) {
        this.velocity.y = Math.sin(performance.now() / 600) * 0.15;
        moveBody(w, this, dt);
      } else stepBody(w, this, dt, { moveX: this.velocity.x, moveZ: this.velocity.z, accel: 30 });
      this.fallDistance = 0;
    } else {
      // ground / rail: hop 1-block steps, walls 2+ high stop it
      let jump = false;
      if (this.onGround && Math.abs(this.speed) > 0.5) {
        const dir = Math.sign(this.speed);
        const ax = Math.floor(this.position.x + fx * dir * (this.width / 2 + 0.45)), az = Math.floor(this.position.z + fz * dir * (this.width / 2 + 0.45));
        const y = Math.floor(this.position.y + 0.05);
        const solid = (yy: number) => (BLOCK_FLAGS[w.getBlock(ax, yy, az)] & F_SOLID) !== 0;
        if (solid(y) && !solid(y + 1) && !solid(y + 2)) jump = true;
        else if (solid(y) && solid(y + 1)) this.speed *= 0.2;
      }
      stepBody(w, this, dt, { moveX: this.velocity.x, moveZ: this.velocity.z, accel: 30, jump, jumpVelocity: 8.6 });
      if (!this.rider) this.fallDistance = 0;
    }
    if (this.collidedHorizontally) this.speed *= 0.5;

    // look: wheel bob, banking, smoke
    this.dist += Math.abs(this.speed) * dt;
    const moving = Math.abs(this.speed) > 0.3;
    this.inner.position.y = !air && !water && moving && this.onGround ? Math.abs(Math.sin(this.dist * 3.2)) * 0.035 : water ? Math.sin(performance.now() / 500) * 0.04 : 0;
    this.bank += ((air ? -c.steer * 0.35 * Math.min(1, Math.abs(this.speed) / 4) : 0) - this.bank) * Math.min(1, dt * 4);
    this.inner.rotation.z = this.bank;
    this.inner.rotation.x = air ? -c.lift * 0.12 : water ? Math.sin(performance.now() / 700) * 0.03 : 0;
    if ((this.mode === 'rail' || air) && moving && this.rider) {
      this.smoke -= dt;
      if (this.smoke <= 0) {
        this.smoke = air ? 0.06 : 0.18;
        const back = air ? -1 : 1;
        getParticles(g).burst({ x: this.position.x - fx * back * this.width * 0.4, y: this.position.y + this.height * (air ? 0.4 : 1), z: this.position.z - fz * back * this.width * 0.4, count: air ? 2 : 3, color: air ? ['#ffd28a', '#ff8a3a', '#d8d8d8'] : ['#e8e8e8', '#bdbdbd', '#9a9a9a'], speed: 0.5, up: air ? 0 : 1.6, gravity: -0.6, size: air ? 0.1 : 0.22, life: air ? 0.4 : 1.2, spread: 0.2 });
      }
    }
    // knock mobs aside at speed
    if (Math.abs(this.speed) > 3) {
      for (const e of g.entities.query(this.position, this.width / 2 + 1.2, (e) => e !== this && e.type !== VEHICLE_TYPE && e.type !== 'lf_decor' && !e.removed && e.health > 0)) {
        const dx = e.position.x - this.position.x, dz = e.position.z - this.position.z;
        const d = Math.hypot(dx, dz) || 1;
        if (Math.abs(e.position.y - this.position.y) > this.height + 0.5) continue;
        const k = Math.abs(this.speed);
        e.velocity.x += (dx / d) * k * 0.9 + fx * this.speed * 0.4;
        e.velocity.z += (dz / d) * k * 0.9 + fz * this.speed * 0.4;
        e.velocity.y = Math.max(e.velocity.y, 5);
        if ((e as Partial<Mob>).category) e.hurt(Math.max(1, Math.round(k / 4)), { kind: 'melee', player: true });
      }
    }
  }

  hurt(_amount: number, source: DamageSource): boolean {
    if (this.removed || !source.player || this.rider) return false;
    const g = this.game;
    this.hits++;
    this.hitDecay = 2;
    this.speed = 0;
    getParticles(g).burst({ x: this.position.x, y: this.position.y + this.height / 2, z: this.position.z, count: 6, color: Object.values(this.spec.thing.model.palette).slice(0, 3), speed: 1.5, up: 1, size: 0.08, life: 0.4, spread: this.width / 2 });
    if (this.hits < 3) {
      g.ui.toast(`${this.spec.thing.name}: ${3 - this.hits} more hit${this.hits === 2 ? '' : 's'} to pick it up`, { seconds: 1 });
      return true;
    }
    if (!g.inventory.infinite && g.player.mode !== 'creative') giveItem(g, this.spec.id, 1, { dropOverflow: true });
    else if (g.inventory.count(this.spec.id) === 0) giveItem(g, this.spec.id, 1);
    this.remove();
    g.save.markDirty('lf_vehicles');
    return true;
  }

  applyBrightness(b: number): void {
    this.mat.color.setScalar(b);
  }

  onRemoved(): void {
    this.mat.dispose();
  }
}

interface SavedVehicle {
  item: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Placing, riding and saving vehicles. */
export class Vehicles {
  mounted: Vehicle | null = null;
  private pending: SavedVehicle[] = [];
  private readonly hint: HTMLElement;

  constructor(private readonly game: Game) {
    this.hint = document.createElement('div');
    this.hint.className = 'lcx-ride';
    this.hint.style.display = 'none';
    game.ui.mount('bottom-center', this.hint, { order: 50 });
    game.save.register('lf_vehicles', () => this.serialize(), (d: SavedVehicle[]) => {
      this.pending = Array.isArray(d) ? d : [];
      if (game.ready) this.restore();
    });
    game.events.on('ready', () => this.restore());
    // place: right-click a block with a vehicle item
    game.events.on('blockInteract', (e) => {
      const t = thingSpec(e.item?.item);
      if (!t || useOf(t) !== 'vehicle') return;
      e.handled = true;
      const hit = game.interaction.target;
      if (!hit) return;
      const v = this.place(t, { x: hit.place.x + 0.5, y: hit.place.y, z: hit.place.z + 0.5 }, game.player.yaw);
      if (!game.inventory.infinite && game.player.mode !== 'creative') game.inventory.consumeSelected(1);
      game.interaction.onSwing?.();
      const info = vehicleOf(t);
      getHub().caption(`🚂 ${t.thing.name} (${info.mode}, ${info.speed} blocks/s): right-click or E to ride`, 5);
      void v;
    });
    // mount: right-click it
    game.events.on('entityInteract', (e) => {
      if (!(e.entity instanceof Vehicle)) return;
      e.handled = true;
      this.mount(e.entity);
    });
    // E on a vehicle mounts it (capture phase: before the inventory key)
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'KeyE' || e.repeat || !game.ready || game.ui.screens.isOpen || this.mounted) return;
      const t = game.interaction.targetEntity;
      if (!(t instanceof Vehicle)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.mount(t);
    }, { capture: true });
    game.addSystem({ name: 'forge-vehicles', update: (dt) => this.update(dt) });
  }

  /** Places a vehicle at a feet position. */
  place(t: LcThing, pos: { x: number; y: number; z: number }, yaw: number): Vehicle {
    const v = new Vehicle(t);
    v.position.set(pos.x, pos.y, pos.z);
    v.yaw = yaw;
    this.game.entities.add(v);
    getParticles(this.game).burst({ x: pos.x, y: pos.y + 0.3, z: pos.z, count: 14, color: ['#ffffff', '#d8d8d8'], speed: 1.4, up: 0.8, size: 0.1, life: 0.5, spread: v.width / 2 });
    this.game.save.markDirty('lf_vehicles');
    return v;
  }

  /** Gets in. */
  mount(v: Vehicle): void {
    if (this.mounted || v.removed) return;
    const g = this.game;
    this.mounted = v;
    v.rider = true;
    g.player.frozen = true;
    g.player.velocity.set(0, 0, 0);
    g.player.yaw = v.yaw;
    const info = vehicleOf(v.spec);
    this.hint.textContent = `${v.spec.thing.name} · W/S throttle · A/D steer${info.mode === 'air' ? ' · Space up · Ctrl/C down' : ''} · Shift to get off`;
    this.hint.style.display = '';
    g.ui.toast(`Riding ${v.spec.thing.name}`, { seconds: 1.5 });
  }

  /** Gets off beside the vehicle. */
  dismount(): void {
    const v = this.mounted;
    if (!v) return;
    const g = this.game;
    this.mounted = null;
    v.rider = false;
    v.control.throttle = v.control.steer = v.control.lift = 0;
    this.hint.style.display = 'none';
    const rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw);
    const off = v.width / 2 + 0.8;
    let placed = false;
    for (const side of [1, -1]) {
      const x = v.position.x + rx * off * side, z = v.position.z + rz * off * side;
      const y = g.world.findGround(x, z, Math.floor(v.position.y) + 3);
      if (y !== null && Math.abs(y - v.position.y) < 4) {
        g.player.teleport(x, y, z);
        placed = true;
        break;
      }
    }
    if (!placed) g.player.teleport(v.position.x, v.position.y + v.height + 0.1, v.position.z);
    g.player.frozen = false;
    g.save.markDirty('lf_vehicles');
  }

  private update(_dt: number): void {
    const v = this.mounted;
    if (!v) return;
    const g = this.game;
    const input = g.input;
    const p = g.player;
    if (v.removed) {
      this.mounted = null;
      this.hint.style.display = 'none';
      p.frozen = false;
      return;
    }
    if (g.ui.screens.isOpen) {
      v.control.throttle = v.control.steer = v.control.lift = 0;
    } else {
      if (input.wasPressed('ShiftLeft') || input.wasPressed('ShiftRight')) return this.dismount();
      // mouse look (the player controller is frozen while riding)
      const s = g.settings.sensitivity * 0.0022;
      p.yaw -= input.mouseDX * s;
      p.pitch = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, p.pitch - input.mouseDY * s));
      v.control.throttle = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
      v.control.steer = (input.isDown('KeyA') ? 1 : 0) - (input.isDown('KeyD') ? 1 : 0);
      v.control.lift = (input.isDown('Space') ? 1 : 0) - (input.isDown('ControlLeft') || input.isDown('KeyC') ? 1 : 0);
    }
    // the camera turns with the vehicle
    const turned = v.yaw - ((v.data.lastYaw as number | undefined) ?? v.yaw);
    v.data.lastYaw = v.yaw;
    p.yaw += turned;
    p.position.set(v.position.x, v.position.y + v.seatY - 0.55, v.position.z);
    p.velocity.set(0, 0, 0);
    p.fallDistance = 0;
    if (!p.frozen) this.dismount();
  }

  private serialize(): SavedVehicle[] {
    const live = this.game.entities.ofType<Vehicle>(VEHICLE_TYPE).filter((v) => !v.removed).map((v) => ({ item: v.spec.id, x: v.position.x, y: v.position.y, z: v.position.z, yaw: v.yaw }));
    return [...live, ...this.pending];
  }

  private restore(): void {
    const list = this.pending;
    this.pending = [];
    for (const s of list) {
      const t = thingSpec(s.item);
      if (t) this.place(t, s, s.yaw);
    }
  }

  /** Rebuilds placed vehicles of a refined thing. */
  refresh(t: LcThing): void {
    for (const v of this.game.entities.ofType<Vehicle>(VEHICLE_TYPE)) {
      if (v.spec.id !== t.id || v.removed) continue;
      const wasRiding = this.mounted === v;
      if (wasRiding) this.dismount();
      const n = this.place(t, v.position, v.yaw);
      v.remove();
      if (wasRiding) this.mount(n);
    }
  }
}

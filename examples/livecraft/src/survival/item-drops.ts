/**
 * Item entities: dropped blocks/items shown as small spinning cubes (block items) or sprites,
 * with gravity, a pickup magnet and stack merging.
 *
 * These are not `Entity` instances on purpose: they must not be hit by the player's attack
 * raycast or show up in mob/villager queries. Use {@link dropItem} to create one.
 */
import * as THREE from 'three';
import { blockById } from '../engine/blocks';
import { ATLAS_SIZE, SLOTS_PER_ROW, SLOT_PAD, SLOT_SIZE } from '../engine/constants';
import { findItem, type ItemStack } from '../engine/items';
import { stepBody, type Body } from '../engine/physics';
import type { Game } from '../game/game';
import { service } from './service';

const MAX_DROPS = 300;
const LIFETIME = 300;
const MAGNET_RADIUS = 2.6;
const PICKUP_RADIUS = 1.1;

export interface DropOptions {
  /** Initial velocity (blocks/s). Default: a small random pop. */
  velocity?: { x: number; y: number; z: number };
  /** Seconds before the player can pick it up. Default 0.5. */
  pickupDelay?: number;
}

/** One item lying in the world. */
export class ItemDrop implements Body {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  width = 0.25;
  height = 0.25;
  onGround = false;
  inWater = false;
  inLava = false;
  onLadder = false;
  collidedHorizontally = false;
  fallDistance = 0;
  age = 0;
  pickupDelay = 0.5;
  removed = false;
  readonly spin = Math.random() * Math.PI * 2;
  readonly object3d = new THREE.Group();

  constructor(public stack: ItemStack) {}
}

export class ItemDrops {
  private readonly drops: ItemDrop[] = [];
  private readonly group = new THREE.Group();
  private readonly atlasTex: THREE.Texture;
  private readonly spriteCache = new Map<string, THREE.Texture>();
  private atlasVersion = -1;
  private mergeTimer = 0;
  private lightTimer = 0;

  constructor(private readonly game: Game) {
    this.group.name = 'item-drops';
    game.scene.add(this.group);
    this.atlasTex = game.atlas.texture.clone();
    this.atlasTex.colorSpace = THREE.SRGBColorSpace;
    game.addSystem({ name: 'item-drops', update: (dt) => this.update(dt) });
  }

  /** All live drops (read-only). */
  all(): readonly ItemDrop[] {
    return this.drops;
  }

  /** Spawns a dropped stack at a world position. Returns the drop, or null for unknown items. */
  drop(stack: ItemStack, pos: { x: number; y: number; z: number }, opts: DropOptions = {}): ItemDrop | null {
    if (!stack || stack.count <= 0 || !findItem(stack.item)) return null;
    const d = new ItemDrop({ ...stack });
    d.position.set(pos.x, pos.y, pos.z);
    if (opts.velocity) d.velocity.set(opts.velocity.x, opts.velocity.y, opts.velocity.z);
    else d.velocity.set((Math.random() - 0.5) * 2.5, 3 + Math.random() * 1.5, (Math.random() - 0.5) * 2.5);
    d.pickupDelay = opts.pickupDelay ?? 0.5;
    const mesh = this.buildMesh(stack.item);
    if (mesh) {
      d.object3d.add(mesh);
      if (stack.count > 1) {
        const extra = new THREE.Mesh(mesh.geometry.clone(), (mesh.material as THREE.Material).clone());
        extra.position.set(0.06, 0.05, 0.05);
        d.object3d.add(extra);
      }
    }
    d.object3d.position.copy(d.position);
    this.group.add(d.object3d);
    this.drops.push(d);
    if (this.drops.length > MAX_DROPS) this.remove(this.drops[0]);
    return d;
  }

  /** Removes a drop. */
  remove(d: ItemDrop): void {
    if (d.removed) return;
    d.removed = true;
    const i = this.drops.indexOf(d);
    if (i >= 0) this.drops.splice(i, 1);
    this.group.remove(d.object3d);
    d.object3d.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
  }

  private buildMesh(name: string): THREE.Mesh | null {
    const item = findItem(name);
    if (!item) return null;
    if (this.atlasVersion !== this.game.atlas.version) {
      this.atlasVersion = this.game.atlas.version;
      this.atlasTex.needsUpdate = true;
    }
    if (item.icon === null && item.block !== null) {
      const def = blockById(item.block);
      const geo = new THREE.BoxGeometry(0.25, 0.25, 0.25);
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      const colors = new Float32Array(uv.count * 3);
      const shades = [0.8, 0.8, 1, 0.6, 0.9, 0.9];
      for (let f = 0; f < 6; f++) {
        const slot = this.game.atlas.slot(def.faces[f === 4 ? 5 : f]);
        const u0 = ((slot % SLOTS_PER_ROW) * SLOT_SIZE + SLOT_PAD) / ATLAS_SIZE;
        const v0 = (Math.floor(slot / SLOTS_PER_ROW) * SLOT_SIZE + SLOT_PAD) / ATLAS_SIZE;
        const ts = 16 / ATLAS_SIZE;
        for (let v = 0; v < 4; v++) {
          const i = f * 4 + v;
          uv.setXY(i, u0 + uv.getX(i) * ts, v0 + (1 - uv.getY(i)) * ts);
          colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = shades[f];
        }
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.translate(0, 0.125, 0);
      return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: this.atlasTex, alphaTest: 0.5, vertexColors: true }));
    }
    const key = item.icon ?? name;
    let tex = this.spriteCache.get(key);
    if (!tex) {
      tex = new THREE.CanvasTexture(this.game.atlas.tileCanvas(key));
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.colorSpace = THREE.SRGBColorSpace;
      this.spriteCache.set(key, tex);
    }
    const geo = new THREE.PlaneGeometry(0.4, 0.4);
    geo.translate(0, 0.2, 0);
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide }));
  }

  private update(dt: number): void {
    const game = this.game;
    const player = game.player;
    const px = player.position.x, py = player.position.y + 0.8, pz = player.position.z;
    const canPick = !player.frozen;
    const t = performance.now() / 1000;

    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.age += dt;
      d.pickupDelay -= dt;
      if (d.age > LIFETIME) {
        this.remove(d);
        continue;
      }
      if (!game.world.isLoaded(d.position.x, d.position.z)) continue;
      const dx = px - d.position.x, dy = py - d.position.y, dz = pz - d.position.z;
      const dist = Math.hypot(dx, dy, dz);
      if (canPick && d.pickupDelay <= 0 && dist < MAGNET_RADIUS && hasRoom(game, d.stack)) {
        if (dist < PICKUP_RADIUS) {
          const left = game.inventory.add(d.stack);
          const taken = d.stack.count - left;
          if (taken > 0) {
            game.events.emit('itemPickedUp', { item: d.stack.item, count: taken });
            d.stack.count = left;
            if (left <= 0) {
              this.remove(d);
              continue;
            }
          }
        } else {
          // Magnet: pull towards the player.
          const k = 50 / Math.max(0.5, dist);
          d.velocity.x += (dx / dist) * k * dt;
          d.velocity.y += (dy / dist) * k * dt + 20 * dt;
          d.velocity.z += (dz / dist) * k * dt;
        }
      }
      stepBody(game.world, d, dt);
      if (d.onGround) {
        d.velocity.x *= Math.pow(0.02, dt);
        d.velocity.z *= Math.pow(0.02, dt);
      }
      if (d.inLava) {
        this.remove(d);
        continue;
      }
      if (d.inWater) d.velocity.y += 34 * dt;
      d.object3d.position.set(d.position.x, d.position.y + 0.08 + Math.sin(t * 2.4 + d.spin) * 0.06, d.position.z);
      d.object3d.rotation.y = t * 1.6 + d.spin;
      // Blink before despawning.
      d.object3d.visible = d.age < LIFETIME - 10 || Math.floor(t * 6) % 2 === 0;
    }

    this.mergeTimer -= dt;
    if (this.mergeTimer <= 0) {
      this.mergeTimer = 0.75;
      this.merge();
    }
    this.lightTimer -= dt;
    if (this.lightTimer <= 0) {
      this.lightTimer = 0.25;
      const dl = game.time.daylight;
      for (const d of this.drops) {
        const x = Math.floor(d.position.x), y = Math.floor(d.position.y + 0.1), z = Math.floor(d.position.z);
        const sky = game.world.getSkyLight(x, y, z) / 15, blk = game.world.getBlockLight(x, y, z) / 15;
        const b = 0.25 + 0.75 * Math.max(sky * (0.2 + 0.8 * dl), blk);
        d.object3d.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) (m.material as THREE.MeshBasicMaterial).color.setScalar(b);
        });
      }
    }
  }

  private merge(): void {
    for (let i = 0; i < this.drops.length; i++) {
      const a = this.drops[i];
      if (a.removed || a.stack.data || a.stack.damage) continue;
      const max = findItem(a.stack.item)?.maxStack ?? 64;
      if (a.stack.count >= max) continue;
      for (let j = i + 1; j < this.drops.length; j++) {
        const b = this.drops[j];
        if (b.removed || b.stack.item !== a.stack.item || b.stack.data || b.stack.damage) continue;
        if (a.position.distanceToSquared(b.position) > 1.2) continue;
        const n = Math.min(max - a.stack.count, b.stack.count);
        if (n <= 0) continue;
        a.stack.count += n;
        b.stack.count -= n;
        if (b.stack.count <= 0) this.remove(b);
      }
    }
  }
}

function hasRoom(game: Game, stack: ItemStack): boolean {
  const def = findItem(stack.item);
  if (!def) return false;
  for (const s of game.inventory.slots) {
    if (!s) return true;
    if (s.item === stack.item && !s.data && !stack.data && !s.damage && s.count < def.maxStack) return true;
  }
  return false;
}

/** The game's item drop system (created on first use). */
export const getItemDrops = service((game) => new ItemDrops(game));

/**
 * Drops a stack into the world as an item entity.
 * ```ts
 * dropItem(game, { item: 'diamond', count: 2 }, { x, y: y + 0.5, z });
 * ```
 */
export function dropItem(game: Game, stack: ItemStack, pos: { x: number; y: number; z: number }, opts?: DropOptions): ItemDrop | null {
  return getItemDrops(game).drop(stack, pos, opts);
}

/** Drops several stacks at one spot, each with its own random pop. */
export function dropItems(game: Game, stacks: readonly (ItemStack | null)[], pos: { x: number; y: number; z: number }): void {
  for (const s of stacks) if (s && s.count > 0) dropItem(game, s, pos);
}

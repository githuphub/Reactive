/**
 * Explosions (creepers, TNT, scripted effects): carve a rough sphere of blocks (respecting
 * hardness: obsidian and bedrock survive), drop some of the debris, damage and knock back
 * entities and the player, chain-prime TNT, and show a flash + smoke.
 *
 * ```ts
 * explode(game, x, y, z, { radius: 3, byEntity: creeper });
 * primeTnt(game, x, y, z);
 * ```
 */
import * as THREE from 'three';
import { BLOCK, blockById } from '../engine/blocks';
import { bodyCollides, stepBody, type Body } from '../engine/physics';
import { computeDrops } from '../engine/items';
import type { Entity } from '../engine/entity';
import type { Game } from '../game/game';
import { getHealth } from '../survival/health';
import { getParticles } from '../survival/particles';
import { service } from '../survival/service';
import { hasLineOfSight } from './brain';

export interface ExplosionOptions {
  /** Block radius. Default 3 (creeper). TNT uses 4. */
  radius?: number;
  /** Strength multiplier for block breaking and damage. Default 1. */
  power?: number;
  /** Break blocks. Default true. */
  breakBlocks?: boolean;
  /** Fraction of broken blocks that drop as items. Default 0.3. */
  dropChance?: number;
  /** Responsible entity (excluded from damage). */
  byEntity?: Entity | null;
  /** Block-change source tag. Default 'explosion'. */
  source?: string;
  /** Max damage at the centre in half-hearts. Default 18 × power. */
  maxDamage?: number;
}

const HARVEST_ALL = { item: 'diamond_pickaxe', count: 1 };

/** Detonates an explosion at a point. Returns the number of blocks destroyed. */
export function explode(game: Game, x: number, y: number, z: number, opts: ExplosionOptions = {}): number {
  const r = opts.radius ?? 3;
  const power = opts.power ?? 1;
  const source = opts.source ?? 'explosion';
  const world = game.world;
  let broken = 0;
  if (opts.breakBlocks !== false) {
    const rr = r + 0.5;
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    const cells: [number, number, number, number][] = [];
    for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++)
      for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++)
        for (let dz = -Math.ceil(r); dz <= Math.ceil(r); dz++) {
          const cx = bx + dx, cy = by + dy, cz = bz + dz;
          const d = Math.hypot(cx + 0.5 - x, cy + 0.5 - y, cz + 0.5 - z);
          if (d <= rr) cells.push([cx, cy, cz, d]);
        }
    cells.sort((a, b) => a[3] - b[3]);
    for (const [cx, cy, cz, d] of cells) {
      const id = world.getBlock(cx, cy, cz);
      if (id === BLOCK.air) continue;
      const def = blockById(id);
      if (def.liquid || def.hardness < 0 || def.hardness >= 20) continue;
      const strength = power * (1 - d / rr) * (0.7 + Math.random() * 0.6) * 4;
      if (strength <= def.hardness + 0.3) continue;
      if (id === BLOCK.tnt) {
        world.setBlock(cx, cy, cz, BLOCK.air, { source, drops: [] });
        primeTnt(game, cx, cy, cz, 0.4 + Math.random() * 0.8);
        continue;
      }
      const meta = world.getMeta(cx, cy, cz);
      const drops = Math.random() < (opts.dropChance ?? 0.3) ? computeDrops(def, meta, HARVEST_ALL) : [];
      if (world.setBlock(cx, cy, cz, BLOCK.air, { source, drops, entity: opts.byEntity ?? undefined })) broken++;
    }
  }

  // Damage + knockback.
  const center = tmpCenter.set(x, y, z);
  const reach = r * 2;
  const maxDamage = opts.maxDamage ?? 18 * power;
  for (const e of game.entities.query(center, reach + 1)) {
    if (e === opts.byEntity || e.removed) continue;
    const mid = tmpMid.set(e.position.x, e.position.y + e.height / 2, e.position.z);
    const d = mid.distanceTo(center);
    if (d > reach) continue;
    const exposure = hasLineOfSight(world, center, mid) ? 1 : 0.35;
    const impact = (1 - d / reach) * exposure;
    const dmg = Math.floor(((impact * impact + impact) / 2) * maxDamage + 1);
    e.hurtCooldown = 0;
    e.hurt(dmg, { kind: 'explosion', entity: opts.byEntity ?? null });
    const k = tmpK.subVectors(mid, center).normalize().multiplyScalar(impact * 14);
    e.velocity.x += k.x;
    e.velocity.z += k.z;
    e.velocity.y = Math.max(e.velocity.y, 3 + impact * 7);
  }
  const p = game.player;
  const pmid = tmpMid.set(p.position.x, p.position.y + 0.9, p.position.z);
  const pd = pmid.distanceTo(center);
  if (pd < reach && !p.frozen) {
    const exposure = hasLineOfSight(world, center, pmid) ? 1 : 0.35;
    const impact = (1 - pd / reach) * exposure;
    const dmg = Math.floor(((impact * impact + impact) / 2) * maxDamage + 1);
    const k = tmpK.subVectors(pmid, center).normalize().multiplyScalar(impact * 12);
    const health = getHealth(game);
    health.hurtCooldown = 0;
    health.hurt(dmg, { kind: 'explosion', entity: opts.byEntity ?? null, knockback: { x: k.x, y: 3 + impact * 6, z: k.z } });
    if (p.mode === 'creative') {
      p.velocity.x += k.x;
      p.velocity.z += k.z;
    }
  }

  // Visuals.
  const fx = getParticles(game);
  fx.burst({ x, y, z, count: 40 + r * 8, color: ['#ffffff', '#e0e0e0', '#bdbdbd', '#8a8a8a'], speed: r * 2.5, up: 1.5, gravity: -1.5, life: 1.4, size: 0.35, spread: r * 0.5 });
  fx.burst({ x, y, z, count: 30, color: ['#ffd23a', '#ff8a1e', '#ff5a14'], speed: r * 3.5, up: 2, gravity: 4, life: 0.6, size: 0.18, spread: 0.6 });
  fx.burst({ x, y, z, count: 20, color: ['#6b4a31', '#777777', '#4c8631'], speed: r * 3, up: 5, gravity: 18, life: 1.2, size: 0.12, spread: 0.8 });
  getExplosionFx(game).flash(x, y, z, r);
  game.events.emit('explosion', { x, y, z, radius: r, source, blocks: broken });
  return broken;
}

const tmpCenter = new THREE.Vector3();
const tmpMid = new THREE.Vector3();
const tmpK = new THREE.Vector3();

// -- flash + primed TNT --------------------------------------------------------------------------

class PrimedTnt implements Body {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  width = 0.98;
  height = 0.98;
  onGround = false;
  inWater = false;
  inLava = false;
  onLadder = false;
  collidedHorizontally = false;
  fallDistance = 0;
  constructor(public fuse: number, readonly mesh: THREE.Mesh) {}
}

class ExplosionFx {
  private readonly flashes: { mesh: THREE.Mesh; light: THREE.PointLight; t: number; r: number }[] = [];
  private readonly tnts: PrimedTnt[] = [];
  private readonly sphere = new THREE.SphereGeometry(1, 16, 12);
  private tntMat: THREE.MeshBasicMaterial[] | null = null;

  constructor(private readonly game: Game) {
    game.addSystem({ name: 'explosion-fx', update: (dt) => this.update(dt) });
  }

  flash(x: number, y: number, z: number, r: number): void {
    const mesh = new THREE.Mesh(this.sphere, new THREE.MeshBasicMaterial({ color: 0xfff4d0, transparent: true, opacity: 0.85, depthWrite: false }));
    mesh.position.set(x, y, z);
    const light = new THREE.PointLight(0xffb060, 6, r * 6);
    light.position.set(x, y, z);
    this.game.scene.add(mesh, light);
    this.flashes.push({ mesh, light, t: 0, r });
  }

  prime(x: number, y: number, z: number, fuse: number): void {
    if (!this.tntMat) {
      const tex = (key: string) => {
        const t = new THREE.CanvasTexture(this.game.atlas.tileCanvas(key));
        t.magFilter = THREE.NearestFilter;
        t.minFilter = THREE.NearestFilter;
        t.colorSpace = THREE.SRGBColorSpace;
        return new THREE.MeshBasicMaterial({ map: t });
      };
      const side = tex('tnt_side');
      this.tntMat = [side, side, tex('tnt_top'), tex('tnt_bottom'), side, side];
    }
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.98, 0.98), this.tntMat.map((m) => m.clone()));
    const t = new PrimedTnt(fuse, mesh);
    t.position.set(x + 0.5, y, z + 0.5);
    t.velocity.set((Math.random() - 0.5) * 1.5, 3, (Math.random() - 0.5) * 1.5);
    mesh.position.set(t.position.x, t.position.y + 0.49, t.position.z);
    this.game.scene.add(mesh);
    this.tnts.push(t);
  }

  private update(dt: number): void {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      const k = f.t / 0.35;
      f.mesh.scale.setScalar(f.r * (0.4 + k * 1.1));
      (f.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.85 * (1 - k));
      f.light.intensity = Math.max(0, 6 * (1 - k));
      if (k >= 1) {
        this.game.scene.remove(f.mesh, f.light);
        (f.mesh.material as THREE.Material).dispose();
        f.light.dispose();
        this.flashes.splice(i, 1);
      }
    }
    for (let i = this.tnts.length - 1; i >= 0; i--) {
      const t = this.tnts[i];
      t.fuse -= dt;
      stepBody(this.game.world, t, dt);
      if (t.onGround) {
        t.velocity.x *= 0.8;
        t.velocity.z *= 0.8;
      }
      t.mesh.position.set(t.position.x, t.position.y + 0.49, t.position.z);
      const blink = Math.floor(t.fuse * 5) % 2 === 0;
      const s = 1 + (t.fuse < 0.6 ? (0.6 - t.fuse) * 0.3 : 0);
      t.mesh.scale.setScalar(s);
      for (const m of t.mesh.material as THREE.MeshBasicMaterial[]) m.color.setScalar(blink ? 2.2 : 1);
      if (t.fuse <= 0) {
        this.tnts.splice(i, 1);
        this.game.scene.remove(t.mesh);
        t.mesh.geometry.dispose();
        for (const m of t.mesh.material as THREE.Material[]) m.dispose();
        explode(this.game, t.position.x, t.position.y + 0.5, t.position.z, { radius: 4, power: 1.3, source: 'explosion' });
      }
    }
  }
}

const getExplosionFx = service((game) => new ExplosionFx(game));

/** Turns a TNT block position into a falling, blinking primed TNT that explodes after `fuse` s. */
export function primeTnt(game: Game, x: number, y: number, z: number, fuse = 3): void {
  if (game.world.getBlock(x, y, z) === BLOCK.tnt) game.world.setBlock(x, y, z, BLOCK.air, { source: 'explosion', drops: [] });
  if (bodyCollides(game.world, x + 0.5, y, z + 0.5, 0.9, 0.9)) y += 1;
  getExplosionFx(game).prime(x, y, z, fuse);
}

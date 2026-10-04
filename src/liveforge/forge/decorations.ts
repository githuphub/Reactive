/**
 * Placed decorations (decoration and block things, and any category the game does not know yet): the voxel model at
 * world scale (1 voxel = 1/16 block, so a 16-voxel model is one block), snapped to the grid on the targeted face.
 * While you hold one a ghost shows where it goes and R turns it 90°. Left-click breaks it and gives the item back.
 * `stats.light` > 0 adds a point light (it lights entity models; the terrain keeps its baked light). Saved in
 * `lf_decor`.
 */
import * as THREE from 'three';
import { Entity, type DamageSource } from '../../engine/entity';
import type { Game } from '../../game/game';
import { getParticles, giveItem } from '../../survival';
import { displayModel, glowColor, thingSpec, useOf, type LcThing } from './things';
import { expand, voxelBounds, voxelGeometry } from './voxel-model';

export const DECOR_TYPE = 'lf_decor';
const MAX_LIGHTS = 4;
let lights = 0;

const geoCache = new Map<string, THREE.BufferGeometry>();
function geometryFor(t: LcThing): THREE.BufferGeometry {
  const k = `${t.id}:${t.version}`;
  let g = geoCache.get(k);
  if (!g) {
    const model = displayModel(t);
    const b = voxelBounds(expand(model).voxels);
    g = voxelGeometry(model, { unit: 1 / 16, origin: [(b.min[0] + b.max[0]) / 2, b.min[1], (b.min[2] + b.max[2]) / 2] });
    geoCache.set(k, g);
  }
  return g;
}

/** True for things that are placed as decorations. */
export function isPlaceable(t: LcThing | undefined): t is LcThing {
  if (!t) return false;
  const u = useOf(t);
  return u === 'decoration' || u === 'block';
}

/** A placed decoration entity (static: no gravity, no AI). */
export class Decoration extends Entity {
  readonly type = DECOR_TYPE;
  readonly spec: LcThing;
  rot: number;
  private readonly mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  private light: THREE.PointLight | null = null;

  constructor(spec: LcThing, rot: number) {
    super();
    this.spec = spec;
    this.rot = rot & 3;
    this.yaw = this.rot * (Math.PI / 2);
    const geo = geometryFor(spec);
    const box = geo.boundingBox!;
    this.width = Math.max(0.3, Math.max(box.max.x - box.min.x, box.max.z - box.min.z));
    this.height = Math.max(0.2, box.max.y - box.min.y);
    this.maxHealth = this.health = 1;
    const group = new THREE.Group();
    const inner = new THREE.Mesh(geo, this.mat);
    inner.rotation.y = Math.PI;
    group.add(inner);
    const light = spec.thing.stats.light;
    if (light > 0 && lights < MAX_LIGHTS) {
      lights++;
      this.light = new THREE.PointLight(new THREE.Color(glowColor(spec)), 0.6 + light / 6, 2 + light * 0.8, 1.5);
      this.light.position.y = this.height * 0.7;
      group.add(this.light);
    }
    this.object3d = group;
    this.data.thing = spec.id;
  }

  update(): void {
    /* static */
  }

  hurt(_amount: number, source: DamageSource): boolean {
    if (this.removed || !source.player) return false;
    const g = this.game;
    getParticles(g).burst({ x: this.position.x, y: this.position.y + this.height / 2, z: this.position.z, count: 14, color: Object.values(this.spec.thing.model.palette).slice(0, 4), speed: 2, up: 1, size: 0.08, life: 0.5, spread: this.width / 2 });
    if (!g.inventory.infinite && g.player.mode !== 'creative') giveItem(g, this.spec.id, 1, { dropOverflow: true });
    else if (g.inventory.count(this.spec.id) === 0) giveItem(g, this.spec.id, 1);
    this.remove();
    g.save.markDirty('lf_decor');
    return true;
  }

  applyBrightness(b: number): void {
    const glow = this.spec.thing.stats.light > 0 ? 0.35 : 0;
    this.mat.color.setScalar(Math.min(1.2, b + glow));
  }

  onRemoved(): void {
    if (this.light) lights--;
    this.mat.dispose();
  }
}

interface SavedDecor {
  item: string;
  x: number;
  y: number;
  z: number;
  rot: number;
}

/** Placement (ghost + R), breaking and saving of decorations. */
export class Decorations {
  private rot = 0;
  private pending: SavedDecor[] = [];
  private readonly ghost: THREE.Mesh;
  private ghostKey = '';

  constructor(private readonly game: Game) {
    this.ghost = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.45, depthWrite: false }));
    this.ghost.visible = false;
    this.ghost.renderOrder = 20;
    game.scene.add(this.ghost);
    game.save.register('lf_decor', () => this.serialize(), (d: SavedDecor[]) => {
      this.pending = Array.isArray(d) ? d : [];
      if (game.ready) this.restore();
    });
    game.events.on('ready', () => this.restore());
    game.events.on('blockInteract', (e) => {
      const t = thingSpec(e.item?.item);
      if (!isPlaceable(t)) return;
      e.handled = true;
      const hit = game.interaction.target;
      if (!hit) return;
      const p = hit.place;
      if (t.thing.category === 'block' && this.blocksPlayer(p.x, p.y, p.z)) return;
      this.place(t, { x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, (this.rot + game.player.facing + 2) & 3);
      if (!game.inventory.infinite && game.player.mode !== 'creative') game.inventory.consumeSelected(1);
      game.interaction.onSwing?.();
    });
    game.addSystem({ name: 'forge-decor-ghost', update: () => this.updateGhost() });
  }

  /** Places a decoration entity at a feet position. */
  place(t: LcThing, pos: { x: number; y: number; z: number }, rot: number): Decoration {
    const d = new Decoration(t, rot);
    d.position.set(pos.x, pos.y, pos.z);
    this.game.entities.add(d);
    getParticles(this.game).burst({ x: pos.x, y: pos.y + 0.2, z: pos.z, count: 8, color: ['#ffffff', '#d8d8d8'], speed: 1, up: 0.6, size: 0.06, life: 0.4 });
    this.game.save.markDirty('lf_decor');
    return d;
  }

  /** Rebuilds placed decorations of a refined thing. */
  refresh(t: LcThing): void {
    for (const d of this.game.entities.ofType<Decoration>(DECOR_TYPE)) {
      if (d.spec.id !== t.id || d.removed) continue;
      this.place(t, d.position, d.rot);
      d.remove();
    }
    this.ghostKey = '';
  }

  private blocksPlayer(x: number, y: number, z: number): boolean {
    const p = this.game.player;
    const hw = p.width / 2;
    return p.position.x + hw > x && p.position.x - hw < x + 1 && p.position.z + hw > z && p.position.z - hw < z + 1 && p.position.y + p.height > y && p.position.y < y + 1;
  }

  private updateGhost(): void {
    const game = this.game;
    const t = thingSpec(game.inventory.selectedStack?.item);
    const hit = game.interaction.target;
    if (!isPlaceable(t) || !hit || game.ui.screens.isOpen || game.player.frozen) {
      this.ghost.visible = false;
      return;
    }
    if (game.input.wasPressed('KeyR')) {
      this.rot = (this.rot + 1) & 3;
      game.ui.toast(`↻ Turned ${this.rot * 90}°`, { seconds: 1 });
    }
    const key = `${t.id}:${t.version}`;
    if (key !== this.ghostKey) {
      this.ghostKey = key;
      this.ghost.geometry = geometryFor(t);
    }
    const p = hit.place;
    this.ghost.position.set(p.x + 0.5, p.y + 0.002, p.z + 0.5);
    this.ghost.rotation.y = ((this.rot + game.player.facing + 2) & 3) * (Math.PI / 2) + Math.PI;
    this.ghost.visible = true;
  }

  private serialize(): SavedDecor[] {
    const live = this.game.entities.ofType<Decoration>(DECOR_TYPE).filter((d) => !d.removed).map((d) => ({ item: d.spec.id, x: d.position.x, y: d.position.y, z: d.position.z, rot: d.rot }));
    return [...live, ...this.pending];
  }

  private restore(): void {
    const list = this.pending;
    this.pending = [];
    for (const s of list) {
      const t = thingSpec(s.item);
      if (t) this.place(t, s, s.rot);
    }
  }
}

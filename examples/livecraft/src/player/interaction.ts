/**
 * Targeting, breaking (hold LMB, crack stages, time from hardness × tool), placing (RMB with
 * per-block rules), entity attack/interact, door toggling and pick-block (MMB).
 */
import * as THREE from 'three';
import { BLOCK, BLOCK_FLAGS, F_REPLACEABLE, F_SOLID, blockById, type BlockDef } from '../engine/blocks';
import { breakTime, findItem, type ItemStack } from '../engine/items';
import { selectionBox, type Box } from '../engine/shapes';
import type { RaycastHit } from '../engine/world-store';
import type { Entity } from '../engine/entity';
import type { Game } from '../game/game';
import type { Input } from './input';

export const REACH = 5;
const REPEAT = 0.22;
const ATTACK_COOLDOWN = 0.35;

/** Wall facing (0 N, 1 E, 2 S, 3 W) of the block face that was clicked, for wall-mounted blocks. */
const FACE_TO_WALL = [3, 1, -1, -1, 0, 2];

export class Interaction {
  /** Current block target (null if none within reach). */
  target: RaycastHit | null = null;
  /** Entity under the crosshair (closer than any block). */
  targetEntity: Entity | null = null;
  /** 0..1 break progress of the targeted block. */
  progress = 0;
  /** Called when the arm swings (for held-item animation). */
  onSwing: (() => void) | null = null;
  private breakKey = '';
  private placeTimer = 0;
  private breakCooldown = 0;
  private attackTimer = 0;
  private readonly highlight: THREE.LineSegments;
  private readonly crack: THREE.Mesh;
  private readonly crackTextures: THREE.Texture[];

  constructor(private readonly game: Game) {
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.highlight = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.6, fog: false }));
    this.highlight.visible = false;
    this.highlight.renderOrder = 10;
    this.crackTextures = paintCracks();
    this.crack = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({
        map: this.crackTextures[0],
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        fog: false,
      }),
    );
    this.crack.visible = false;
    this.crack.renderOrder = 11;
    game.scene.add(this.highlight, this.crack);
  }

  update(dt: number, input: Input): void {
    const game = this.game;
    const player = game.player;
    this.placeTimer -= dt;
    this.breakCooldown -= dt;
    this.attackTimer -= dt;
    if (player.frozen || !input.locked) {
      this.clearBreak();
      this.highlight.visible = false;
      return;
    }

    // Targeting.
    const eye = player.eye(tmpEye);
    const dir = player.lookDir(tmpDir);
    this.target = game.world.raycast(eye, dir, REACH);
    const ent = game.entities.raycast(eye, dir, REACH);
    this.targetEntity = ent && (!this.target || ent.distance < this.target.distance) ? ent.entity : null;
    if (this.targetEntity) this.target = null;
    this.updateHighlight();

    // Scroll + number keys.
    if (input.wheel !== 0) game.inventory.select(game.inventory.selected + input.wheel);
    for (let i = 0; i < 9; i++) if (input.wasPressed(`Digit${i + 1}`)) game.inventory.select(i);

    // Attack / break.
    if (input.isButtonDown(0)) {
      if (this.targetEntity) {
        if (input.wasButtonPressed(0) || this.attackTimer <= 0) this.attack(this.targetEntity);
        this.clearBreak();
      } else if (this.target) this.mine(dt, input.wasButtonPressed(0));
      else this.clearBreak();
    } else this.clearBreak();

    // Use / place.
    if (input.isButtonDown(2) && (input.wasButtonPressed(2) || this.placeTimer <= 0)) {
      this.placeTimer = REPEAT;
      this.use(input);
    }

    // Pick block.
    if (input.wasButtonPressed(1) && this.target) this.pickBlock(this.target);
  }

  private updateHighlight(): void {
    const t = this.target;
    if (!t) {
      this.highlight.visible = false;
      return;
    }
    const box = selectionBox(t.id, t.meta) ?? ([0, 0, 0, 1, 1, 1] as Box);
    const e = 0.004;
    this.highlight.visible = true;
    this.highlight.position.set(t.x + (box[0] + box[3]) / 2, t.y + (box[1] + box[4]) / 2, t.z + (box[2] + box[5]) / 2);
    this.highlight.scale.set(box[3] - box[0] + e, box[4] - box[1] + e, box[5] - box[2] + e);
  }

  private attack(entity: Entity): void {
    const game = this.game;
    this.attackTimer = ATTACK_COOLDOWN;
    this.onSwing?.();
    const item = game.inventory.selectedStack;
    const ev = { entity, item, handled: false };
    game.events.emit('playerAttack', ev);
    if (ev.handled) return;
    const tool = item ? findItem(item.item)?.tool : null;
    if (entity.hurt(tool ? tool.damage : 1, { kind: 'melee', player: true, item })) game.inventory.damageSelected(tool?.kind === 'sword' ? 1 : 2);
  }

  private mine(dt: number, pressed: boolean): void {
    const game = this.game;
    const t = this.target!;
    const def = blockById(t.id);
    if (def.hardness < 0) {
      this.clearBreak();
      return;
    }
    if (game.player.mode === 'creative') {
      if (pressed || this.breakCooldown <= 0) {
        this.breakCooldown = 0.25;
        this.onSwing?.();
        game.breakBlock(t.x, t.y, t.z, { source: 'player', tool: null, drop: false });
      }
      return;
    }
    const key = `${t.x},${t.y},${t.z}`;
    if (key !== this.breakKey) {
      this.breakKey = key;
      this.progress = 0;
    }
    const tool = game.inventory.selectedStack;
    const time = breakTime(def, tool);
    this.progress = time <= 0 ? 1 : this.progress + dt / time;
    if (Math.floor(performance.now() / 250) !== Math.floor((performance.now() - dt * 1000) / 250)) this.onSwing?.();
    if (this.progress >= 1) {
      this.clearBreak();
      this.breakCooldown = 0.15;
      const res = game.breakBlock(t.x, t.y, t.z, { source: 'player', tool });
      if (res && findItem(tool?.item ?? '')?.tool) game.inventory.damageSelected(1);
      return;
    }
    const stage = Math.min(9, Math.floor(this.progress * 10));
    const box = selectionBox(t.id, t.meta) ?? ([0, 0, 0, 1, 1, 1] as Box);
    const e = 0.006;
    this.crack.visible = true;
    this.crack.position.set(t.x + (box[0] + box[3]) / 2, t.y + (box[1] + box[4]) / 2, t.z + (box[2] + box[5]) / 2);
    this.crack.scale.set(box[3] - box[0] + e, box[4] - box[1] + e, box[5] - box[2] + e);
    const mat = this.crack.material as THREE.MeshBasicMaterial;
    if (mat.map !== this.crackTextures[stage]) {
      mat.map = this.crackTextures[stage];
      mat.needsUpdate = true;
    }
  }

  private clearBreak(): void {
    this.breakKey = '';
    this.progress = 0;
    this.crack.visible = false;
  }

  private use(input: Input): void {
    const game = this.game;
    const inv = game.inventory;
    const stack = inv.selectedStack;
    const sneaking = game.player.sneaking;
    if (this.targetEntity) {
      const ev = { entity: this.targetEntity, item: stack, sneaking, handled: false };
      game.events.emit('entityInteract', ev);
      if (ev.handled) this.onSwing?.();
      return;
    }
    const t = this.target;
    if (!t) return;
    const def = blockById(t.id);
    // Interact with the block first (unless sneaking with an item).
    if (!sneaking || !stack) {
      const ev = { x: t.x, y: t.y, z: t.z, id: t.id, meta: t.meta, item: stack, sneaking, handled: false };
      game.events.emit('blockInteract', ev);
      if (ev.handled) {
        this.onSwing?.();
        return;
      }
      if (def.renderType === 'door') {
        game.toggleDoor(t.x, t.y, t.z);
        this.onSwing?.();
        return;
      }
    }
    if (!stack) return;
    const item = findItem(stack.item);
    if (!item) return;
    // Hoe tills grass/dirt.
    if (item.tool?.kind === 'hoe' && (t.id === BLOCK.grass || t.id === BLOCK.dirt) && t.face === 2 && game.world.getBlock(t.x, t.y + 1, t.z) === BLOCK.air) {
      game.world.setBlock(t.x, t.y, t.z, BLOCK.farmland, { source: 'player' });
      inv.damageSelected(1);
      this.onSwing?.();
      return;
    }
    if (item.block === null) return;
    if (this.place(t, item.block, stack)) {
      inv.consumeSelected(1);
      this.onSwing?.();
    }
    void input;
  }

  /** Places `blockId` against the hit face following the block's placement rules. */
  private place(t: RaycastHit, blockId: number, _stack: ItemStack): boolean {
    const game = this.game;
    const w = game.world;
    const def = blockById(blockId);
    const targetReplaceable = (BLOCK_FLAGS[t.id] & F_REPLACEABLE) !== 0 && t.id !== blockId;
    const p = targetReplaceable ? { x: t.x, y: t.y, z: t.z } : t.place;
    if (p.y < 0 || p.y >= 127) return false;
    const cur = w.getBlock(p.x, p.y, p.z);
    if (cur !== BLOCK.air && !(BLOCK_FLAGS[cur] & F_REPLACEABLE)) return false;
    const face = targetReplaceable ? 2 : t.face;
    const player = game.player;
    let meta = 0;
    const below = w.getBlock(p.x, p.y - 1, p.z);

    if (def.renderType === 'torch') {
      if (face === 2) {
        if (!(BLOCK_FLAGS[below] & F_SOLID)) return false;
        meta = 0;
      } else if (FACE_TO_WALL[face] >= 0) meta = FACE_TO_WALL[face] + 1;
      else return false;
    } else if (def.renderType === 'ladder') {
      if (FACE_TO_WALL[face] < 0) return false;
      meta = FACE_TO_WALL[face];
    } else if (def.renderType === 'door') {
      if (!(BLOCK_FLAGS[below] & F_SOLID)) return false;
      const up = w.getBlock(p.x, p.y + 1, p.z);
      if (up !== BLOCK.air && !(BLOCK_FLAGS[up] & F_REPLACEABLE)) return false;
      if (this.intersectsPlayer(p.x, p.y, p.z, 2)) return false;
      const facing = (player.facing + 2) & 3;
      w.setBlock(p.x, p.y, p.z, blockId, { meta: facing, source: 'player' });
      w.setBlock(p.x, p.y + 1, p.z, blockId, { meta: facing | 8, source: 'player' });
      return true;
    } else if (def.renderType === 'cross') {
      if (!canSupportPlant(def, below)) return false;
    } else if (def.orientable) {
      meta = (player.facing + 2) & 3;
    }
    if (def.solid && this.intersectsPlayer(p.x, p.y, p.z, 1)) return false;
    if (def.solid && game.entities.query({ x: p.x + 0.5, y: p.y, z: p.z + 0.5 }, 1.5, (e) => intersects(e, p.x, p.y, p.z)).length) return false;
    return w.setBlock(p.x, p.y, p.z, blockId, { meta, source: 'player' });
  }

  private intersectsPlayer(x: number, y: number, z: number, h: number): boolean {
    const p = this.game.player;
    const hw = p.width / 2;
    return p.position.x + hw > x && p.position.x - hw < x + 1 && p.position.z + hw > z && p.position.z - hw < z + 1 && p.position.y + p.height > y && p.position.y < y + h;
  }

  private pickBlock(t: RaycastHit): void {
    const inv = this.game.inventory;
    const name = blockById(t.id).name;
    const item = findItem(name);
    if (!item) return;
    for (let i = 0; i < 9; i++) {
      if (inv.get(i)?.item === name) {
        inv.select(i);
        return;
      }
    }
    if (this.game.player.mode === 'creative' || inv.infinite) inv.set(inv.selected, { item: name, count: item.maxStack });
  }
}

function intersects(e: Entity, x: number, y: number, z: number): boolean {
  const hw = e.width / 2;
  return e.position.x + hw > x && e.position.x - hw < x + 1 && e.position.z + hw > z && e.position.z - hw < z + 1 && e.position.y + e.height > y && e.position.y < y + 1;
}

function canSupportPlant(def: BlockDef, below: number): boolean {
  if (def.tags.includes('crop')) return below === BLOCK.farmland;
  if (def.name === 'dead_bush') return below === BLOCK.sand;
  return below === BLOCK.grass || below === BLOCK.dirt || below === BLOCK.snowy_grass || below === BLOCK.farmland;
}

const tmpEye = new THREE.Vector3();
const tmpDir = new THREE.Vector3();

/** 10 crack-stage overlay textures, painted procedurally. */
function paintCracks(): THREE.Texture[] {
  const out: THREE.Texture[] = [];
  let seed = 4242;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const lines: [number, number, number, number][] = [];
  for (let i = 0; i < 14; i++) {
    const x = 8 + (rnd() - 0.5) * 4, y = 8 + (rnd() - 0.5) * 4;
    const a = rnd() * Math.PI * 2;
    const len = 3 + rnd() * 6;
    lines.push([x, y, x + Math.cos(a) * len, y + Math.sin(a) * len]);
  }
  for (let stage = 0; stage < 10; stage++) {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    const n = Math.ceil(((stage + 1) / 10) * lines.length);
    for (let i = 0; i < n; i++) {
      const [x0, y0, x1, y1] = lines[i];
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * ((stage + 3) / 12));
      for (let s = 0; s <= steps; s++) {
        const t = s / Math.max(1, Math.hypot(x1 - x0, y1 - y0));
        ctx.fillRect(Math.floor(x0 + (x1 - x0) * t), Math.floor(y0 + (y1 - y0) * t), 1, 1);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    out.push(tex);
  }
  return out;
}

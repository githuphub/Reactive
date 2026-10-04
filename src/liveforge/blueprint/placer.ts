/**
 * Holding a blueprint: a ghost of the structure follows the aim (on the targeted block's top face, else ~6 blocks
 * ahead on the ground), its front towards the player, R turns it 90°. Right-click builds it block by block, bottom-up,
 * at 40–80 blocks/s with a sparkle per block. Always free, and the blueprint stays in the hotbar.
 *
 * Blocks are placed with source `blueprint` (player-made, but not one `block.placed` signal each): the first few
 * blocks are sent as `block.placed`, then one `item.used` sums the build up, with a Brain entry and a caption.
 */
import * as THREE from 'three';
import type { VoxelBlock } from '@liveforge/sdk';
import type { Game } from '../../game/game';
import { BLOCK, BLOCK_FLAGS, F_REPLACEABLE, F_SOLID, blockById, findBlock, type BlockDef } from '../../engine/blocks';
import { getParticles } from '../../survival';
import { blockColor } from '../../village/npc/effects';
import { PlanGhost } from '../ghost';
import { getHub } from '../hub';
import { FACTION, inVillage } from '../ids';
import type { LiveforgeService } from '../service';
import { anchorOffset, arrange, facingRotation, type Arranged } from './arrange';
import { BlueprintPreview } from './preview';
import { blueprintSpec, type LcBlueprint } from './registry';

const FACING: Record<string, number> = { north: 0, east: 1, south: 2, west: 3 };
const FDX = [0, 1, 0, -1], FDZ = [-1, 0, 1, 0];
const AIM = 12;
const SIGNALLED_BLOCKS = 3;

interface Job {
  bp: LcBlueprint;
  cells: VoxelBlock[];
  i: number;
  acc: number;
  bps: number;
  placed: number;
  ghost: PlanGhost;
  started: number;
  origin: { x: number; y: number; z: number };
  rotation: number;
}

export class BlueprintPlacer {
  private readonly preview: BlueprintPreview;
  private rot = 0;
  private arranged: { key: string; arr: Arranged } | null = null;
  private job: Job | null = null;
  private readonly box = { min: new THREE.Vector3(), max: new THREE.Vector3() };

  constructor(private readonly game: Game, private readonly lf: LiveforgeService) {
    this.preview = new BlueprintPreview(game.scene);
    // right-clicking a block with a blueprint builds; don't also open doors / chests
    game.events.on('blockInteract', (e) => {
      if (blueprintSpec(e.item?.item)) e.handled = true;
    });
    game.addSystem({ name: 'blueprint-placer', update: (dt) => this.update(dt) });
  }

  /** True while a blueprint is being built. */
  get building(): boolean {
    return this.job !== null;
  }

  private update(dt: number): void {
    const game = this.game;
    if (this.job) this.step(dt);
    const bp = blueprintSpec(game.inventory.selectedStack?.item);
    if (!bp || this.job || !game.ready || game.player.frozen || game.ui.screens.isOpen) {
      this.preview.hide();
      return;
    }
    const input = game.input;
    if (input.wasPressed('KeyR')) {
      this.rot = (this.rot + 1) & 3;
      game.ui.toast(`↻ Blueprint turned ${this.rot * 90}°`, { seconds: 1.2 });
    }
    const facing = game.player.facing;
    const arr = this.arrangement(bp, (facingRotation(facing) + this.rot) & 3);
    const offset = anchorOffset(this.anchor(), facing, arr.w, arr.d);
    const inside = this.playerInside(arr, offset);
    this.preview.show(arr, offset);
    this.preview.markPlayer(this.box, inside);
    if (input.wasButtonPressed(2) && !game.interaction.targetEntity) this.start(bp, arr, offset, inside);
  }

  /** Arranged blocks for a blueprint version and rotation (cached while they stay the same). */
  private arrangement(bp: LcBlueprint, k: number): Arranged {
    const key = `${bp.id}:${bp.version}:${k}`;
    if (this.arranged?.key !== key) this.arranged = { key, arr: arrange(bp.blocks, k) };
    return this.arranged.arr;
  }

  /** The layer the plan's floor goes on: the targeted block's top face, else the ground ~6 blocks ahead. */
  private anchor(): { x: number; y: number; z: number } {
    const p = this.game.player;
    const eye = p.eye(tmpEye);
    const dir = p.lookDir(tmpDir);
    const w = this.game.world;
    const hit = w.raycast(eye, dir, AIM);
    if (hit) {
      const plant = (BLOCK_FLAGS[hit.id] & F_REPLACEABLE) !== 0;
      return { x: hit.x, y: plant ? hit.y : hit.y + 1, z: hit.z };
    }
    const len = Math.hypot(dir.x, dir.z) || 1;
    const x = Math.floor(eye.x + (dir.x / len) * 6), z = Math.floor(eye.z + (dir.z / len) * 6);
    const top = w.topSolidY(x, z);
    return { x, y: top >= 0 ? top + 1 : Math.floor(p.position.y), z };
  }

  /** Updates the player box and tells whether the player stands inside the footprint (y range included). */
  private playerInside(arr: Arranged, o: { x: number; y: number; z: number }): boolean {
    const p = this.game.player;
    const hw = p.width / 2;
    this.box.min.set(p.position.x - hw, p.position.y, p.position.z - hw);
    this.box.max.set(p.position.x + hw, p.position.y + p.height, p.position.z + hw);
    const { min, max } = this.box;
    return max.x > o.x && min.x < o.x + arr.w && max.z > o.z && min.z < o.z + arr.d && max.y > o.y + arr.minY && min.y < o.y + arr.maxY + 1;
  }

  private start(bp: LcBlueprint, arr: Arranged, o: { x: number; y: number; z: number }, inside: boolean): void {
    const game = this.game;
    if (inside) {
      game.ui.toast('Step out of the ghost first: you are standing inside the footprint', { kind: 'warn', seconds: 3 });
      return;
    }
    const cells = arr.blocks.map((b) => ({ ...b, x: b.x + o.x, y: b.y + o.y, z: b.z + o.z }));
    const solid = cells.filter((b) => b.block !== 'air').length;
    if (!solid) return;
    this.preview.hide();
    this.job = {
      bp, cells, i: 0, acc: 0, placed: 0,
      bps: Math.max(40, Math.min(80, solid / 12)),
      ghost: new PlanGhost(game, cells),
      started: performance.now(),
      origin: o,
      rotation: this.rot * 90,
    };
    getHub().caption(`🏰 Building ${bp.name}: ${solid} blocks`, 4);
  }

  private step(dt: number): void {
    const job = this.job!;
    job.acc += dt * job.bps;
    while (job.acc >= 1 && job.i < job.cells.length) {
      const c = job.cells[job.i++];
      if (c.block === 'air') {
        this.clear(c);
        job.acc -= 0.25;
        continue;
      }
      job.acc -= 1;
      if (this.put(c)) {
        job.placed++;
        if (job.placed <= SIGNALLED_BLOCKS) {
          const site = this.game.villageSite;
          this.lf.signal('block.placed', { block: c.block, x: c.x, y: c.y, z: c.z, ...(inVillage(c.x, c.z, site) ? { village: FACTION } : {}) });
        }
      }
    }
    if (job.i >= job.cells.length) this.finish();
  }

  /** Clears a cell the plan wants empty (never doors, liquids or unbreakable blocks). */
  private clear(c: VoxelBlock): void {
    const w = this.game.world;
    const cur = w.getBlock(c.x, c.y, c.z);
    if (cur === BLOCK.air) return;
    const def = blockById(cur);
    if (def.hardness < 0 || def.liquid || def.renderType === 'door') return;
    w.setBlock(c.x, c.y, c.z, BLOCK.air, { source: 'blueprint' });
  }

  /** Places one plan block (both door halves, attached torches / ladders) with a sparkle. */
  private put(c: VoxelBlock): boolean {
    const w = this.game.world;
    const cur = w.getBlock(c.x, c.y, c.z);
    if (cur !== BLOCK.air && blockById(cur).hardness < 0) return false;
    const def = findBlock(c.block) ?? blockById(BLOCK.oak_planks);
    if (cur === def.id) return false;
    const meta = this.metaFor(def, c);
    let ok: boolean;
    if (def.renderType === 'door') {
      ok = w.setBlock(c.x, c.y, c.z, def.id, { meta: meta & 7, source: 'blueprint' });
      if (ok && (w.getBlock(c.x, c.y + 1, c.z) === BLOCK.air || w.isReplaceable(c.x, c.y + 1, c.z))) w.setBlock(c.x, c.y + 1, c.z, def.id, { meta: (meta & 7) | 8, source: 'blueprint' });
    } else ok = w.setBlock(c.x, c.y, c.z, def.id, { meta, source: 'blueprint' });
    if (ok) {
      const hex = `#${blockColor(def.id).toString(16).padStart(6, '0')}`;
      getParticles(this.game).burst({ x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5, count: 4, color: [hex, '#d8b8ff', '#ffffff'], speed: 1.5, up: 1.4, life: 0.55, size: 0.07, gravity: -0.5, spread: 0.45 });
    }
    return ok;
  }

  private metaFor(def: BlockDef, c: VoxelBlock): number {
    const w = this.game.world;
    const facing = c.facing ? FACING[c.facing] ?? null : null;
    const solid = (x: number, y: number, z: number) => (BLOCK_FLAGS[w.getBlock(x, y, z)] & F_SOLID) !== 0;
    if (def.renderType === 'torch') {
      if (solid(c.x, c.y - 1, c.z)) return 0;
      for (let f = 0; f < 4; f++) if (solid(c.x + FDX[f], c.y, c.z + FDZ[f])) return f + 1;
      return 0;
    }
    if (def.renderType === 'ladder') {
      if (facing !== null) return facing;
      for (let f = 0; f < 4; f++) if (solid(c.x + FDX[f], c.y, c.z + FDZ[f])) return f;
      return 0;
    }
    if (def.renderType === 'door' || def.orientable) {
      if (facing !== null) return facing;
      return (this.game.player.facing + 2) & 3;
    }
    return 0;
  }

  private finish(): void {
    const job = this.job!;
    this.job = null;
    job.ghost.dispose();
    const { bp, placed } = job;
    const ms = Math.round(performance.now() - job.started);
    this.lf.signal('item.used', { item: bp.id, target: `built ${bp.name} (${placed} blocks)` });
    const model = bp.source === 'ai' ? (this.lf.cassette === 'REPLAY' ? 'replay' : 'sonnet') : bp.source === 'cache' ? 'cache' : 'rules';
    this.lf.think({
      source: 'builder', actor: 'player', kind: 'decision', model, ms,
      text: `Player built ${bp.name}: ${placed} blocks`,
      data: { blueprint: bp.id, prompt: bp.prompt, origin: job.origin, rotation: job.rotation, materials: bp.materials },
    });
    getHub().caption(`🏰 Built ${bp.name}: ${placed} blocks`, 5);
    this.game.ui.toast(`Built ${bp.name} (${placed} blocks)`, { kind: 'good' });
  }
}

const tmpEye = new THREE.Vector3();
const tmpDir = new THREE.Vector3();

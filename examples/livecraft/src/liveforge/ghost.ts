/**
 * Plan preview: a translucent "ghost" of a voxel plan placed in the world while a villager builds it. Each ghost
 * cube disappears once the real block is there, so the video shows the structure filling in.
 */
import * as THREE from 'three';
import type { Game } from '../game/game';
import { BLOCK, findBlock } from '../engine/blocks';
import { blockColor } from '../village/npc/effects';

export interface GhostBlock {
  x: number;
  y: number;
  z: number;
  block: string;
}

export class PlanGhost {
  private readonly mesh: THREE.InstancedMesh;
  private readonly blocks: { x: number; y: number; z: number; id: number; shown: boolean }[] = [];
  private cursor = 0;
  private readonly system = { name: 'plan-ghost', update: () => this.update() };
  private pulse = 0;
  private disposed = false;

  /** `blocks` in world coordinates (air entries are skipped). */
  constructor(private readonly game: Game, blocks: GhostBlock[]) {
    const solid = blocks.filter((b) => b.block !== 'air').slice(0, 4000);
    const geo = new THREE.BoxGeometry(0.96, 0.96, 0.96);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, solid.length));
    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = false;
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    solid.forEach((b, i) => {
      const id = findBlock(b.block)?.id ?? BLOCK.oak_planks;
      this.blocks.push({ x: b.x, y: b.y, z: b.z, id, shown: true });
      m.makeTranslation(b.x + 0.5, b.y + 0.5, b.z + 0.5);
      this.mesh.setMatrixAt(i, m);
      c.setHex(blockColor(id));
      c.lerp(new THREE.Color(0x9fd8ff), 0.35);
      this.mesh.setColorAt(i, c);
    });
    this.mesh.count = solid.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    game.scene.add(this.mesh);
    game.addSystem(this.system);
  }

  /** Remaining ghost cubes. */
  get remaining(): number {
    return this.blocks.filter((b) => b.shown).length;
  }

  /** Removes the ghost. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.game.removeSystem(this.system);
    this.game.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }

  private update(): void {
    if (this.disposed || !this.blocks.length) return;
    this.pulse += 0.05;
    (this.mesh.material as THREE.MeshBasicMaterial).opacity = 0.22 + Math.sin(this.pulse) * 0.06;
    const world = this.game.world;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    let changed = false;
    // check a slice per frame (cheap even for big plans)
    for (let n = 0; n < 120; n++) {
      const i = this.cursor++ % this.blocks.length;
      const b = this.blocks[i];
      if (!b.shown) continue;
      if (world.getBlock(b.x, b.y, b.z) === b.id) {
        b.shown = false;
        this.mesh.setMatrixAt(i, zero);
        changed = true;
      }
    }
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

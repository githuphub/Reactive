/**
 * The held-blueprint preview: a translucent instanced cube per block (same look as the plan ghost in ghost.ts) that
 * follows the aim. Cubes that would overlap the player turn red, and the whole ghost reddens while the player stands
 * inside the footprint (building is refused there).
 */
import * as THREE from 'three';
import { BLOCK, findBlock } from '../../engine/blocks';
import { blockColor } from '../../village/npc/effects';
import type { Arranged } from './arrange';

const TINT = new THREE.Color(0x9fd8ff);
const RED = new THREE.Color(0xff3030);

export class BlueprintPreview {
  private mesh: THREE.InstancedMesh | null = null;
  private colors: THREE.Color[] = [];
  private cells = new Map<string, number>();
  private red: number[] = [];
  private shown: Arranged | null = null;
  private pulse = 0;

  constructor(private readonly scene: THREE.Scene) {}

  /** Shows `arr` with its local origin at `offset` (rebuilds the cubes only when the arrangement changes). */
  show(arr: Arranged, offset: { x: number; y: number; z: number }): void {
    if (arr !== this.shown) this.rebuild(arr);
    if (!this.mesh) return;
    this.mesh.visible = true;
    this.mesh.position.set(offset.x, offset.y, offset.z);
    this.pulse += 0.06;
    (this.mesh.material as THREE.MeshBasicMaterial).opacity = 0.26 + Math.sin(this.pulse) * 0.06;
  }

  hide(): void {
    if (this.mesh) this.mesh.visible = false;
  }

  /**
   * Reds the cubes inside the player's box (world AABB) and the whole ghost when `inside` (player in the footprint).
   */
  markPlayer(box: { min: THREE.Vector3; max: THREE.Vector3 }, inside: boolean): void {
    const mesh = this.mesh;
    if (!mesh) return;
    (mesh.material as THREE.MeshBasicMaterial).color.set(inside ? 0xff9090 : 0xffffff);
    const hit: number[] = [];
    const o = mesh.position;
    for (let x = Math.floor(box.min.x - o.x); x <= Math.floor(box.max.x - o.x - 1e-3); x++)
      for (let y = Math.floor(box.min.y - o.y); y <= Math.floor(box.max.y - o.y - 1e-3); y++)
        for (let z = Math.floor(box.min.z - o.z); z <= Math.floor(box.max.z - o.z - 1e-3); z++) {
          const i = this.cells.get(`${x},${y},${z}`);
          if (i !== undefined) hit.push(i);
        }
    if (!hit.length && !this.red.length) return;
    for (const i of this.red) mesh.setColorAt(i, this.colors[i]);
    for (const i of hit) mesh.setColorAt(i, RED);
    this.red = hit;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh = null;
    this.shown = null;
  }

  private rebuild(arr: Arranged): void {
    this.dispose();
    this.shown = arr;
    this.cells.clear();
    this.colors = [];
    this.red = [];
    const solid = arr.blocks.filter((b) => b.block !== 'air').slice(0, 4000);
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.96, 0.96, 0.96),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false }),
      Math.max(1, solid.length),
    );
    mesh.renderOrder = 5;
    mesh.frustumCulled = false;
    const m = new THREE.Matrix4();
    solid.forEach((b, i) => {
      const id = findBlock(b.block)?.id ?? BLOCK.oak_planks;
      m.makeTranslation(b.x + 0.5, b.y + 0.5, b.z + 0.5);
      mesh.setMatrixAt(i, m);
      const c = new THREE.Color(blockColor(id)).lerp(TINT, 0.35);
      this.colors.push(c);
      mesh.setColorAt(i, c);
      this.cells.set(`${b.x},${b.y},${b.z}`, i);
    });
    mesh.count = solid.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.mesh = mesh;
    this.scene.add(mesh);
  }
}

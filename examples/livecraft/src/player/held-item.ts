/**
 * First-person held item: a small textured cube (blocks) or flat sprite (items) in the lower
 * right of the view, with bob and swing animation. Rendered with the camera as parent.
 */
import * as THREE from 'three';
import { findItem } from '../engine/items';
import { blockById } from '../engine/blocks';
import type { TextureAtlas } from '../engine/atlas';
import { ATLAS_SIZE, SLOTS_PER_ROW, SLOT_PAD, SLOT_SIZE } from '../engine/constants';

/**
 * Extra held-model builders, tried in order before the default cube / sprite (V3 forge: extruded voxel items).
 * Return a fresh mesh (it is disposed when the held item changes) or null to fall through.
 */
export const heldMeshFactories: ((itemName: string) => THREE.Mesh | null)[] = [];

let heldVersion = 0;
/** Rebuilds the held model on the next frame (an item's look changed in place, e.g. an AI-refined forge item). */
export function refreshHeldItem(): void {
  heldVersion++;
}

export class HeldItem {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private current = '';
  private swing = 0;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly spriteMaterial: THREE.MeshBasicMaterial;
  private readonly spriteCache = new Map<string, THREE.Texture>();
  private readonly atlasTex: THREE.Texture;
  private atlasVersion = -1;
  private version = 0;

  constructor(private readonly atlas: TextureAtlas) {
    // The atlas is stored raw (no colour space) for the terrain shader; this clone is tagged sRGB
    // so three's built-in materials show the same colours.
    this.atlasTex = atlas.texture.clone();
    this.atlasTex.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshBasicMaterial({ map: this.atlasTex, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true });
    this.spriteMaterial = new THREE.MeshBasicMaterial({ alphaTest: 0.5, side: THREE.DoubleSide, transparent: false });
    this.group.position.set(0.42, -0.42, -0.7);
  }

  /** Starts a swing animation. */
  doSwing(): void {
    this.swing = 1;
  }

  update(dt: number, itemName: string | null, brightness: number, bob: number): void {
    const name = itemName ?? '';
    if (name !== this.current || this.version !== heldVersion) {
      this.version = heldVersion;
      this.rebuild(name);
    }
    this.swing = Math.max(0, this.swing - dt * 4.5);
    const s = Math.sin((1 - this.swing) * Math.PI) * (this.swing > 0 ? 1 : 0);
    this.group.position.set(0.42 - s * 0.12, -0.42 - s * 0.1 + bob, -0.7 - s * 0.1);
    this.group.rotation.set(-s * 0.9, 0, 0);
    if (this.mesh) (this.mesh.material as THREE.MeshBasicMaterial).color.setScalar(brightness);
  }

  private rebuild(name: string): void {
    this.current = name;
    if (this.atlasVersion !== this.atlas.version) {
      this.atlasVersion = this.atlas.version;
      this.atlasTex.needsUpdate = true;
    }
    if (this.mesh) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      if (this.mesh.material !== this.material) (this.mesh.material as THREE.Material).dispose();
      this.mesh = null;
    }
    if (!name) return;
    const item = findItem(name);
    if (!item) return;
    const custom = heldMeshFactories.reduce<THREE.Mesh | null>((m, f) => m ?? f(name), null);
    if (custom) {
      this.mesh = custom;
    } else if (item.icon === null && item.block !== null) {
      const def = blockById(item.block);
      const geo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      const colors = new Float32Array(uv.count * 3);
      const shades = [0.8, 0.8, 1, 0.6, 0.9, 0.9];
      // BoxGeometry face order matches mesh order: +X, -X, +Y, -Y, +Z, -Z.
      for (let f = 0; f < 6; f++) {
        const slot = this.atlas.slot(def.faces[f === 4 ? 5 : f]);
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
      this.mesh = new THREE.Mesh(geo, this.material);
      this.mesh.rotation.set(0.1, Math.PI / 4 + 0.3, 0);
    } else {
      const key = item.icon ?? name;
      let tex = this.spriteCache.get(key);
      if (!tex) {
        tex = new THREE.CanvasTexture(this.atlas.tileCanvas(key));
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        this.spriteCache.set(key, tex);
      }
      const mat = this.spriteMaterial.clone();
      mat.map = tex;
      this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.55), mat);
      this.mesh.rotation.set(0, -0.5, 0.15);
      this.mesh.position.set(0.02, 0.08, 0);
    }
    this.mesh.renderOrder = 100;
    const m = this.mesh.material as THREE.Material;
    m.depthTest = false;
    this.group.add(this.mesh);
  }
}

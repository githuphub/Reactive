// Dispose helpers.
import * as THREE from "three";

/**
 * Detaches `root` and frees every geometry, material (and its textures) and InstancedMesh buffer under it.
 * Only use it on objects you built (blueprints, VFX); shared assets would be freed too.
 */
export function disposeObject(root: THREE.Object3D): void {
  root.removeFromParent();
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  root.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose();
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (g && g.isBufferGeometry) geos.add(g);
    const mat = (o as THREE.Mesh).material;
    if (mat) for (const x of Array.isArray(mat) ? mat : [mat]) mats.add(x);
  });
  for (const g of geos) g.dispose();
  for (const m of mats) {
    for (const v of Object.values(m)) if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose();
    if ((m as THREE.ShaderMaterial).uniforms) {
      for (const u of Object.values((m as THREE.ShaderMaterial).uniforms)) if (u.value && (u.value as THREE.Texture).isTexture) (u.value as THREE.Texture).dispose();
    }
    m.dispose();
  }
}

/** Calls Object3D.prototype.dispose (fires the "dispose" event) on three versions that have it. */
export function superDispose(o: THREE.Object3D): void {
  (THREE.Object3D.prototype as { dispose?: (this: THREE.Object3D) => void }).dispose?.call(o);
}

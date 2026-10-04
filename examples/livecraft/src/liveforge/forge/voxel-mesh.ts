/**
 * Extrudes a 16×16 icon into a voxel mesh (one cube per opaque pixel, hidden faces culled), with vertex colours.
 * Used as the held model of forged items.
 */
import * as THREE from 'three';
import type { Pixels } from './pixel';

const S = 16;

/** Builds the extruded geometry, centred, `size` units wide, one pixel deep. */
export function extrudeIcon(px: Pixels, size = 0.55): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const u = size / S;
  const d = u * 1.2;
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < S && y < S && px[(y * S + x) * 4 + 3] > 127;
  const quad = (a: number[], b: number[], c: number[], e: number[], r: number, g: number, bl: number) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...e);
    for (let i = 0; i < 6; i++) col.push(r, g, bl);
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (!solid(x, y)) continue;
    const i = (y * S + x) * 4;
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const x0 = (x - S / 2) * u, x1 = x0 + u;
    const y1 = (S / 2 - y) * u, y0 = y1 - u;
    const zf = d / 2, zb = -d / 2;
    quad([x0, y0, zf], [x1, y0, zf], [x1, y1, zf], [x0, y1, zf], r, g, b);
    quad([x1, y0, zb], [x0, y0, zb], [x0, y1, zb], [x1, y1, zb], r * 0.8, g * 0.8, b * 0.8);
    if (!solid(x, y - 1)) quad([x0, y1, zf], [x1, y1, zf], [x1, y1, zb], [x0, y1, zb], r * 1.1, g * 1.1, b * 1.1);
    if (!solid(x, y + 1)) quad([x0, y0, zb], [x1, y0, zb], [x1, y0, zf], [x0, y0, zf], r * 0.6, g * 0.6, b * 0.6);
    if (!solid(x - 1, y)) quad([x0, y0, zb], [x0, y0, zf], [x0, y1, zf], [x0, y1, zb], r * 0.7, g * 0.7, b * 0.7);
    if (!solid(x + 1, y)) quad([x1, y0, zf], [x1, y0, zb], [x1, y1, zb], [x1, y1, zf], r * 0.75, g * 0.75, b * 0.75);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col.map((v) => Math.pow(Math.min(1, v), 2.2)), 3));
  geo.computeBoundingSphere();
  return geo;
}

/** A held-item mesh for the first-person view (same placement as V0's flat sprites). */
export function heldVoxelMesh(px: Pixels): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(extrudeIcon(px, 0.55), mat);
  mesh.rotation.set(0, -0.5, 0.15);
  mesh.position.set(0.02, 0.08, 0);
  return mesh;
}

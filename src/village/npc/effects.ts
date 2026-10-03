/**
 * Small visual effects for villagers: block-coloured particle bursts when they place or break
 * blocks, and a per-block average colour helper (for carried blocks and particles).
 */
import * as THREE from 'three';
import { blockById } from '../../engine/blocks';
import { paintTexture } from '../../engine/textures';

const colorCache = new Map<number, number>();

/** Average colour of a block's top/side texture as 0xRRGGBB (cached). */
export function blockColor(id: number): number {
  let c = colorCache.get(id);
  if (c !== undefined) return c;
  const def = blockById(id);
  const t = paintTexture(def.faces[0]);
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < t.data.length; i += 4) {
    if (t.data[i + 3] < 40) continue;
    r += t.data[i];
    g += t.data[i + 1];
    b += t.data[i + 2];
    n++;
  }
  c = n ? ((Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n)) : 0x888888;
  colorCache.set(id, c);
  return c;
}

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; max: number;
  size: number;
}

const MAX = 256;

/** Instanced cube particles with gravity. Add `group` to the scene and call `update(dt)` each frame. */
export class Particles {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.InstancedMesh;
  private readonly items: Particle[] = [];
  private readonly colors: THREE.Color[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();

  constructor() {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.mesh);
  }

  /** A burst of `n` particles of a colour around a block centre. */
  burst(x: number, y: number, z: number, color: number, n = 10, speed = 2.5): void {
    for (let i = 0; i < n; i++) {
      if (this.items.length >= MAX) this.items.shift(), this.colors.shift();
      const life = 0.5 + Math.random() * 0.5;
      this.items.push({
        x: x + (Math.random() - 0.5) * 0.8,
        y: y + (Math.random() - 0.5) * 0.8,
        z: z + (Math.random() - 0.5) * 0.8,
        vx: (Math.random() - 0.5) * speed,
        vy: Math.random() * speed,
        vz: (Math.random() - 0.5) * speed,
        life,
        max: life,
        size: 0.08 + Math.random() * 0.08,
      });
      const c = new THREE.Color(color);
      c.multiplyScalar(0.8 + Math.random() * 0.4);
      this.colors.push(c);
    }
  }

  update(dt: number): void {
    let w = 0;
    for (let i = 0; i < this.items.length; i++) {
      const p = this.items[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy -= 12 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      this.items[w] = p;
      this.colors[w] = this.colors[i];
      w++;
    }
    this.items.length = w;
    this.colors.length = w;
    for (let i = 0; i < w; i++) {
      const p = this.items[i];
      const k = p.size * Math.min(1, p.life / p.max + 0.3);
      this.m.compose(this.p.set(p.x, p.y, p.z), this.q, this.s.set(k, k, k));
      this.mesh.setMatrixAt(i, this.m);
      this.mesh.setColorAt(i, this.colors[i]);
    }
    this.mesh.count = w;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

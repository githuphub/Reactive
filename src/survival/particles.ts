/**
 * Tiny cube particles (poofs, crits, explosion debris, flames, eating crumbs) drawn with one
 * InstancedMesh. Cheap enough for hundreds of particles at once.
 *
 * ```ts
 * getParticles(game).burst({ x, y, z, count: 12, color: '#ffffff', speed: 2 });
 * ```
 */
import * as THREE from 'three';
import type { Game } from '../game/game';
import { service } from './service';

const MAX = 1200;

export interface BurstOptions {
  x: number;
  y: number;
  z: number;
  count?: number;
  /** CSS colour, or a list to pick from. */
  color?: string | string[];
  /** Initial speed in blocks/s (random direction). Default 2. */
  speed?: number;
  /** Extra upward velocity. Default 1. */
  up?: number;
  /** Seconds. Default 0.6 (randomised ±40%). */
  life?: number;
  /** Cube size in blocks. Default 0.08. */
  size?: number;
  /** Gravity in blocks/s². Default 9. Negative floats up (smoke, flames). */
  gravity?: number;
  /** Random start offset radius. Default 0.2. */
  spread?: number;
}

export class Particles {
  private readonly mesh: THREE.InstancedMesh;
  private readonly pos = new Float32Array(MAX * 3);
  private readonly vel = new Float32Array(MAX * 3);
  private readonly life = new Float32Array(MAX);
  private readonly maxLife = new Float32Array(MAX);
  private readonly size = new Float32Array(MAX);
  private readonly grav = new Float32Array(MAX);
  private count = 0;
  private readonly m = new THREE.Matrix4();
  private readonly c = new THREE.Color();

  constructor(private readonly game: Game) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'particles';
    game.scene.add(this.mesh);
    game.addSystem({ name: 'particles', update: (dt) => this.update(dt) });
  }

  /** Emits a burst of particles. */
  burst(o: BurstOptions): void {
    const n = o.count ?? 8;
    const colors = Array.isArray(o.color) ? o.color : [o.color ?? '#ffffff'];
    const speed = o.speed ?? 2;
    const spread = o.spread ?? 0.2;
    for (let k = 0; k < n; k++) {
      if (this.count >= MAX) this.kill(0);
      const i = this.count++;
      const a = Math.random() * Math.PI * 2;
      const u = Math.random() * 2 - 1;
      const s = Math.sqrt(1 - u * u);
      const sp = speed * (0.4 + Math.random() * 0.6);
      this.pos[i * 3] = o.x + (Math.random() - 0.5) * 2 * spread;
      this.pos[i * 3 + 1] = o.y + (Math.random() - 0.5) * 2 * spread;
      this.pos[i * 3 + 2] = o.z + (Math.random() - 0.5) * 2 * spread;
      this.vel[i * 3] = Math.cos(a) * s * sp;
      this.vel[i * 3 + 1] = u * sp + (o.up ?? 1);
      this.vel[i * 3 + 2] = Math.sin(a) * s * sp;
      const l = (o.life ?? 0.6) * (0.6 + Math.random() * 0.8);
      this.life[i] = l;
      this.maxLife[i] = l;
      this.size[i] = (o.size ?? 0.08) * (0.7 + Math.random() * 0.6);
      this.grav[i] = o.gravity ?? 9;
      this.c.set(colors[Math.floor(Math.random() * colors.length)]);
      this.mesh.setColorAt(i, this.c);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i !== last) {
      for (let a = 0; a < 3; a++) {
        this.pos[i * 3 + a] = this.pos[last * 3 + a];
        this.vel[i * 3 + a] = this.vel[last * 3 + a];
      }
      this.life[i] = this.life[last];
      this.maxLife[i] = this.maxLife[last];
      this.size[i] = this.size[last];
      this.grav[i] = this.grav[last];
      this.mesh.getColorAt(last, this.c);
      this.mesh.setColorAt(i, this.c);
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  private update(dt: number): void {
    const world = this.game.world;
    for (let i = this.count - 1; i >= 0; i--) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.kill(i);
        continue;
      }
      this.vel[i * 3 + 1] -= this.grav[i] * dt;
      const drag = Math.pow(0.4, dt);
      this.vel[i * 3] *= drag;
      this.vel[i * 3 + 2] *= drag;
      const nx = this.pos[i * 3] + this.vel[i * 3] * dt;
      const ny = this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt;
      const nz = this.pos[i * 3 + 2] + this.vel[i * 3 + 2] * dt;
      if (world.isSolid(Math.floor(nx), Math.floor(ny), Math.floor(nz))) {
        this.vel[i * 3] *= 0.3;
        this.vel[i * 3 + 1] = 0;
        this.vel[i * 3 + 2] *= 0.3;
      } else {
        this.pos[i * 3] = nx;
        this.pos[i * 3 + 1] = ny;
        this.pos[i * 3 + 2] = nz;
      }
    }
    for (let i = 0; i < this.count; i++) {
      const s = this.size[i] * Math.min(1, (this.life[i] / this.maxLife[i]) * 2.5);
      this.m.makeScale(s, s, s);
      this.m.setPosition(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** The game's particle system (created on first use). */
export const getParticles = service((game) => new Particles(game));

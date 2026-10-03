/**
 * Path debug view (F7): draws every mob's remaining path as a line with node markers, coloured
 * by tactic. Handy for showing the pathfinding in a demo.
 */
import * as THREE from 'three';
import type { Game } from '../game/game';
import { Mob } from './mob';

const TACTIC_COLORS: Record<string, number> = {
  climb_pillar: 0xff7ae6,
  tunnel: 0xffb829,
  keep_distance: 0x6ad1ff,
  rush: 0xff4a4a,
  flank: 0x9b7aff,
  rooftops: 0x7fd36b,
};

export class PathDebug {
  enabled = false;
  private readonly lines: THREE.LineSegments;
  private timer = 0;

  constructor(private readonly game: Game) {
    const geo = new THREE.BufferGeometry();
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.9 }));
    this.lines.renderOrder = 50;
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    game.scene.add(this.lines);
    game.addSystem({ name: 'path-debug', update: (dt) => this.update(dt) });
  }

  toggle(): void {
    this.enabled = !this.enabled;
    this.lines.visible = this.enabled;
    this.game.ui.toast(`Path debug ${this.enabled ? 'on' : 'off'}`);
  }

  private update(dt: number): void {
    if (!this.enabled) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.15;
    const pos: number[] = [];
    const col: number[] = [];
    const c = new THREE.Color();
    for (const e of this.game.entities.all()) {
      if (!(e instanceof Mob)) continue;
      const nodes = e.brain.remaining;
      if (!nodes.length) continue;
      c.setHex(e.tactic ? TACTIC_COLORS[e.tactic] ?? 0xffffff : e.category === 'animal' ? 0xa0ffa0 : 0xffffff);
      let px = e.position.x, py = e.position.y + 0.1, pz = e.position.z;
      for (const n of nodes) {
        const nx = n.x + 0.5, ny = n.y + 0.1, nz = n.z + 0.5;
        pos.push(px, py, pz, nx, ny, nz);
        col.push(c.r, c.g, c.b, c.r, c.g, c.b);
        // Small cross per node (orange for dig nodes).
        const k = n.dig?.length ? new THREE.Color(0xff8a1e) : c;
        pos.push(nx - 0.15, ny, nz, nx + 0.15, ny, nz, nx, ny, nz - 0.15, nx, ny, nz + 0.15);
        for (let i = 0; i < 4; i++) col.push(k.r, k.g, k.b);
        px = nx;
        py = ny;
        pz = nz;
      }
    }
    const geo = this.lines.geometry;
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeBoundingSphere();
  }
}

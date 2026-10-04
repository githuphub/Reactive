/**
 * Play-style detectors (for V3 → Reactive signals `build.pillared`, `combat.hid`):
 * - `pillared {height}`: the player stands on a 1×1 column they built themselves, ≥ 4 high.
 * - `hid {depth}`: the player is enclosed underground at night.
 */
import { BLOCK_FLAGS, F_SOLID } from '../engine/blocks';
import type { Game } from '../game/game';

const MAX_TRACKED = 20000;
const HID_COOLDOWN = 60;

export class PlayStyleDetectors {
  private readonly placed = new Set<string>();
  private timer = 0;
  private pillarKey = '';
  private pillarHeight = 0;
  private hiding = false;
  private lastHid = -Infinity;
  private time = 0;

  constructor(private readonly game: Game) {
    game.events.on('blockPlaced', (e) => {
      if (e.source !== 'player') return;
      if (this.placed.size > MAX_TRACKED) this.placed.clear();
      this.placed.add(`${e.x},${e.y},${e.z}`);
    });
    game.events.on('blockBroken', (e) => this.placed.delete(`${e.x},${e.y},${e.z}`));
    game.addSystem({ name: 'play-style', update: (dt) => this.update(dt) });
  }

  /** True if the player placed the block at this position (since load). */
  placedByPlayer(x: number, y: number, z: number): boolean {
    return this.placed.has(`${x},${y},${z}`);
  }

  private update(dt: number): void {
    this.time += dt;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.5;
    const p = this.game.player;
    if (p.frozen) return;
    this.checkPillar();
    this.checkHid();
  }

  private isolated(x: number, y: number, z: number): boolean {
    const w = this.game.world;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (BLOCK_FLAGS[w.getBlock(x + dx, y, z + dz)] & F_SOLID) return false;
    return true;
  }

  private checkPillar(): void {
    const p = this.game.player;
    if (!p.onGround) return;
    const bx = Math.floor(p.position.x), by = Math.floor(p.position.y - 0.05), bz = Math.floor(p.position.z);
    // `by` is the block under the feet; count player-placed, free-standing blocks downwards.
    let h = 0;
    for (let y = by; y > 0 && h < 64; y--) {
      if (!this.placed.has(`${bx},${y},${bz}`) || !this.isolated(bx, y, bz)) break;
      h++;
    }
    const key = `${bx},${bz}`;
    if (h >= 4) {
      if (key !== this.pillarKey || h > this.pillarHeight) {
        this.pillarKey = key;
        this.pillarHeight = h;
        this.game.events.emit('pillared', { height: h, x: bx, y: Math.floor(p.position.y), z: bz });
      }
    } else if (key !== this.pillarKey) {
      this.pillarKey = '';
      this.pillarHeight = 0;
    }
  }

  private checkHid(): void {
    const g = this.game;
    const p = g.player;
    const night = g.time.phase === 'night' || g.time.phase === 'dusk';
    const x = Math.floor(p.position.x), z = Math.floor(p.position.z);
    const feet = Math.floor(p.position.y + 0.1), head = feet + 1;
    const w = g.world;
    let enclosed = night && w.getSkyLight(x, head, z) <= 1;
    let depth = 0;
    if (enclosed) {
      depth = Math.max(0, w.heightAt(x, z) - head);
      if (depth < 2) enclosed = false;
    }
    if (enclosed) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        let wall = false;
        for (let d = 1; d <= 4 && !wall; d++) {
          if (BLOCK_FLAGS[w.getBlock(x + dx * d, feet, z + dz * d)] & F_SOLID || BLOCK_FLAGS[w.getBlock(x + dx * d, head, z + dz * d)] & F_SOLID) wall = true;
        }
        if (!wall) {
          enclosed = false;
          break;
        }
      }
    }
    if (enclosed && !this.hiding && this.time - this.lastHid > HID_COOLDOWN) {
      this.lastHid = this.time;
      g.events.emit('hid', { depth, x, y: feet, z });
    }
    this.hiding = enclosed;
  }
}

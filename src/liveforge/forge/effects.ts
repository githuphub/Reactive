/**
 * Forged item effects (the manifest's effect enum):
 * - chain_lightning: mining a block also breaks up to 6 connected blocks of the same type, with a lightning arc;
 * - vein_mine: mining breaks up to 12 connected blocks of the same type;
 * - fire_trail: while held, your steps leave flames that set nearby hostiles alight;
 * - knockback_burst: a melee hit blasts every hostile within 4 blocks away;
 * - heal_aura: while held, you slowly heal;
 * - frost_slow: a hit slows the target for 4 s;
 * - explode_on_hit: a melee hit sets off a small blast (no block damage) that hurts and throws nearby hostiles.
 * Passive effects of things (speed, jump, glow, night vision) are in buffs.ts.
 */
import * as THREE from 'three';
import type { Game } from '../../game/game';
import { BLOCK } from '../../engine/blocks';
import type { Entity } from '../../engine/entity';
import type { Mob } from '../../mobs';
import { getHealth, getParticles } from '../../survival';
import { forgedSpec } from './registry';
import { thingEffect } from './things';

/** Effect + colour of a held forged item (forge.item items or forge.thing things). */
function fxOf(item: string | null | undefined): { effect: string; color: string; main: string } | null {
  const spec = forgedSpec(item);
  if (spec?.effect) return { effect: spec.effect, color: spec.palette[3], main: spec.palette[0] };
  const t = thingEffect(item);
  return t ? { effect: t.effect, color: t.color, main: t.color } : null;
}

const NEIGH = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

const isHostile = (e: Entity) => (e as Partial<Mob>).category === 'hostile';

export function wireEffects(game: Game): void {
  let chaining = false;

  game.events.on('blockBroken', (e) => {
    if (chaining || e.source !== 'player' || !e.tool) return;
    const spec = fxOf(e.tool.item);
    if (!spec || (spec.effect !== 'chain_lightning' && spec.effect !== 'vein_mine')) return;
    const max = spec.effect === 'chain_lightning' ? 6 : 12;
    const targets = connected(game, e.x, e.y, e.z, e.id, max);
    if (!targets.length) return;
    const lightning = spec.effect === 'chain_lightning';
    let prev = { x: e.x + 0.5, y: e.y + 0.5, z: e.z + 0.5 };
    targets.forEach((t, i) => {
      const from = prev;
      const to = { x: t.x + 0.5, y: t.y + 0.5, z: t.z + 0.5 };
      prev = to;
      setTimeout(() => {
        if (game.world.getBlock(t.x, t.y, t.z) !== e.id) return;
        if (lightning) arc(game, from, to, spec.color);
        chaining = true;
        try {
          game.breakBlock(t.x, t.y, t.z, { source: 'player', tool: e.tool });
        } finally {
          chaining = false;
        }
        getParticles(game).burst({ x: to.x, y: to.y, z: to.z, count: lightning ? 10 : 6, color: lightning ? [spec.color, '#ffffff'] : [spec.main], speed: 3, up: 1.5 });
      }, 70 * (i + 1));
    });
  });

  game.events.on('playerAttack', (e) => {
    const spec = fxOf(e.item?.item);
    if (!spec) return;
    const p = game.player.position;
    if (spec.effect === 'knockback_burst') {
      for (const m of game.entities.query(p, 4, isHostile)) {
        const dx = m.position.x - p.x, dz = m.position.z - p.z;
        const d = Math.hypot(dx, dz) || 1;
        m.velocity.x += (dx / d) * 12;
        m.velocity.z += (dz / d) * 12;
        m.velocity.y += 6;
        m.hurt(2, { kind: 'magic', player: true, item: e.item });
      }
      for (let a = 0; a < 16; a++) getParticles(game).burst({ x: p.x + Math.cos(a) * 1.5, y: p.y + 0.6, z: p.z + Math.sin(a) * 1.5, count: 3, color: spec.color, speed: 4, up: 0.5 });
    }
    if (spec.effect === 'frost_slow' && isHostile(e.entity)) {
      const m = e.entity as Mob;
      m.speedMul = 0.4;
      getParticles(game).burst({ x: m.position.x, y: m.position.y + 1, z: m.position.z, count: 14, color: ['#bfe8ff', '#ffffff'], speed: 1.5 });
      setTimeout(() => (m.speedMul = 1), 4000);
    }
    if (spec.effect === 'fire_trail' && isHostile(e.entity)) (e.entity as Mob).burning = Math.max((e.entity as Mob).burning, 4);
    if (spec.effect === 'explode_on_hit') blast(game, e.entity.position.x, e.entity.position.y + 0.5, e.entity.position.z, spec.color, e.item);
  });

  let acc = 0;
  let healAcc = 0;
  const last = new THREE.Vector3();
  game.addSystem({
    name: 'forge-effects',
    update: (dt) => {
      const spec = fxOf(game.inventory.selectedStack?.item);
      if (!spec) return;
      const p = game.player.position;
      if (spec.effect === 'fire_trail') {
        acc += dt;
        if (acc > 0.15 && last.distanceTo(p) > 0.4) {
          acc = 0;
          last.copy(p);
          getParticles(game).burst({ x: p.x, y: p.y + 0.1, z: p.z, count: 5, color: ['#ff9a2a', '#ffd04a', '#ff5a1a'], speed: 0.8, up: 1.6, life: 0.8 });
          for (const m of game.entities.query(p, 2.5, isHostile)) (m as Mob).burning = Math.max((m as Mob).burning, 3);
        }
      }
      if (spec.effect === 'heal_aura') {
        healAcc += dt;
        if (healAcc > 2) {
          healAcc = 0;
          getHealth(game).heal(1);
          getParticles(game).burst({ x: p.x, y: p.y + 1, z: p.z, count: 6, color: ['#7dff8a', '#c8ffd0'], speed: 0.6, up: 1.2 });
        }
      }
    },
  });
}

/** A small blast without block damage: hurts and throws hostiles within 3 blocks. */
export function blast(game: Game, x: number, y: number, z: number, color: string, item?: unknown): void {
  const parts = getParticles(game);
  parts.burst({ x, y, z, count: 26, color: ['#fff2a8', '#ff9a2a', color, '#5a5a5a'], speed: 6, up: 1.5, size: 0.14, life: 0.6, spread: 0.4 });
  parts.burst({ x, y, z, count: 12, color: ['#8a8a8a', '#5a5a5a'], speed: 2, up: 1.5, gravity: -1, size: 0.3, life: 1.1, spread: 0.6 });
  for (const m of game.entities.query({ x, y, z }, 3, isHostile)) {
    const dx = m.position.x - x, dz = m.position.z - z;
    const d = Math.hypot(dx, dz) || 1;
    m.hurt(4, { kind: 'explosion', player: true, item: (item ?? null) as never });
    m.velocity.x += (dx / d) * 10;
    m.velocity.z += (dz / d) * 10;
    m.velocity.y += 6;
  }
}

/** Connected blocks of the same id (BFS), excluding the start. */
function connected(game: Game, x: number, y: number, z: number, id: number, max: number): { x: number; y: number; z: number }[] {
  if (id === BLOCK.air || id === BLOCK.bedrock) return [];
  const seen = new Set<string>([`${x},${y},${z}`]);
  const out: { x: number; y: number; z: number }[] = [];
  const q = [{ x, y, z }];
  while (q.length && out.length < max) {
    const c = q.shift()!;
    for (const [dx, dy, dz] of NEIGH) {
      const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
      const k = `${n.x},${n.y},${n.z}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (game.world.getBlock(n.x, n.y, n.z) !== id) continue;
      out.push(n);
      q.push(n);
      if (out.length >= max) break;
    }
  }
  return out;
}

/** A jagged lightning arc between two points, fading over 0.35 s. */
function arc(game: Game, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, color: string): void {
  const pts: THREE.Vector3[] = [];
  const n = 7;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const j = i === 0 || i === n ? 0 : 0.22;
    pts.push(new THREE.Vector3(a.x + (b.x - a.x) * t + (Math.random() - 0.5) * j, a.y + (b.y - a.y) * t + (Math.random() - 0.5) * j + Math.sin(t * Math.PI) * 0.35, a.z + (b.z - a.z) * t + (Math.random() - 0.5) * j));
  }
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.4), transparent: true, opacity: 1, depthTest: false });
  const line = new THREE.Line(geo, mat);
  line.renderOrder = 50;
  game.scene.add(line);
  const t0 = performance.now();
  const tick = () => {
    const k = 1 - (performance.now() - t0) / 350;
    if (k <= 0) {
      game.scene.remove(line);
      geo.dispose();
      mat.dispose();
      return;
    }
    mat.opacity = k;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

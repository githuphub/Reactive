/**
 * Raid tactics as behaviour modifiers. A mob with `mob.tactic = 'flank'` asks its tactic for a
 * different approach goal, path options, speed and extra per-frame actions (digging, building up).
 *
 * V3 picks tactics from Liveforge raid plans; new ones can be added with {@link registerTactic}.
 */
import * as THREE from 'three';
import { BLOCK, BLOCK_FLAGS, F_SOLID } from '../engine/blocks';
import type { StepInput } from '../engine/physics';
import type { Game } from '../game/game';
import type { PathOptions } from './pathfind';
import type { Mob } from './mob';

export interface TacticContext {
  mob: Mob;
  game: Game;
  /** Target feet position. */
  target: THREE.Vector3;
  /** Horizontal distance to the target. */
  distance: number;
  dt: number;
}

export interface TacticBehavior {
  /** Path options merged into the mob's own while the tactic is active. */
  path?: PathOptions;
  /** Chase speed multiplier. */
  speed?: number;
  /** Range band [min, max] that ranged mobs hold (and melee mobs for keep_distance). */
  range?: [number, number];
  /** Walk here instead of straight at the target (null = default). */
  goal?(ctx: TacticContext): THREE.Vector3 | null;
  /** Extra per-frame behaviour; may edit the movement input. */
  act?(ctx: TacticContext, input: StepInput): void;
}

const tactics = new Map<string, TacticBehavior>();

/** Adds or replaces a tactic behaviour. */
export function registerTactic(name: string, behavior: TacticBehavior): void {
  tactics.set(name, behavior);
}

/** The behaviour for a tactic name, or null for unknown names. */
export function getTacticBehavior(name: string): TacticBehavior | null {
  return tactics.get(name) ?? null;
}

/** Names of all registered tactics. */
export function tacticNames(): string[] {
  return [...tactics.keys()];
}

// -- helpers -------------------------------------------------------------------------------------

/**
 * "Builds up" under the mob: jump, and at the top of the jump place a block in the cell it
 * left. Lets zombies tower up to a pillaring player or onto a roof.
 */
export function buildUp(mob: Mob, block = BLOCK.cobblestone): void {
  const s = mob.tacticState as { buildY?: number; buildCooldown?: number };
  const now = mob.age;
  if (s.buildY === undefined) {
    if (!mob.onGround || (s.buildCooldown ?? 0) > now) return;
    s.buildY = Math.floor(mob.position.y + 0.01);
    mob.velocity.y = 8.6;
    return;
  }
  const by = s.buildY;
  const bx = Math.floor(mob.position.x), bz = Math.floor(mob.position.z);
  if (mob.position.y >= by + 1.02) {
    const world = mob.game.world;
    if (world.getBlock(bx, by, bz) === BLOCK.air || !(BLOCK_FLAGS[world.getBlock(bx, by, bz)] & F_SOLID)) {
      world.setBlock(bx, by, bz, block, { source: 'entity', entity: mob });
    }
    s.buildY = undefined;
    s.buildCooldown = now + 0.15;
  } else if (mob.onGround && mob.velocity.y <= 0 && mob.position.y < by + 0.5) {
    // Jump failed (ceiling); give up for a moment.
    s.buildY = undefined;
    s.buildCooldown = now + 1.5;
  }
}

const tmpGoal = new THREE.Vector3();

/** Finds a high standing spot near the target (roofs, hills). Cached on the mob for a few seconds. */
function roofSpot(ctx: TacticContext): THREE.Vector3 | null {
  const s = ctx.mob.tacticState as { roof?: THREE.Vector3 | null; roofAt?: number };
  if (s.roofAt !== undefined && ctx.mob.age - s.roofAt < 6) return s.roof ?? null;
  s.roofAt = ctx.mob.age;
  const world = ctx.game.world;
  const t = ctx.target;
  let best: THREE.Vector3 | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2 + ctx.mob.id;
    const r = 4 + (i % 4) * 3;
    const x = Math.floor(t.x + Math.cos(a) * r), z = Math.floor(t.z + Math.sin(a) * r);
    if (!world.isLoaded(x, z)) continue;
    const top = world.topSolidY(x, z);
    const y = top + 1;
    if (y < t.y + 2 || world.isLiquid(x, top, z)) continue;
    const score = (y - t.y) * 2 - Math.hypot(x - t.x, z - t.z) * 0.5 - Math.hypot(x - ctx.mob.position.x, z - ctx.mob.position.z) * 0.15;
    if (score > bestScore) {
      bestScore = score;
      best = new THREE.Vector3(x + 0.5, y, z + 0.5);
    }
  }
  s.roof = best;
  return best;
}

// -- built-in tactics ----------------------------------------------------------------------------

registerTactic('rush', {
  speed: 1.35,
  range: [1.5, 5],
  path: { greed: 2 },
});

registerTactic('keep_distance', {
  range: [11, 17],
  goal(ctx) {
    const { mob, target, distance } = ctx;
    if (mob.type === 'skeleton') return null; // the skeleton's own range logic handles it
    // Melee mobs circle at ~6 blocks and lunge every few seconds.
    const s = mob.tacticState as { lungeAt?: number; lunging?: number };
    if (s.lungeAt === undefined) s.lungeAt = mob.age + 3 + Math.random() * 4;
    if (s.lunging !== undefined && mob.age < s.lunging) return null;
    if (mob.age > s.lungeAt) {
      s.lunging = mob.age + 3;
      s.lungeAt = mob.age + 7 + Math.random() * 5;
      return null;
    }
    if (distance < 4) return null;
    const dx = mob.position.x - target.x, dz = mob.position.z - target.z;
    const side = mob.id % 2 ? 1 : -1;
    const ang = Math.atan2(dz, dx) + side * 0.5;
    return tmpGoal.set(target.x + Math.cos(ang) * 6, target.y, target.z + Math.sin(ang) * 6);
  },
});

registerTactic('flank', {
  speed: 1.1,
  goal(ctx) {
    const { mob, target, distance } = ctx;
    if (distance < 5) return null;
    const s = mob.tacticState as { side?: number };
    if (s.side === undefined) s.side = mob.id % 2 ? 1 : -1;
    // Swing wide: aim at a point beside the target, perpendicular to our approach.
    const dx = mob.position.x - target.x, dz = mob.position.z - target.z;
    const d = Math.hypot(dx, dz) || 1;
    const ang = Math.atan2(dz, dx) + s.side * 1.25;
    const r = Math.min(8, d * 0.7);
    return tmpGoal.set(target.x + Math.cos(ang) * r, target.y, target.z + Math.sin(ang) * r);
  },
});

registerTactic('climb_pillar', {
  path: { climb: true, maxDrop: 4 },
  speed: 1.1,
  act(ctx, input) {
    const { mob, target, distance } = ctx;
    // Target well above and close: tower up under ourselves (spiders just climb).
    if (mob.type !== 'spider' && target.y - mob.position.y > 1.5 && distance < 2.2) {
      input.moveX = (target.x - mob.position.x) * 0.8;
      input.moveZ = (target.z - mob.position.z) * 0.8;
      buildUp(mob);
    }
  },
});

registerTactic('tunnel', {
  path: { dig: true, digMaxHardness: 2.5, maxNodes: 4000 },
  speed: 0.95,
});

registerTactic('rooftops', {
  path: { ladders: true, maxDrop: 4 },
  range: [0, 24],
  goal(ctx) {
    const { mob, target, distance } = ctx;
    // Melee mobs drop down once the target is close.
    if (mob.type !== 'skeleton' && distance < 5) return null;
    return roofSpot(ctx);
  },
  act(ctx, input) {
    const { mob } = ctx;
    const roof = (mob.tacticState as { roof?: THREE.Vector3 | null }).roof;
    if (!roof) return;
    const hd = Math.hypot(roof.x - mob.position.x, roof.z - mob.position.z);
    // Stuck at the foot of the building: build up the wall side.
    if (hd < 2.5 && roof.y - mob.position.y > 1.2 && (mob.brain.state === 'failed' || mob.brain.path?.complete === false)) {
      input.moveX = (roof.x - mob.position.x) * 0.6;
      input.moveZ = (roof.z - mob.position.z) * 0.6;
      buildUp(mob);
    }
  },
});

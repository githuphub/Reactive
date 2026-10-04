/**
 * Public mob API for V2 (villagers, golem) and V3 (raids, Reactive directives).
 *
 * ```ts
 * import { spawnMob, spawnWave, pathfind, MobBrain } from '../mobs';
 * spawnMob('creeper', { x, y, z }, { tactic: 'tunnel' });
 * spawnWave({ mob: 'skeleton', count: 3, tactic: 'rooftops', spawn: 'east', center: villageCenter });
 * const path = pathfind(villager.position, door, { doors: true });
 * ```
 *
 * The bound helpers (`spawnMob`, `spawnWave`, `pathfind`) use the game the mobs plugin was
 * initialised with; the `get*(game)` accessors work with any game.
 */
import type { Game } from '../game/game';
import { findPath, type Path, type PathOptions, type Vec3Like } from './pathfind';
import { getSpawnDirector, type WaveSpec } from './spawner';
import type { Mob } from './mob';
import type { SpawnMobOptions } from './types';

export * from './types';
export { Mob, PREY_TYPES, type MobStats, type MobTarget, type Hostility } from './mob';
export { MobBrain, seek, flee, strafe, separate, hasLineOfSight, yawTo, turnTowards, type BrainOptions, type BrainState } from './brain';
export { findPath, getPathfinder, Pathfinder, PathSearch, PathRequest, type Path, type PathNode, type PathOptions, type MoveKind } from './pathfind';
export { registerTactic, getTacticBehavior, tacticNames, buildUp, type TacticBehavior, type TacticContext } from './tactics';
export { registerMobType, createMob, mobTypes, type MobFactory } from './registry';
export { SpawnDirector, getSpawnDirector, type WaveSpec, type SpawnPlacement, type NaturalSpawnContext, type NaturalSpawnHook } from './spawner';
export { explode, primeTnt, type ExplosionOptions } from './explosion';
export { shootArrow, aimArrow, getProjectiles, type ArrowOptions } from './projectile';
export { Zombie } from './zombie';
export { Skeleton } from './skeleton';
export { Creeper, CREEPER_FUSE } from './creeper';
export { Spider } from './spider';
export { Animal, Pig, Cow } from './animals';
export { createZombieModel, createSkeletonModel, createCreeperModel, createSpiderModel, createPigModel, createCowModel, animateQuadruped, animateSpider } from './models';

let bound: Game | null = null;

/** @internal called by mobs/plugin.ts */
export function bindMobsGame(game: Game): void {
  bound = game;
}

function game(): Game {
  if (!bound) throw new Error('Mobs are not initialised yet: call spawnMob/pathfind after plugins init (or use getSpawnDirector(game)).');
  return bound;
}

/** Spawns one mob at a feet position. Persistent unless `opts.persistent === false`. */
export function spawnMob(type: string, pos: Vec3Like, opts?: SpawnMobOptions): Mob | null {
  return getSpawnDirector(game()).spawnMob(type, pos, opts);
}

/** Spawns a raid wave (see {@link WaveSpec}). */
export function spawnWave(wave: WaveSpec): Mob[] {
  return getSpawnDirector(game()).spawnWave(wave);
}

/** Synchronous A* in the current world. Returns a (possibly partial) path or null. */
export function pathfind(from: Vec3Like, to: Vec3Like, opts?: PathOptions): Path | null {
  return findPath(game().world, from, to, opts);
}

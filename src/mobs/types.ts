/**
 * Shared mob types: mob type names, raid tactics and spawn options.
 */
import type { Entity } from '../engine/entity';

/** Built-in hostile mobs. */
export type HostileMobType = 'zombie' | 'baby_zombie' | 'skeleton' | 'creeper' | 'spider';
/** Built-in animals. */
export type AnimalMobType = 'pig' | 'cow';
/** Built-in mob types (more can be added with `registerMobType`). */
export type MobType = HostileMobType | AnimalMobType;

/**
 * Raid tactics (behaviour modifiers, V3 picks them to counter the player's habits):
 * - `climb_pillar`: climbs walls and pillars (spider-style) and builds up under a high target.
 * - `tunnel`: digs through soft blocks towards the target (counters walls and hiding).
 * - `keep_distance`: holds a wide ring; ranged mobs snipe, melee mobs feint and lunge.
 * - `rush`: faster, direct, no hanging back.
 * - `flank`: approaches from the side instead of head-on.
 * - `rooftops`: takes high ground near the target (roofs, hills) before engaging.
 */
export type Tactic = 'climb_pillar' | 'tunnel' | 'keep_distance' | 'rush' | 'flank' | 'rooftops';

export const TACTICS: readonly Tactic[] = ['climb_pillar', 'tunnel', 'keep_distance', 'rush', 'flank', 'rooftops'];

/** Options for `spawnMob` and raid waves. All optional. */
export interface SpawnMobOptions {
  /** Raid tactic (string tactics registered with `registerTactic` work too). */
  tactic?: Tactic | (string & {}) | null;
  /** Fixed target: 'player' or an entity (villager, golem). Default: nearest valid target. */
  target?: 'player' | Entity | null;
  /** Zombie only: carries a shield that blocks most frontal damage. */
  shield?: boolean;
  /** Never despawns (raid mobs). Default false for natural spawns, true for spawnMob. */
  persistent?: boolean;
  /** Doesn't burn in daylight. */
  fireproof?: boolean;
  /** Override max health. */
  health?: number;
  /** Speed multiplier. Default 1. */
  speed?: number;
  /** How far it notices targets (blocks). Default per type (16–24); raids use 48. */
  followRange?: number;
  /** Tag in the mobSpawned event. Default 'director'. */
  reason?: string;
  /** Free-form data copied onto `mob.data` (faction, wave id, captain, ...). */
  data?: Record<string, unknown>;
}

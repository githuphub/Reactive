/**
 * Mob type registry: maps type names to factories. Built-ins: zombie, baby_zombie, skeleton,
 * creeper, spider, pig, cow. V2/V3 can add more with {@link registerMobType}.
 */
import { Cow, Pig } from './animals';
import { Creeper } from './creeper';
import type { Mob } from './mob';
import { Skeleton } from './skeleton';
import { Spider } from './spider';
import type { SpawnMobOptions } from './types';
import { Zombie } from './zombie';

export type MobFactory = (opts: SpawnMobOptions) => Mob;

const factories = new Map<string, MobFactory>();

/** Registers (or replaces) a mob type. */
export function registerMobType(type: string, factory: MobFactory): void {
  factories.set(type, factory);
}

/** Creates a mob instance (not yet added to the world). Throws for unknown types. */
export function createMob(type: string, opts: SpawnMobOptions = {}): Mob {
  const f = factories.get(type);
  if (!f) throw new Error(`Unknown mob type "${type}". Known: ${[...factories.keys()].join(', ')}`);
  return f(opts);
}

/** All registered mob type names. */
export function mobTypes(): string[] {
  return [...factories.keys()];
}

registerMobType('zombie', (o) => new Zombie({ shield: o.shield }));
registerMobType('baby_zombie', (o) => new Zombie({ baby: true, shield: o.shield }));
registerMobType('skeleton', () => new Skeleton());
registerMobType('creeper', () => new Creeper());
registerMobType('spider', () => new Spider());
registerMobType('pig', () => new Pig());
registerMobType('cow', () => new Cow());

/**
 * Id mapping between the game and the Liveforge manifest. All Liveforge traffic uses the manifest ids
 * (`captain_rowan`, `iron_golem`, post `square` ...); the village resolves both forms.
 */
import { village } from '../village';
import type { Npc } from '../village';

/** Named villagers as manifest persona ids. */
export const LF_NAMED = ['bram', 'mara', 'hilde', 'pip', 'captain_rowan', 'iron_golem'] as const;
export type LfNpcId = (typeof LF_NAMED)[number];

/** The faction (village mind) id of Oakhollow. */
export const FACTION = 'oakhollow';

/** Game npc id (or alias) → manifest persona id. */
export function lfNpcId(id: string): string {
  const npc = village.npc(id);
  const k = npc?.def.id ?? id;
  return k === 'rowan' ? 'captain_rowan' : k;
}

/** Manifest persona id (or any alias) → the game's villager. */
export function npcOf(id: string): Npc | undefined {
  return village.npc(id);
}

/** Display name for a persona id ("Captain Rowan"). */
export function npcName(id: string): string {
  return village.npc(id)?.def.name ?? id;
}

/** Inside Oakhollow (within the village site radius)? */
export function inVillage(x: number, z: number, site: { x: number; z: number; radius: number } | null): boolean {
  return !!site && Math.hypot(x - site.x, z - site.z) < site.radius;
}

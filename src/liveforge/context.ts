/**
 * Compact world summaries for the agents (`lf.agents.setContext`) and for goal / reply context.
 */
import type { Game } from '../game/game';
import { findItem } from '../engine/items';
import { village } from '../village';
import { zoneAt } from './signals';

const DIRS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/** "12 blocks east of the plaza" style description of a point relative to the village centre. */
export function whereIs(game: Game, x: number, z: number): string {
  const site = game.villageSite;
  if (!site) return `at ${Math.round(x)}, ${Math.round(z)}`;
  const cx = site.x, cz = site.z + 3;
  const dx = x - cx, dz = z - cz;
  const d = Math.round(Math.hypot(dx, dz));
  if (d < 6) return 'at the plaza';
  // north = -z
  const a = (Math.atan2(dx, -dz) + Math.PI * 2) % (Math.PI * 2);
  const dir = DIRS[Math.round(a / (Math.PI / 4)) % 8];
  return `${d} blocks ${dir} of the plaza${d > site.radius ? ' (outside the village)' : ''}`;
}

/** Notable items in the player's inventory ("12 coins, iron pickaxe, 30 oak planks"). */
export function inventoryHighlights(game: Game, max = 6): string {
  const totals = new Map<string, number>();
  for (const s of game.inventory.slots) if (s) totals.set(s.item, (totals.get(s.item) ?? 0) + s.count);
  const rank = (name: string, n: number) => {
    const def = findItem(name);
    return (def?.tool ? 100 : 0) + (name === 'coins' ? 90 : 0) + (/diamond|gold|iron|forged/.test(name) ? 50 : 0) + Math.min(40, n);
  };
  return [...totals.entries()]
    .sort((a, b) => rank(b[0], b[1]) - rank(a[0], a[1]))
    .slice(0, max)
    .map(([k, n]) => `${n > 1 ? `${n} ` : ''}${(findItem(k)?.displayName ?? k).toLowerCase()}`)
    .join(', ') || 'nothing';
}

/** The world as one short paragraph (time, weather, player, nearby, village posture). */
export function worldSummary(game: Game, playerName: string): string {
  const p = game.player.position;
  const t = game.time;
  const hh = Math.floor(t.hours), mm = Math.floor((t.hours - hh) * 60);
  const state = village.state();
  const hostiles = game.entities.query(p, 24, (e) => (e as { category?: string }).category === 'hostile').length;
  const near = state.npcs
    .filter((n) => Math.hypot(n.x - p.x, n.z - p.z) < 16)
    .map((n) => `${n.name} (${n.activity})`)
    .slice(0, 4)
    .join(', ');
  const zone = zoneAt(game, p.x, p.y, p.z);
  const damaged = state.buildings.filter((b) => b.damaged > 0).map((b) => `${b.id} (${b.damaged} blocks missing)`).slice(0, 3).join(', ');
  return [
    `Day ${t.day + 1}, ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} (${t.phase}), weather ${game.weather.current}.`,
    `${playerName} is ${whereIs(game, p.x, p.z)}${zone ? ` in ${zone}` : ''}, holding ${game.inventory.selectedStack?.item ?? 'nothing'}; carries ${inventoryHighlights(game)}.`,
    near ? `Nearby villagers: ${near}.` : '',
    hostiles ? `${hostiles} hostile mobs within 24 blocks!` : '',
    `Village posture ${state.posture}, prices x${state.priceMult.toFixed(2)}${damaged ? `; damaged: ${damaged}` : ''}${state.golemConfronting ? '; the golem is confronting the player' : ''}.`,
  ].filter(Boolean).join(' ');
}

/** Short per-NPC situation line for goals. */
export function npcSituation(game: Game, npcId: string): string {
  const n = village.npc(npcId);
  if (!n) return '';
  return `${n.def.name} is ${whereIs(game, n.position.x, n.position.z)}, currently ${n.controller.activity}.${npcId === 'bram' && village.plots[0] ? ' His building plot is the cleared dirt lot west of the plaza (use build to build there).' : ''}`;
}

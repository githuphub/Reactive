/**
 * Proximity barks: walking up to a named villager sends `movement.near_npc` and asks `npc.bark` (persona + Reaction
 * Library lines: outfit comments, nicknames, time/weather ...). Throttled per villager and globally.
 */
import type { Game } from '../game/game';
import { village } from '../village';
import { npcSay } from './directives';
import { LF_NAMED, lfNpcId } from './ids';
import type { LiveforgeService } from './service';

export function wireBarks(game: Game, lf: LiveforgeService, busy: () => boolean): void {
  const last = new Map<string, number>();
  let lastAny = 0;
  setInterval(() => {
    if (!game.ready || game.ui.screens.isOpen || busy()) return;
    const now = performance.now();
    if (now - lastAny < 12_000) return;
    const p = game.player.position;
    for (const id of LF_NAMED) {
      const n = village.npc(id);
      if (!n || n.removed || n.injured) continue;
      if (n.position.distanceTo(p) > 5.5) continue;
      if (n.controller.busy && n.controller.agentControlled) continue;
      if (now - (last.get(id) ?? -1e9) < 60_000) continue;
      last.set(id, now);
      lastAny = now;
      const lid = lfNpcId(id);
      lf.signal('movement.near_npc', { npc: lid, distance: Math.round(n.position.distanceTo(p)) });
      lf.ask('npc.bark', { npc: lid, trigger: 'approach' }, { upgrade: false }).instant.then(
        (r) => npcSay(lf, lid, r.result.text, r.result.emote),
        () => {},
      );
      break;
    }
  }, 1500);
}

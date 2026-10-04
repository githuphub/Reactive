/**
 * Directive handlers: what the server tells the game to do.
 *
 * - `npc.bark`, `npc.action`, `rumour.heard`: villagers speak and act.
 * - `custom.reaction`: Reaction Library effects (repair quest, nicknames, town mood → prices, rich attention,
 *   time/weather barks, absence recap, guards ...).
 * - `custom.faction_posture` / `custom.guard_posts`: the village mind (posture, prices, Rowan's announcement, posts).
 * - `quest.offer`, `quest.update`, `achievement.unlocked`: quests and toasts.
 * - `custom.statue`: the statue for the mender. `forge.ready`: forge upgrades.
 * (`agent.tool_call` / `agent.done` are handled by the SDK's agents API.)
 */
import type { Directive, FactionPostureArgs, GuardPostsArgs, Quest } from '@liveforge/sdk';
import type { Game } from '../game/game';
import { takeItem } from '../survival';
import { village, type Posture } from '../village';
import type { Amends } from './amends';
import { getHub } from './hub';
import { npcName } from './ids';
import { getQuests } from './quests';
import type { LiveforgeService } from './service';
import { runNpcAction } from './talk';
import { mapTarget } from './tools';
import { speakAs } from './voice';

type Args = Record<string, unknown>;

/** Says a line as a villager (bubble + voice + chat log). */
export function npcSay(lf: LiveforgeService, npc: string, text: string, emote?: string): void {
  const ctl = village.controller(npc);
  if (!ctl || !text) return;
  if (npc === 'iron_golem' || npc === 'golem') {
    void ctl.emote(emote ?? 'creak', { priority: 'schedule' });
    return;
  }
  void ctl.say(text, { priority: 'schedule', ...(emote ? { emote } : {}) });
  speakAs(lf, npc, text);
  getHub().chatLine(npc, text);
}

export function wireDirectives(game: Game, lf: LiveforgeService, amends: Amends, forgeReady: (d: Directive) => void): void {
  const c = lf.client;

  c.on('npc.bark', (d) => {
    const a = d.args;
    const near = village.npc(a.npc);
    if (!near || near.position.distanceTo(game.player.position) > 48) return;
    npcSay(lf, a.npc, a.text, a.emote);
  });

  c.on('npc.action', (d) => {
    const a = d.args;
    if (a.line) npcSay(lf, a.npc, a.line);
    void runNpcAction(game, lf, a.npc, a.action.action, (a.action.args ?? {}) as Args);
  });

  c.on('rumour.heard', (d) => {
    if (getHub().onRumourHeard?.(d)) return; // lane WB: gossip visualiser
    const a = d.args;
    if ((a.heat ?? 0.5) < 0.3) return;
    const n = village.npc(a.npc);
    if (n && n.position.distanceTo(game.player.position) < 24) npcSay(lf, a.npc, `Have you heard? ${a.content}`);
  });

  c.on('custom.reaction', (d) => onReaction(game, lf, d.args as unknown as { recipe: string; payload?: Args; line?: string }));

  c.on('custom.faction_posture', (d) => {
    const a = d.args as unknown as FactionPostureArgs & { stage?: string };
    const posture = a.posture as Posture;
    village.setPosture(posture);
    village.setPriceMult(a.priceMult);
    if (a.announcement) npcSay(lf, 'rowan', a.announcement);
    getHub().caption(`🏰 Oakhollow is ${posture} · prices ×${a.priceMult.toFixed(2)}${a.stage === 'ai' ? ' (council)' : ''}`, 6);
  });

  c.on('custom.guard_posts', (d) => {
    const a = d.args as unknown as GuardPostsArgs;
    for (const { npc, post } of a.posts) {
      const ctl = village.controller(npc);
      if (!ctl) continue;
      const target = post.startsWith('player:') ? 'player' : mapTarget(post);
      void ctl.guard(target);
    }
  });

  c.on('quest.offer', (d) => getQuests().offer(d.args.quest as Quest, d.args.giver ?? d.args.quest.giver));
  c.on('quest.update', (d) => getQuests().update(d.args.questId, d.args.status, d.args.objectiveId, d.args.progress));
  c.on('achievement.unlocked', (d) => getQuests().achievement(d.args.achievement));

  c.on('custom.statue', (d) => {
    const a = (d.args ?? {}) as Args;
    amends.statueFromServer(typeof a.prompt === 'string' ? a.prompt : undefined);
  });

  c.on('forge.ready', (d) => forgeReady(d));

  c.on('moment', (d) => {
    const m = d.args.moment as { id?: string; title?: string; name?: string; description?: string };
    const name = m.title ?? m.name ?? m.id;
    if (name) game.ui.toast(`✨ ${name}`, { seconds: 3 });
  });
}

/** Reaction Library effects (docs/reactions.md payloads). */
function onReaction(game: Game, lf: LiveforgeService, a: { recipe: string; payload?: Args; line?: string }): void {
  const p = a.payload ?? {};
  const speaker = typeof p.npc === 'string' ? p.npc : null;
  const line = (typeof p.line === 'string' ? p.line : a.line) ?? '';
  if (speaker && line) npcSay(lf, speaker, line, typeof p.emote === 'string' ? p.emote : undefined);
  if (Array.isArray(p.lines)) {
    (p.lines as { npc: string; text: string }[]).forEach((l, i) => setTimeout(() => npcSay(lf, l.npc, l.text), i * 3500));
  }
  if ((p.effect === 'repair_quest' || p.effect === 'compensation' || p.effect === 'guards') && typeof p.owner === 'string') {
    // the owner comes to confront the player
    const owner = village.controller(p.owner);
    if (owner) void owner.walkTo('player', { run: true }).then(() => owner.emote('glare'));
  }
  switch (p.effect) {
    case 'repair_quest':
      if (p.quest) getQuests().offer(p.quest as Quest, String(p.owner ?? 'mara'));
      break;
    case 'nickname':
      if (typeof p.nickname === 'string') {
        getHub().nickname = p.nickname;
        game.ui.toast(`The village calls you “${p.nickname}”${p.because ? ` for ${String(p.because)}` : ''}`, { kind: 'good', seconds: 5 });
        getHub().caption(`🏷 Nickname: “${p.nickname}”`, 6);
      }
      break;
    case 'town_mood':
      if (typeof p.price_mult === 'number') village.setPriceMult(p.price_mult);
      game.ui.toast(`Oakhollow feels ${String(p.moodLabel ?? (Number(p.mood) > 0 ? 'warm' : 'cold'))} towards you`, { kind: Number(p.mood) > 0 ? 'good' : 'warn' });
      break;
    case 'price_gouging':
    case 'price_adjust':
      if (typeof p.price_mult === 'number') game.ui.toast(`${npcName(String(p.merchant ?? p.npc ?? 'hilde'))}'s prices ×${(p.price_mult as number).toFixed(2)}`, { kind: 'warn' });
      break;
    case 'pickpocket': {
      const n = Math.max(1, Math.min(10, Number(p.amount) || 2));
      if (takeItem(game, 'coins', n)) game.ui.toast(`Someone lifted ${n} coins from your pocket!`, { kind: 'warn' });
      break;
    }
    case 'tax': {
      const n = Math.max(1, Math.min(10, Number(p.amount) || 1));
      if (takeItem(game, 'coins', n)) game.ui.toast(`Village tax: −${n} coins`, { kind: 'warn' });
      break;
    }
    case 'guards':
      village.golemConfront(20, 'guards called');
      void village.controller('rowan')?.guard('player');
      break;
    case 'behaviour':
    case 'recap':
    case 'concern':
    case 'compensation':
    default:
      break;
  }
  if (p.quest && p.effect !== 'repair_quest') getQuests().offer(p.quest as Quest, String(p.npc ?? p.giver ?? 'pip'));
}

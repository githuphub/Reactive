/**
 * Local rules (offline fallbacks, `client.setFallback`): persona replies and barks, goal detection, and the raid
 * counter-table, so every scenario runs without a server. The server's rules give richer answers when online.
 */
import type { AskParamsInput, AskResult, RaidPlanResult, RaidWave } from '@liveforge/sdk';
import { village } from '../village';
import type { Habit, HabitTally } from './signals';

/** Words that make a chat line a request for the agent loop. */
const GOAL_RE = /\b(build|construct|make|raise|repair|fix|mend|rebuild|bring|fetch|gather|collect|get me|mine|chop|harvest|follow|come with|escort|guard|protect|defend|patrol|go to|walk to|head to|trade|sell me|buy)\b/i;

/** True if a chat line reads as a request ("build me…", "bring me…", "follow me", "guard…"). */
export function isGoalRequest(text: string): boolean {
  const t = stripAddress(text);
  if (/\?\s*$/.test(t) && !/^(can|could|would|will) you\b/i.test(t)) return false;
  return GOAL_RE.test(t);
}

/** Removes a leading "Bram," / "hey Mara" address. */
export function stripAddress(text: string): string {
  return text.replace(/^\s*(hey|hi|hello|oi|ok|okay)?\s*,?\s*(bram|mara|hilde|pip|rowan|captain rowan|captain|golem)\s*[,:!-]\s*/i, '').trim();
}

const REPLIES: Record<string, { greet: string[]; ok: string[]; idle: string[] }> = {
  bram: {
    greet: ['Ah, a visitor! Need something built?', 'Good day! Mind the scaffolding.'],
    ok: ['Right you are, bottom up as always.', "Consider it built. Let me plan it out.", 'A fine idea. I know just the timber.'],
    idle: ['Oak for the walls, spruce for the trim. Trust me.', "A roof is a promise, friend. Mine don't leak.", 'Ask me to build anything. Anything!'],
  },
  mara: {
    greet: ['Mind the wheat.', 'Wipe your boots before you come near my house.'],
    ok: ['Fine. But be quick about it.', 'Hm. All right.'],
    idle: ["If you break it, you mend it. Simple.", 'The rain will come by evening, you mark me.', 'Bread is two coins. Fair price.'],
  },
  hilde: {
    greet: ['Buying or selling? Either way, wipe your hands.', 'Steel or stories? I only sell one.'],
    ok: ['Deal. Let us see your coins.', 'Fine work deserves a fine price.'],
    idle: ["Iron's up this week. Don't ask why.", 'Good steel never lies.', 'Haggle all you like. I remember.'],
  },
  pip: {
    greet: ['Oh! Have you heard?', 'Shh, the books are listening. Hello!'],
    ok: ['Ooh, an errand! I love errands.', 'Right away, and I will tell no one. Mostly.'],
    idle: ["I shouldn't say, but... everyone's talking about it.", 'The old mines are full of stories. And skeletons.', 'Bram is my uncle, you know. He built half the village.'],
  },
  captain_rowan: {
    greet: ['Keep your torch lit after dark.', 'Traveller. Eyes open, hands where I can see them.'],
    ok: ['Understood. On it.', 'Consider it done.'],
    idle: ['The night watch starts at dusk.', 'Monsters learn. So do we.', 'Torches up before sundown.'],
  },
  iron_golem: { greet: ['*creaks and nods*'], ok: ['*nods slowly*'], idle: ['*creaks and stares*', '*offers a poppy*'] },
};

const pick = <T,>(arr: readonly T[], seed: string) => arr[Math.abs([...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % arr.length];

/** Offline `npc.reply`: persona-flavoured rules with simple actions. */
export function localReply(p: AskParamsInput<'npc.reply'>): AskResult<'npc.reply'> {
  const npc = p.npc === 'rowan' ? 'captain_rowan' : p.npc;
  const r = REPLIES[npc] ?? REPLIES.bram;
  const text = stripAddress(p.text).toLowerCase();
  const seed = `${p.text}:${(p.history ?? []).length}`;
  const actions: AskResult<'npc.reply'>['actions'] = [];
  let line: string;
  if (/\b(hello|hi|hey|good (morning|day|evening))\b/.test(text) && text.length < 30) line = pick(r.greet, seed);
  else if (/\b(trade|buy|sell|shop|price)\b/.test(text) && ['bram', 'mara', 'hilde'].includes(npc)) {
    line = pick(r.ok, seed);
    actions.push({ action: 'trade', args: { priceMultiplier: village.priceMult }, target: 'player' });
  } else if (/\b(sorry|apolog|forgive)\b/.test(text)) line = npc === 'mara' ? 'Sorry mends nothing. Blocks do.' : 'Words are cheap. Deeds, less so.';
  else if (/\b(quest|job|work|help you|task)\b/.test(text)) {
    line = npc === 'mara' ? 'There is always work on a farm.' : 'Hm, let me think of something.';
    actions.push({ action: 'quest_offer', args: {}, target: 'player' });
  } else if (isGoalRequest(p.text)) line = pick(r.ok, seed);
  else line = pick(r.idle, seed);
  return { npc: p.npc, text: line, actions };
}

/** Offline `npc.bark`. */
export function localBark(p: AskParamsInput<'npc.bark'>): AskResult<'npc.bark'> {
  const npc = p.npc === 'rowan' ? 'captain_rowan' : p.npc;
  const r = REPLIES[npc] ?? REPLIES.bram;
  const pool = p.trigger === 'greeting' || p.trigger === 'approach' ? r.greet : r.idle;
  return { npc: p.npc, text: pick(pool, `${p.trigger}:${Date.now() >> 14}`), actions: [] };
}

// ------------------------------------------------------------------------------------------------ raid counter-table

const COUNTERS: Record<Habit, { waves: { mob: string; tactic: string; spawn: RaidWave['spawn']; share: number }[]; tactic: string; why: string; noun: string; counter: string }> = {
  pillaring: { waves: [{ mob: 'spider', tactic: 'climb', spawn: 'edge', share: 0.55 }, { mob: 'skeleton', tactic: 'crossfire', spawn: 'rooftops', share: 0.45 }], tactic: 'climbing spiders + skeleton crossfire', why: 'spiders climb pillars; skeletons shoot from two sides', noun: 'pillar', counter: 'climbers and crossfire' },
  bow_heavy: { waves: [{ mob: 'zombie', tactic: 'shield_rush', spawn: 'edge', share: 0.7 }, { mob: 'baby_zombie', tactic: 'rush', spawn: 'behind_player', share: 0.3 }], tactic: 'shielded zombies + rush', why: 'shields soak arrows and a rush closes the range', noun: 'bow', counter: 'shields' },
  hiding: { waves: [{ mob: 'creeper', tactic: 'tunnel', spawn: 'underground', share: 0.65 }, { mob: 'zombie', tactic: 'dig_in', spawn: 'edge', share: 0.35 }], tactic: 'creepers tunnel underground', why: 'creepers dig straight to whoever hides in a hole', noun: 'hole', counter: 'tunnellers' },
  melee_heavy: { waves: [{ mob: 'skeleton', tactic: 'keep_distance', spawn: 'rooftops', share: 0.7 }, { mob: 'spider', tactic: 'harass', spawn: 'edge', share: 0.3 }], tactic: 'skeletons keep their distance', why: 'skeletons stay out of sword reach', noun: 'sword arm', counter: 'archers who never come close' },
  kiting: { waves: [{ mob: 'baby_zombie', tactic: 'run_down', spawn: 'behind_player', share: 0.6 }, { mob: 'spider', tactic: 'cut_off', spawn: 'edge', share: 0.4 }], tactic: 'fast baby zombies', why: 'baby zombies are faster than a sprinting player', noun: 'running legs', counter: 'little runners' },
  fire: { waves: [{ mob: 'zombie', tactic: 'fire_resistant', spawn: 'edge', share: 0.6 }, { mob: 'skeleton', tactic: 'spread_out', spawn: 'rooftops', share: 0.4 }], tactic: 'fire-resistant, spread out', why: 'they arrive soaked and spread out', noun: 'fire', counter: 'soaked skins' },
};

const CAPTAINS = ['Lady Webweaver', 'Old Rattlebones', 'Mossjaw the Patient', 'Captain Creepwick', 'Gravelmaw'];

/** Offline `faction.raid_plan`: the same counter-table as the server, read from the local habit tally. */
export function localRaidPlan(habits: HabitTally, player: string, night: number): RaidPlanResult {
  const read = habits.read().filter((h) => h.score >= 0.25).slice(0, 2);
  const total = Math.min(12, 6 + night);
  if (!read.length) {
    return {
      waves: [
        { mob: 'zombie', count: 4, tactic: 'rush', spawn: 'edge', delaySec: 0 },
        { mob: 'skeleton', count: 3, tactic: 'spread_out', spawn: 'rooftops', delaySec: 20 },
        { mob: 'spider', count: 2, tactic: 'flank', spawn: 'edge', delaySec: 40 },
      ],
      captain: { name: CAPTAINS[night % CAPTAINS.length], taunt: `No tricks yet, ${player}? Then we come from everywhere.` },
      counters: [], why: `no strong habit read for ${player} yet: a mixed raid (night ${night})`, faction: 'oakhollow', night, size: 'medium', habits: [],
    };
  }
  const sum = read.reduce((n, h) => n + h.score, 0);
  const waves: RaidWave[] = [];
  let used = 0;
  for (const h of read) {
    const def = COUNTERS[h.habit];
    const budget = Math.max(2, Math.round((total * h.score) / sum));
    for (const w of def.waves) {
      if (waves.length >= 3 || used >= total) break;
      const count = Math.min(6, total - used, Math.max(1, Math.round(budget * w.share)));
      waves.push({ mob: w.mob, count, tactic: w.tactic, spawn: w.spawn, delaySec: waves.length * 20 });
      used += count;
    }
  }
  const lead = COUNTERS[read[0].habit];
  const taunts = [
    `Build your ${lead.noun} as high as you like, ${player}. Tonight we answer it with ${lead.counter}.`,
    `We watched your ${lead.noun}, ${player}. Meet my ${lead.counter}.`,
    `Every night the same trick. Every night we learn. Tonight: ${lead.counter}.`,
  ];
  return {
    waves,
    captain: { name: CAPTAINS[(night + read[0].habit.length) % CAPTAINS.length], taunt: taunts[night % taunts.length] },
    counters: read.map((h) => ({ habit: h.habit, tactic: COUNTERS[h.habit].tactic, why: `${h.evidence}: ${COUNTERS[h.habit].why}`.slice(0, 200) })),
    why: `${player}: ${read.map((h) => `${h.habit.replace(/_/g, ' ')} (${h.evidence})`).join(' + ')} → ${read.map((h) => COUNTERS[h.habit].tactic).join('; ')}; night ${night}`.slice(0, 300),
    faction: 'oakhollow', night, size: 'medium', habits: read,
  };
}

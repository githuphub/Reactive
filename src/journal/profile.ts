/**
 * "Who you are": the Observer's player model (`player.model` ask: traits with evidence, moments, profile text,
 * stats) when online, and a local estimate from Game events (PlayerStats) when not.
 */
import type { AskResult } from '@liveforge/sdk';
import type { LiveforgeService } from '../liveforge/service';
import type { PlayerStats } from '../liveforge/world/stats';

export interface ProfileView {
  source: 'server' | 'local';
  text: string;
  /** Strongest first. */
  traits: { name: string; score: number; evidence: string }[];
  stats: { label: string; value: string }[];
  moments: { text: string; ts: number }[];
  /** Model badge for the profile text. */
  model: 'rules' | 'sonnet' | 'replay' | 'cache';
}

/** Local traits: name, stat reader, scale (n at which the score is ~63 %), evidence, profile phrase. */
const LOCAL_TRAITS: { name: string; n: (s: PlayerStats) => number; k: number; ev: (n: number) => string; phrase: string; adj: string }[] = [
  { name: 'builder', n: (s) => s.count('blocksPlaced'), k: 120, ev: (n) => `${n} blocks placed`, phrase: 'builds whenever they stand still', adj: 'industrious' },
  { name: 'miner', n: (s) => s.count('blocksBroken'), k: 150, ev: (n) => `${n} blocks broken`, phrase: 'digs into anything that looks solid', adj: 'restless' },
  { name: 'fighter', n: (s) => s.count('kills'), k: 20, ev: (n) => `${n} monsters defeated`, phrase: 'meets every monster head-on', adj: 'fearless' },
  { name: 'griefer', n: (s) => s.count('griefs') + s.count('villagersHit') * 2, k: 5, ev: (n) => `${n} acts of vandalism`, phrase: "has a habit of breaking other people's things", adj: 'troublesome' },
  { name: 'trader', n: (s) => s.count('trades') + s.count('haggles'), k: 8, ev: (n) => `${n} trades and haggles`, phrase: 'never passes a market stall', adj: 'shrewd' },
  { name: 'social', n: (s) => s.count('talks') + s.talkedTo.size * 2, k: 12, ev: (n) => `${n} conversations`, phrase: 'knows everyone by name', adj: 'chatty' },
  { name: 'survivor', n: (s) => s.count('nights'), k: 3, ev: (n) => `${n} nights survived`, phrase: 'keeps seeing the sun come up', adj: 'hardy' },
  { name: 'reckless', n: (s) => s.count('deaths'), k: 3, ev: (n) => `${n} deaths`, phrase: 'keeps finding new ways to die', adj: 'reckless' },
  { name: 'archer', n: (s) => s.count('arrows'), k: 30, ev: (n) => `${n} arrows shot`, phrase: 'prefers to fight from a distance', adj: 'careful' },
  { name: 'pillarer', n: (s) => s.count('pillars'), k: 4, ev: (n) => `${n} pillars`, phrase: 'climbs out of trouble on a column of dirt', adj: 'crafty' },
  { name: 'tinkerer', n: (s) => s.count('forged') + s.count('crafted') / 10, k: 4, ev: (n) => `${Math.round(n)} things made`, phrase: 'is always forging something new', adj: 'inventive' },
];

/** The local estimate. */
export function localProfile(stats: PlayerStats): ProfileView {
  const traits = LOCAL_TRAITS.map((t) => {
    const n = t.n(stats);
    const score = 1 - Math.exp(-n / t.k);
    const evidence = t.name === 'pillarer' ? `${n} pillars, highest ${stats.maxPillar}` : t.ev(n);
    return { name: t.name, score, evidence, def: t };
  }).filter((t) => t.score >= 0.08).sort((a, b) => b.score - a.score);
  const top = traits.slice(0, 3);
  const text = top.length
    ? `A ${top[0].def.adj} ${top.length > 1 ? `and ${top[1].def.adj} ` : ''}traveller who ${top[0].def.phrase}${top[1] ? `, ${top[1].def.phrase}` : ''}${top[2] ? ` and ${top[2].def.phrase}` : ''}.`
    : 'A newcomer. Oakhollow is still making up its mind about you.';
  return {
    source: 'local',
    text,
    traits: traits.slice(0, 6).map(({ name, score, evidence }) => ({ name, score, evidence })),
    stats: localStats(stats),
    moments: stats.moments.slice(0, 8).map((m) => ({ text: m.text, ts: m.ts })),
    model: 'rules',
  };
}

function localStats(s: PlayerStats): { label: string; value: string }[] {
  const kills = Object.entries(s.kills).sort((a, b) => b[1] - a[1]);
  return [
    { label: 'Blocks placed', value: String(s.count('blocksPlaced')) },
    { label: 'Blocks broken', value: String(s.count('blocksBroken')) },
    { label: 'Monsters defeated', value: `${s.count('kills')}${kills[0] ? ` (mostly ${kills[0][0].replace(/_/g, ' ')}s)` : ''}` },
    { label: 'Deaths', value: String(s.count('deaths')) },
    { label: 'Nights survived', value: String(s.count('nights')) },
    { label: 'Trades', value: String(s.count('trades')) },
    { label: 'Villagers met', value: `${s.talkedTo.size}` },
    { label: 'Things forged', value: String(s.count('forged')) },
    { label: 'Quests done', value: String(s.count('quests')) },
    { label: 'Distance walked', value: `${Math.round(s.count('distance'))} m` },
  ];
}

/** Maps a `player.model` answer to the view (local stats are kept: the server stats are counters too). */
export function serverProfile(r: AskResult<'player.model'>, stats: PlayerStats, model: ProfileView['model']): ProfileView {
  const traits = Object.entries(r.traits ?? {})
    .map(([name, t]) => ({ name, score: t.score, evidence: t.evidence?.[0] ?? '' }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  const serverStats = Object.entries(r.stats ?? {}).slice(0, 6).map(([k, v]) => ({ label: k.replace(/[._]/g, ' '), value: String(v) }));
  const moments = (r.moments ?? []).slice(0, 8).map((m) => ({ text: `${m.kind.replace(/_/g, ' ')}${m.evidence?.[0] ? `: ${m.evidence[0]}` : ''}`, ts: m.ts }));
  const local = localProfile(stats);
  return {
    source: 'server',
    text: r.profile?.text || local.text,
    traits: traits.length ? traits : local.traits,
    stats: [...local.stats, ...serverStats],
    moments: moments.length ? [...moments, ...local.moments].sort((a, b) => b.ts - a.ts).slice(0, 10) : local.moments,
    model: r.profile?.text ? model : 'rules',
  };
}

/**
 * Loads the Observer's model. `onView` is called with the instant view, and again with the AI profile when
 * `refreshProfile` asks for a fresh one. Offline it gets the local estimate.
 */
export function loadProfile(lf: LiveforgeService, stats: PlayerStats, refreshProfile: boolean, onView: (v: ProfileView) => void): void {
  if (!lf.online) return onView(localProfile(stats));
  try {
    const h = lf.ask('player.model', { top: 6, ...(refreshProfile ? { refreshProfile: true } : {}) });
    h.instant.then((r) => onView(serverProfile(r.result, stats, r.source === 'cache' ? 'cache' : 'rules'))).catch(() => onView(localProfile(stats)));
    h.onUpgrade((u) => onView(serverProfile(u.result, stats, lf.cassette === 'REPLAY' ? 'replay' : 'sonnet')));
  } catch {
    onView(localProfile(stats));
  }
}

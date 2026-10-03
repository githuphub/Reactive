/**
 * Adaptive night raids: `faction.raid_plan` (server rules counter-table + Haiku upgrade, or the local counter-table
 * offline) → V1 waves with tactics at the requested spawn kinds, a named captain with a taunt bubble, and the guards
 * and golem moving in. Triggered by the Demo button or by nightfall on night ≥ 1.
 */
import type { AskResponse, RaidPlanResult, RaidWave } from '@liveforge/sdk';
import type { Game } from '../game/game';
import { getSpawnDirector, spawnMob, spawnWave, type Mob, type SpawnPlacement } from '../mobs';
import { village } from '../village';
import { getHub } from './hub';
import { FACTION } from './ids';
import { localRaidPlan } from './rules';
import type { LiveforgeService } from './service';
import { speakAs } from './voice';

/** Raid-plan tactic words → V1 tactics + spawn options. */
function mapTactic(t: string): { tactic: string | null; shield?: boolean; fireproof?: boolean; speed?: number } {
  const k = t.toLowerCase();
  if (/climb|pillar|scale/.test(k)) return { tactic: 'climb_pillar' };
  if (/shield/.test(k)) return { tactic: 'rush', shield: true };
  if (/tunnel|dig|burrow|underground/.test(k)) return { tactic: 'tunnel' };
  if (/distance|crossfire|snipe|spread|kite|range/.test(k)) return { tactic: 'keep_distance' };
  if (/roof|high/.test(k)) return { tactic: 'rooftops' };
  if (/flank|cut_off|harass|side|surround/.test(k)) return { tactic: 'flank' };
  if (/fire/.test(k)) return { tactic: 'rush', fireproof: true };
  if (/run_down|fast|rush|charge/.test(k)) return { tactic: 'rush', speed: 1.15 };
  return { tactic: 'rush' };
}

export class RaidRunner {
  private lastNight = -1;
  private captain: Mob | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  /** True while a raid is running. */
  active = false;

  constructor(private readonly game: Game, private readonly lf: LiveforgeService) {
    lf.client.setFallback('faction.raid_plan', (p) => localRaidPlan(getHub().habits, lf.settings.playerName, p.night ?? Math.max(1, game.time.day)));
    game.events.on('phaseChanged', (e) => {
      if (e.phase === 'night' && e.day >= 1 && e.day !== this.lastNight && !this.active) void this.start({ night: e.day });
    });
  }

  /** Plans and starts tonight's raid. Resolves with the plan in use. */
  async start(opts: { night?: number } = {}): Promise<RaidPlanResult | null> {
    const night = Math.max(1, opts.night ?? this.game.time.day);
    this.lastNight = this.game.time.day;
    this.stop();
    this.active = true;
    const t0 = performance.now();
    const h = this.lf.ask('faction.raid_plan', { faction: FACTION, night, size: 'medium' });
    let first: AskResponse<'faction.raid_plan'>;
    try {
      first = await h.instant;
    } catch {
      this.active = false;
      return null;
    }
    let plan = first.result;
    const local = first.ms === 0;
    if (local) {
      this.lf.think({ source: 'factions', actor: FACTION, kind: 'thought', text: `Threat model for ${this.lf.settings.playerName}: ${(plan.habits ?? []).map((x) => `${x.habit} ${x.score.toFixed(2)} (${x.evidence})`).join('; ') || 'nothing known yet'}`, model: 'rules', data: { habits: plan.habits } });
      this.lf.think({ source: 'factions', actor: FACTION, kind: 'plan', text: `raid night ${night}: ${plan.waves.map((w) => `${w.count} ${w.mob} (${w.tactic}, ${w.spawn})`).join(', ')}${plan.captain ? ` · ${plan.captain.name}: "${plan.captain.taunt}"` : ''}`, model: 'rules', ms: Math.round(performance.now() - t0), data: { plan } });
      this.lf.think({ source: 'factions', actor: FACTION, kind: 'decision', text: `why: ${plan.why}`, model: 'rules', data: { counters: plan.counters } });
    }
    let spawned = 0;
    h.onUpgrade((r) => {
      if (spawned > 0 || !r.result?.waves?.length) return;
      plan = r.result;
      this.game.ui.toast('The village mind revised the raid plan', { kind: 'warn' });
    });
    getHub().caption(`🌙 Raid night ${night}: ${plan.counters[0]?.tactic ?? 'a mixed raid'}${plan.counters[0] ? ` — countering ${plan.counters[0].habit.replace(/_/g, ' ')}` : ''}`, 8);
    this.rally();
    this.lf.client.factions.reportThreat({ faction: FACTION, kind: 'raid', source: 'monsters', level: 0.8, note: `night ${night} raid` }).catch(() => {});
    // the captain arrives first and taunts; the waves follow on their delays
    this.timers.push(setTimeout(() => this.spawnCaptain(plan), 2500));
    plan.waves.forEach((w, i) => {
      const delay = 5000 + (w.delaySec ?? i * 20) * 1000;
      this.timers.push(setTimeout(() => {
        spawned++;
        this.spawn(plan.waves[i] ?? w);
      }, delay));
    });
    const total = 5000 + Math.max(...plan.waves.map((w, i) => (w.delaySec ?? i * 20) * 1000)) + 90_000;
    this.timers.push(setTimeout(() => (this.active = false), total));
    return plan;
  }

  /** Cancels pending waves (spawned mobs stay). */
  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.active = false;
  }

  private spawn(w: RaidWave): void {
    const p = this.game.player.position;
    const m = mapTactic(w.tactic);
    let spawn: SpawnPlacement = 'ring';
    let radius = 20;
    if (w.spawn === 'underground') {
      spawn = 'near';
      radius = 10;
      m.tactic = 'tunnel';
    } else if (w.spawn === 'rooftops') {
      spawn = 'random';
      radius = 16;
      if (m.tactic === 'rush') m.tactic = 'rooftops';
    } else if (w.spawn === 'behind_player') {
      const yaw = this.game.player.yaw;
      // yaw 0 faces -Z; behind = +forward reversed
      spawn = { x: p.x + Math.sin(yaw) * 12, y: p.y, z: p.z + Math.cos(yaw) * 12 };
    }
    const mobs = spawnWave({
      mob: w.mob,
      count: Math.max(1, Math.min(8, w.count)),
      tactic: m.tactic,
      spawn,
      radius,
      center: p,
      target: 'player',
      options: { shield: m.shield, fireproof: m.fireproof ?? true, speed: m.speed, followRange: 48, reason: 'raid', data: { raid: true, faction: FACTION } },
    });
    this.lf.think({ source: 'director', actor: FACTION, kind: 'line', text: `wave: ${mobs.length} ${w.mob} → ${m.tactic ?? 'rush'} from ${w.spawn}`, model: 'rules' });
  }

  private spawnCaptain(plan: RaidPlanResult): void {
    const cap = plan.captain;
    if (!cap) return;
    const p = this.game.player.position;
    const a = Math.random() * Math.PI * 2;
    const spot = getSpawnDirector(this.game).findSpot(p.x + Math.cos(a) * 14, p.z + Math.sin(a) * 14) ?? { x: p.x + 10, y: p.y, z: p.z };
    const type = plan.waves.find((w) => w.mob === 'skeleton' || w.mob === 'zombie')?.mob ?? 'zombie';
    const mob = spawnMob(type, spot, { tactic: type === 'skeleton' ? 'keep_distance' : 'rush', target: 'player', fireproof: true, health: 40, followRange: 64, reason: 'raid_captain', data: { raid: true, captain: true, name: cap.name } });
    if (!mob) return;
    this.captain = mob;
    const layer = village.bubbles;
    if (layer) {
      const bubble = layer.add(() => ({ x: mob.position.x, y: mob.position.y + mob.height + 0.35, z: mob.position.z }), cap.name, 'Raid captain');
      void bubble.say(cap.taunt, { seconds: 7 });
      const off = this.game.events.on('entityRemoved', (e) => {
        if (e.entity !== mob) return;
        off();
        bubble.remove();
        if (this.captain === mob) this.captain = null;
        this.game.ui.toast(`${cap.name} has fallen!`, { kind: 'good' });
      });
    }
    getHub().caption(`${cap.name}: “${cap.taunt}”`, 7);
  }

  /** Guards and golem move to meet the raid. */
  private rally(): void {
    const p = this.game.player.position;
    const at = { x: p.x, y: p.y, z: p.z };
    const rowan = village.controller('rowan');
    if (rowan) {
      void rowan.guard(at);
      void rowan.say('To arms! They know your tricks. Stand with me!', { priority: 'schedule' });
      speakAs(this.lf, 'captain_rowan', 'To arms! They know your tricks. Stand with me!');
    }
    void village.controller('iron_golem')?.guard({ x: at.x + 3, y: at.y, z: at.z + 2 });
  }
}

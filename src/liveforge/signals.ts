/**
 * Game events → Liveforge signals. Everything the village mind, the Observer and the Reaction Library read comes
 * from here. Play-style detectors are throttled; a local habit tally feeds the offline raid counter-table.
 */
import type { Game } from '../game/game';
import { blockById } from '../engine/blocks';
import { findItem } from '../engine/items';
import { village } from '../village';
import { FACTION, inVillage, lfNpcId } from './ids';
import type { LiveforgeService } from './service';

/** Play-style habits the raid counter-table knows. */
export type Habit = 'pillaring' | 'bow_heavy' | 'hiding' | 'melee_heavy' | 'kiting' | 'fire';

/** Rolling tally of the player's habits (last 20 minutes), for the offline raid plan. */
export class HabitTally {
  private readonly log: { habit: Habit; ts: number; note: string }[] = [];

  add(habit: Habit, note = ''): void {
    this.log.push({ habit, ts: performance.now(), note });
    if (this.log.length > 400) this.log.splice(0, this.log.length - 400);
  }

  /** Habits with a 0-1 score, strongest first. */
  read(): { habit: Habit; score: number; evidence: string }[] {
    const since = performance.now() - 20 * 60_000;
    const counts = new Map<Habit, number>();
    for (const e of this.log) if (e.ts >= since) counts.set(e.habit, (counts.get(e.habit) ?? 0) + 1);
    const per: Record<Habit, number> = { pillaring: 4, bow_heavy: 12, hiding: 3, melee_heavy: 15, kiting: 6, fire: 4 };
    const what: Record<Habit, string> = { pillaring: 'pillared', bow_heavy: 'arrows shot', hiding: 'times hid', melee_heavy: 'melee hits', kiting: 'sprints away', fire: 'fire uses' };
    return [...counts.entries()]
      .map(([habit, n]) => ({ habit, score: Math.min(1, n / per[habit]), evidence: `${n} ${what[habit]} in 20 min` }))
      .sort((a, b) => b.score - a.score);
  }
}

/** Village zones a position falls in (manifest zone ids). */
export function zoneAt(game: Game, x: number, y: number, z: number): string | null {
  for (const b of village.buildings) {
    const { min, max } = b.bounds;
    if (x >= min[0] && x <= max[0] + 1 && z >= min[2] && z <= max[2] + 1 && y >= min[1] - 1 && y <= max[1] + 1) {
      if (b.kind === 'smithy') return 'smithy';
      if (b.kind === 'library') return 'library';
      if (b.owner === 'mara') return 'farm';
    }
  }
  const plot = village.plots[0];
  if (plot && x >= plot.rect.x0 && x <= plot.rect.x1 && z >= plot.rect.z0 && z <= plot.rect.z1) return 'bram_plot';
  if (inVillage(x, z, game.villageSite)) return 'oakhollow';
  const ground = game.world.heightAt(Math.floor(x), Math.floor(z));
  if (y < ground - 8) return 'mines';
  const biome = game.world.biomeAt(Math.floor(x), Math.floor(z));
  if (biome === 'forest') return 'oak_forest';
  return null;
}

/** The player's outfit as Liveforge slots (held item + clothes), also used for statue colours. */
export function outfitOf(game: Game): Record<string, { id: string; name: string; tags: string[]; colors: string[] }> {
  const held = game.inventory.selectedStack;
  const slots: Record<string, { id: string; name: string; tags: string[]; colors: string[] }> = {
    body: { id: 'teal_tunic', name: 'Teal Tunic', tags: ['tunic', 'traveller'], colors: ['teal'] },
    legs: { id: 'navy_trousers', name: 'Navy Trousers', tags: ['trousers'], colors: ['navy'] },
    feet: { id: 'leather_boots', name: 'Leather Boots', tags: ['boots'], colors: ['brown'] },
  };
  if (held) {
    const def = findItem(held.item);
    const data = (held.data ?? {}) as { name?: string; tags?: string[]; colors?: string[] };
    slots.weapon = {
      id: held.item,
      name: data.name ?? def?.displayName ?? held.item,
      tags: [...(data.tags ?? []), ...(def?.tool ? [def.tool.kind] : []), ...(def?.block !== null ? ['block'] : [])].slice(0, 8),
      colors: (data.colors ?? []).slice(0, 4),
    };
  }
  return slots;
}

/**
 * Wires every game event to its signal. Returns the habit tally (offline raid plans read it).
 */
export function wireSignals(game: Game, lf: LiveforgeService): HabitTally {
  const habits = new HabitTally();
  const site = () => game.villageSite;
  const villageOf = (x: number, z: number) => (inVillage(x, z, site()) ? FACTION : undefined);

  // -- blocks -----------------------------------------------------------------------------------
  game.events.on('blockBroken', (e) => {
    if (e.source !== 'player') return;
    const name = blockById(e.id).name;
    const own = village.ownerAt(e.x, e.y, e.z);
    const owner = own && own.owner !== 'village' ? lfNpcId(own.owner) : undefined;
    const tool = e.tool?.item;
    const value = Math.max(2, Math.round(blockById(e.id).hardness * 3));
    lf.signal('block.broken', { block: name, x: e.x, y: e.y, z: e.z, ...(owner ? { owner, value } : {}), ...(villageOf(e.x, e.z) ? { village: FACTION } : {}), ...(tool ? { tool } : {}) });
    if (own && owner) {
      lf.signal('world.property_damaged', { object: own.buildingId, owner, value, zone: FACTION });
    }
  });
  game.events.on('blockPlaced', (e) => {
    if (e.source !== 'player') return;
    const name = blockById(e.id).name;
    const own = village.ownerAt(e.x, e.y, e.z);
    const owner = own && own.owner !== 'village' ? lfNpcId(own.owner) : undefined;
    lf.signal('block.placed', { block: name, x: e.x, y: e.y, z: e.z, ...(owner ? { owner } : {}), ...(villageOf(e.x, e.z) ? { village: FACTION } : {}) });
    if (name === 'lava' || name === 'tnt') habits.add('fire', name);
  });

  // -- combat -----------------------------------------------------------------------------------
  game.events.on('mobKilled', (e) => {
    if (!e.byPlayer) return;
    lf.signal('combat.killed', { target: `${e.type}_${e.mob.id}`, target_type: e.type, ...(e.source.item ? { weapon: e.source.item.item } : {}), ...(e.mob.data.captain ? { elite: true } : {}) });
  });
  game.events.on('entityHurt', (e) => {
    if (!e.source.player || e.source.kind === 'arrow') return;
    const type = (e.entity as { type?: string }).type ?? 'thing';
    lf.signal('combat.hit', { target: `${type}_${e.entity.id}`, target_type: type, damage: e.amount, ...(e.source.item ? { weapon: e.source.item.item } : {}) });
    habits.add('melee_heavy', type);
  });
  game.events.on('playerHurt', (e) => {
    const src = e.source.entity as { type?: string } | null | undefined;
    lf.signal('combat.hurt', { source: src?.type ?? e.source.kind, source_type: src?.type ?? e.source.kind, damage: e.amount, hp: Math.max(0, e.health / 20), attack: e.source.kind });
    if (e.source.kind === 'lava' || e.source.kind === 'fire') habits.add('fire', e.source.kind);
  });
  game.events.on('playerDied', (e) => {
    const src = e.source.entity as { type?: string } | null | undefined;
    lf.signal('combat.died', { ...(src?.type ? { killer: src.type, killer_type: src.type } : { killer: e.source.kind }) });
  });
  let lastShot = 0;
  game.events.on('playerShotBow', (e) => {
    habits.add('bow_heavy');
    const now = performance.now();
    if (now - lastShot < 400) return;
    lastShot = now;
    const t = e.target as { type?: string } | null;
    lf.signal('combat.shot_bow', { ...(t?.type ? { target: t.type } : {}), ...(e.target ? { distance: Math.round(e.target.distanceTo(game.player.position)) } : {}) });
  });

  // -- play style (throttled detectors) ---------------------------------------------------------
  let pillarAt = 0;
  let pillarHeight = 0;
  game.events.on('pillared', (e) => {
    const now = performance.now();
    if (now - pillarAt < 3000 && e.height <= pillarHeight + 2) return;
    pillarAt = now;
    pillarHeight = e.height;
    habits.add('pillaring', `${e.height} high`);
    lf.signal('build.pillared', { height: e.height, x: e.x, z: e.z });
  });
  game.events.on('hid', (e) => {
    habits.add('hiding', `${e.depth} deep`);
    lf.signal('combat.hid', { depth: e.depth });
  });

  // -- items ------------------------------------------------------------------------------------
  game.events.on('itemCrafted', (e) => lf.signal('item.crafted', { item: e.item, count: e.count }));
  game.events.on('itemSmelted', (e) => lf.signal('item.crafted', { item: e.item, count: e.count }));

  // -- economy ------------------------------------------------------------------------------------
  game.events.on('traded', (e) => {
    const vendor = lfNpcId(e.npc);
    if (e.kind === 'buy') lf.signal('economy.bought', { item: e.item, price: e.price, vendor, currency: 'coins' });
    else lf.signal('economy.sold', { item: e.item, price: e.price, vendor });
  });
  game.events.on('haggled', (e) => {
    lf.signal('economy.haggled', { npc: lfNpcId(e.npc), delta_pct: e.accepted ? -10 : 0, outcome: e.accepted ? 'won' : 'lost' });
  });
  let coins = -1;
  let coinTimer: ReturnType<typeof setTimeout> | null = null;
  game.events.on('inventoryChanged', () => {
    if (coinTimer) return;
    coinTimer = setTimeout(() => {
      coinTimer = null;
      const n = game.inventory.count('coins');
      if (n === coins) return;
      const delta = coins < 0 ? undefined : n - coins;
      coins = n;
      lf.signal('economy.gold', { amount: n, ...(delta !== undefined ? { delta } : {}), currency: 'coins' });
    }, 800);
  });

  // -- social -------------------------------------------------------------------------------------
  game.events.on('villagerTalk', (e) => lf.signal('social.talked_to', { npc: lfNpcId(e.npc) }));

  // -- movement -------------------------------------------------------------------------------------
  let zone: string | null = null;
  let biome = '';
  let sprintStart = 0;
  game.events.on('playerMoved', (e) => {
    const z = zoneAt(game, e.x, e.y, e.z);
    if (z !== zone) {
      zone = z;
      if (z) {
        const kind = z === 'smithy' ? 'shop' : z === 'library' ? 'interior' : z === 'oakhollow' ? 'village' : z === 'mines' ? 'cave' : 'area';
        lf.signal('movement.entered_zone', { zone: z, kind });
        lf.signal('movement.visited', { place: z, kind, zone: z });
      }
    }
    if (e.biome !== biome) {
      biome = e.biome;
      lf.signal('movement.visited', { place: e.biome, kind: 'biome' });
    }
    const sprinting = game.player.sprinting;
    if (sprinting && !sprintStart) sprintStart = performance.now();
    if (!sprinting && sprintStart) {
      const s = (performance.now() - sprintStart) / 1000;
      sprintStart = 0;
      if (s > 6) {
        habits.add('kiting', `${s.toFixed(0)} s`);
        lf.signal('movement.sprinted', { seconds: Math.round(s) });
      }
    }
  });

  // -- world clock + weather --------------------------------------------------------------------------
  const sendTime = () => {
    lf.signal('world.time', { hour: Math.round(game.time.hours * 10) / 10, day: game.time.day, weather: game.weather.current, phase: game.time.phase });
  };
  game.events.on('phaseChanged', (e) => {
    sendTime();
    if (e.phase === 'dawn' && e.day > 0) lf.signal('night.survived', { night: e.day });
  });
  game.events.on('weatherChanged', sendTime);
  setInterval(sendTime, 60_000);

  // -- appearance --------------------------------------------------------------------------------------
  let lastOutfit = '';
  let outfitTimer: ReturnType<typeof setTimeout> | null = null;
  game.events.on('hotbarChanged', () => {
    if (outfitTimer) clearTimeout(outfitTimer);
    outfitTimer = setTimeout(() => {
      const slots = outfitOf(game);
      const key = JSON.stringify(slots);
      if (key === lastOutfit) return;
      lastOutfit = key;
      lf.signal('appearance.outfit', { slots, style_tags: ['traveller'] });
    }, 1200);
  });

  // -- session ---------------------------------------------------------------------------------------
  game.events.once('ready', () => {
    let last: number | undefined;
    try {
      const raw = localStorage.getItem('lc.lf.lastSeen');
      if (raw) last = Number(raw);
      setInterval(() => localStorage.setItem('lc.lf.lastSeen', String(Date.now())), 30_000);
    } catch {
      /* no storage */
    }
    lf.signal('session.started', last ? { last_seen_ts: last } : {});
    sendTime();
    lf.signal('appearance.outfit', { slots: outfitOf(game), style_tags: ['traveller'] });
  });

  return habits;
}

// Built-in trait library (spec §3.1). Scores come from exponentially decayed counters ("sliding windows + decay")
// that the observer.player_model projection updates per event. Everything here is deterministic: time is always
// the event's ts, never Date.now().
import type { StoredEvent } from "@liveforge/protocol";

/** Tunables (manifest `modules.observer.options`, all optional). */
export interface ObserverOptions {
  /** Gold at which `rich` reaches 1 (default 1000). */
  richGold: number;
  /** Gold at or under which `broke` reaches 1 (default 0; scales down to 0 at brokeGold * 4). */
  brokeGold: number;
  /** combat.hit with data.range >= this counts as ranged (default 8). */
  rangedDistance: number;
  /** A quest completed within this many seconds of acceptance counts as speedrunning (default 180). */
  speedQuestSec: number;
  /** Refresh the profile every N player events (default 40). */
  profileEvery: number;
  /** Half-life (minutes) of designer trait scores once their rule stops matching (default 10). */
  designerHalfLifeMin: number;
  /** Minimum price for an absurd_purchase moment (default 100). */
  absurdMin: number;
  /** Seconds between two moments of the same kind for one player (default 45). */
  momentCooldownSec: number;
}

export const DEFAULT_OBSERVER_OPTIONS: ObserverOptions = {
  richGold: 1000,
  brokeGold: 10,
  rangedDistance: 8,
  speedQuestSec: 180,
  profileEvery: 40,
  designerHalfLifeMin: 10,
  absurdMin: 100,
  momentCooldownSec: 45,
};

/** Merge manifest options over the defaults (bad values are ignored). */
export function observerOptions(raw: Record<string, unknown> | undefined): ObserverOptions {
  const o = { ...DEFAULT_OBSERVER_OPTIONS };
  for (const k of Object.keys(o) as (keyof ObserverOptions)[]) {
    const v = raw?.[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) o[k] = v;
  }
  return o;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Counter half-lives. */
export const COUNTERS = {
  hurt: 10 * MIN, dodged: 10 * MIN, blocked: 10 * MIN, parried: 10 * MIN, hit: 10 * MIN, melee: 10 * MIN,
  ranged: 10 * MIN, dmgOut: 10 * MIN, lowhp: 10 * MIN, rage: 10 * MIN, ability: 10 * MIN,
  kill: 30 * MIN, died: 30 * MIN, fled: 30 * MIN,
  npcKill: 2 * HOUR, stole: 2 * HOUR, lied: 2 * HOUR, threatened: HOUR, gave: 2 * HOUR, helped: 2 * HOUR,
  said: 30 * MIN, talked: 30 * MIN,
  bought: HOUR, spent: HOUR, sold: HOUR, earned: HOUR,
  explore: HOUR, zoneNew: HOUR, equip: 30 * MIN,
  questDone: 2 * HOUR, questFast: 2 * HOUR, boss: 6 * HOUR, moment: 6 * HOUR,
  noncombat: 30 * MIN,
} as const;
export type CounterName = keyof typeof COUNTERS;

/** Observer-private accumulators (stored in PlayerModel.acc). */
export type ObserverAcc = {
  /** counter -> [value at t, t] */
  c: Partial<Record<CounterName, [number, number]>>;
  /** Distinct zones entered (<= 64). */
  zones: string[];
  /** quest id -> accepted ts (<= 20). */
  quests: Record<string, number>;
  /** Last event ts seen (monotonic clock for decay). */
  t: number;
};

export const emptyAcc = (): ObserverAcc => ({ c: {}, zones: [], quests: {}, t: 0 });

/** Decayed value of a counter at time t. */
export function counterAt(acc: ObserverAcc, name: CounterName, t: number): number {
  const e = acc.c[name];
  if (!e) return 0;
  const dt = Math.max(0, t - e[1]);
  return e[0] * Math.pow(0.5, dt / COUNTERS[name]);
}

export function bump(acc: ObserverAcc, name: CounterName, t: number, by = 1): void {
  const v = counterAt(acc, name, t) + by;
  acc.c[name] = [Math.round(v * 1000) / 1000, t];
}

/** Smooth saturation 0..1 (0.63 at x = k). */
const sat = (x: number, k: number) => (x <= 0 ? 0 : 1 - Math.exp(-x / k));
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : Number.isFinite(x) ? x : 0);

export type TraitKind = "behaviour" | "state";
export interface TraitInfo {
  description: string;
  kind: TraitKind;
  /** Read-time half-life (behaviour traits fade when the player stops doing the thing). */
  halfLifeMs: number;
  score(get: (c: CounterName) => number, stats: Record<string, number | string | boolean>, o: ObserverOptions): number;
}

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** The built-in trait library (spec §3.1). */
export const BUILTIN_TRAITS: Record<string, TraitInfo> = {
  dodger: {
    description: "Avoids hits by dodging.", kind: "behaviour", halfLifeMs: 15 * MIN,
    score: (c) => (c("dodged") / (c("dodged") + c("blocked") + c("parried") + c("hurt") + 1)) * sat(c("dodged"), 4),
  },
  turtle: {
    description: "Blocks and parries; plays defensively.", kind: "behaviour", halfLifeMs: 15 * MIN,
    score: (c) => {
      const b = c("blocked") + c("parried");
      return (b / (b + c("dodged") + c("hurt") + 1)) * sat(b, 4);
    },
  },
  glass_cannon: {
    description: "Deals big damage but spends a lot of time near death.", kind: "behaviour", halfLifeMs: 20 * MIN,
    score: (c) => Math.sqrt(sat(c("dmgOut"), 250) * sat(c("lowhp") + c("died") * 2, 3)),
  },
  ranged_camper: {
    description: "Fights from range.", kind: "behaviour", halfLifeMs: 15 * MIN,
    score: (c) => Math.min(1, c("ranged") / (c("hit") + 0.5)) * sat(c("ranged"), 6),
  },
  berserker: {
    description: "Charges in with melee and keeps swinging even when hurt.", kind: "behaviour", halfLifeMs: 15 * MIN,
    score: (c) => {
      const def = c("dodged") + c("blocked") + c("parried");
      return (c("melee") / (c("melee") + def + 1)) * sat(c("melee"), 12) * (0.6 + 0.4 * sat(c("rage"), 2));
    },
  },
  hoarder: {
    description: "Sits on a pile of gold and rarely spends it.", kind: "behaviour", halfLifeMs: HOUR,
    score: (c, s, o) => sat(num(s.gold), o.richGold * 0.8) * (1 - sat(c("spent"), o.richGold * 0.3)),
  },
  big_spender: {
    description: "Spends freely.", kind: "behaviour", halfLifeMs: HOUR,
    score: (c, _s, o) => 0.7 * sat(c("spent"), o.richGold * 0.5) + 0.3 * sat(c("bought"), 5),
  },
  rich: {
    description: "Carries a lot of gold.", kind: "state", halfLifeMs: 0,
    score: (_c, s, o) => clamp01(num(s.gold) / Math.max(1, o.richGold)),
  },
  broke: {
    description: "Has (almost) no gold.", kind: "state", halfLifeMs: 0,
    score: (_c, s, o) => {
      if (typeof s.gold !== "number") return 0;
      if (s.gold <= o.brokeGold) return 1;
      return clamp01(1 - (s.gold - o.brokeGold) / Math.max(1, o.brokeGold * 3 + 30));
    },
  },
  pacifist: {
    description: "Gets through the game without fighting.", kind: "behaviour", halfLifeMs: HOUR,
    score: (c) => sat(c("noncombat"), 25) * Math.exp(-(c("kill") + c("hit") * 0.25) / 1.5),
  },
  murderer: {
    description: "Kills NPCs and civilians.", kind: "behaviour", halfLifeMs: 3 * HOUR,
    score: (c) => sat(c("npcKill"), 1.5),
  },
  thief: {
    description: "Steals.", kind: "behaviour", halfLifeMs: 3 * HOUR,
    score: (c) => sat(c("stole"), 1.5),
  },
  explorer: {
    description: "Goes everywhere, finds everything.", kind: "behaviour", halfLifeMs: HOUR,
    score: (c) => sat(c("explore") + c("zoneNew") * 1.5, 6),
  },
  speedrunner: {
    description: "Rushes objectives.", kind: "behaviour", halfLifeMs: HOUR,
    score: (c) => sat(c("questFast"), 1.5) * (1 - 0.5 * sat(c("explore"), 6)),
  },
  chatterbox: {
    description: "Talks to everyone, a lot.", kind: "behaviour", halfLifeMs: 30 * MIN,
    score: (c) => sat(c("said") + c("talked") * 0.5, 8),
  },
  liar: {
    description: "Lies to NPCs.", kind: "behaviour", halfLifeMs: 3 * HOUR,
    score: (c) => sat(c("lied"), 2),
  },
  feared: {
    description: "People are afraid of the player.", kind: "behaviour", halfLifeMs: 3 * HOUR,
    score: (c) => sat(c("threatened") + c("npcKill") * 1.5 + c("kill") * 0.1 + c("boss") * 0.5, 4),
  },
  famous: {
    description: "Everyone has heard of the player.", kind: "behaviour", halfLifeMs: 6 * HOUR,
    score: (c) => sat(c("boss") * 2 + c("questDone") + c("moment") * 0.5 + c("explore") * 0.1, 8),
  },
  beloved: {
    description: "Kind, generous and helpful; NPCs like the player.", kind: "behaviour", halfLifeMs: 3 * HOUR,
    score: (c) => sat(c("gave") + c("helped") * 1.5 + c("questDone") * 0.5, 5) * (1 - sat(c("npcKill") + c("stole") * 0.5 + c("threatened") * 0.5, 2)),
  },
};
export const BUILTIN_TRAIT_NAMES = Object.keys(BUILTIN_TRAITS);

const RANGED_WEAPONS = /bow|crossbow|gun|rifle|pistol|cannon|sling|thrown|javelin|staff|wand|focus|tome|spell|blaster/i;
const CIVILIAN_TYPES = new Set(["npc", "civilian", "villager", "townsperson", "merchant", "vendor", "guard", "child", "student", "porter", "ally", "friendly"]);

/** Context the projection gives the counter updater. */
export interface UpdateEnv {
  options: ObserverOptions;
  /** Persona ids from the manifest (killing / harming them counts as NPC harm). */
  personas: ReadonlySet<string>;
}

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/**
 * Update counters + stats for one player signal. Returns a short human-readable evidence string for the event
 * (used as trait evidence) or null when the event is irrelevant to traits.
 */
export function updateForEvent(
  acc: ObserverAcc,
  stats: Record<string, number | string | boolean>,
  ev: StoredEvent,
  env: UpdateEnv,
): string | null {
  const t = Math.max(acc.t, ev.ts);
  acc.t = t;
  const d = ev.data as Record<string, unknown>;
  const inc = (k: string, by = 1) => (stats[k] = num(stats[k]) + by);
  const ns = ev.type.split(".")[0];
  if (ns !== "combat") bump(acc, "noncombat", t);
  switch (ev.type) {
    case "combat.hit": {
      const range = num(d.range, 0);
      const ranged = range >= env.options.rangedDistance || RANGED_WEAPONS.test(str(d.weapon));
      bump(acc, "hit", t);
      bump(acc, ranged ? "ranged" : "melee", t);
      bump(acc, "dmgOut", t, Math.max(0, num(d.damage)));
      if (!ranged && num(stats.hp, 1) < 0.35) bump(acc, "rage", t);
      inc("hits");
      const target = str(d.target);
      if (env.personas.has(target)) inc(`harmed:${target}`);
      return `hit ${str(d.target_type) || target || "a target"}${d.weapon ? ` with ${str(d.weapon)}` : ""}${ranged ? " from range" : ""}`;
    }
    case "combat.hurt": {
      const hp = num(d.hp, num(stats.hp, 1));
      stats.hp = Math.round(hp * 1000) / 1000;
      bump(acc, "hurt", t);
      if (hp < 0.3) bump(acc, "lowhp", t);
      return `took ${Math.round(num(d.damage))} damage from ${str(d.source_type) || str(d.source) || "something"} (hp ${Math.round(hp * 100)}%)`;
    }
    case "combat.dodged": bump(acc, "dodged", t); inc("dodges"); return `dodged ${str(d.attack) || "an attack"}${d.source ? ` from ${str(d.source)}` : ""}`;
    case "combat.blocked": bump(acc, "blocked", t); inc("blocks"); return `blocked ${str(d.attack) || "an attack"}`;
    case "combat.parried": bump(acc, "parried", t); inc("parries"); return `parried ${str(d.attack) || "an attack"}`;
    case "combat.ability_used": bump(acc, "ability", t); return `used ${str(d.ability) || "an ability"}`;
    case "combat.killed": {
      const type = str(d.target_type) || "enemy";
      const target = str(d.target);
      bump(acc, "kill", t);
      inc("kills");
      inc(`kills:${type}`);
      if (d.boss === true) { bump(acc, "boss", t); inc("bosses"); }
      if (CIVILIAN_TYPES.has(type.toLowerCase()) || env.personas.has(target)) { bump(acc, "npcKill", t); inc("npc_kills"); }
      return `killed ${d.boss === true ? "the boss " : d.elite === true ? "an elite " : ""}${type}${target && target !== type ? ` (${target})` : ""}`;
    }
    case "combat.died": bump(acc, "died", t); inc("deaths"); stats.hp = 0; return `died${d.killer ? ` to ${str(d.killer_type) || str(d.killer)}` : ""}`;
    case "movement.fled": bump(acc, "fled", t); inc("fled"); return `fled${d.from ? ` from ${str(d.from)}` : ""}`;
    case "economy.gold": {
      const amount = num(d.amount, num(stats.gold));
      const delta = typeof d.delta === "number" ? d.delta : amount - num(stats.gold, amount);
      stats.gold = amount;
      if (delta > 0) bump(acc, "earned", t, delta);
      return delta > 0 ? `gold rose to ${Math.round(amount)}` : `gold fell to ${Math.round(amount)}`;
    }
    case "economy.bought": {
      const price = Math.max(0, num(d.price));
      bump(acc, "bought", t);
      bump(acc, "spent", t, price);
      inc("purchases");
      inc("spent_total", price);
      return `bought ${str(d.item) || "something"} for ${Math.round(price)}`;
    }
    case "economy.sold": bump(acc, "sold", t); inc("sales"); return `sold ${str(d.item) || "something"} for ${Math.round(num(d.price))}`;
    case "economy.stole": bump(acc, "stole", t); inc("thefts"); return `stole ${str(d.item) || "from"} ${str(d.from)}${d.seen === true ? " (seen)" : ""}`.trim();
    case "social.said": bump(acc, "said", t); inc("lines"); return `said "${str(d.text).slice(0, 40)}"`;
    case "social.talked_to": bump(acc, "talked", t); inc("conversations"); stats.last_npc = str(d.npc); return `talked to ${str(d.npc)}`;
    case "social.gave": bump(acc, "gave", t); inc("gifts"); return `gave ${str(d.item) || (d.gold ? `${num(d.gold)} gold` : "a gift")} to ${str(d.to)}`;
    case "social.lied": bump(acc, "lied", t); inc("lies"); return `lied to ${str(d.to)}${d.about ? ` about ${str(d.about)}` : ""}`;
    // R1: a claim the game knows is false counts as a lie; fleeing a fight via combat.fled counts like movement.fled
    case "social.claim": if (d.truth !== false) return null; bump(acc, "lied", t); inc("lies"); return `lied to ${str(d.to)}: "${str(d.text).slice(0, 40)}"`;
    case "combat.fled": bump(acc, "fled", t); inc("fled"); return `fled${d.from ? ` from ${str(d.from)}` : ""}`;
    case "social.threatened": bump(acc, "threatened", t); inc("threats"); return `threatened ${str(d.target)}`;
    case "movement.entered_zone": {
      const zone = str(d.zone);
      if (zone) {
        stats.zone = zone;
        if (!acc.zones.includes(zone)) {
          acc.zones.push(zone);
          if (acc.zones.length > 64) acc.zones.shift();
          bump(acc, "zoneNew", t);
          stats.zones_visited = acc.zones.length;
          return `entered ${zone} for the first time`;
        }
      }
      return null;
    }
    case "movement.explored": bump(acc, "explore", t); inc("discoveries"); return `discovered ${str(d.discovery) || str(d.zone) || "something new"}`;
    case "gear.equipped": {
      const slot = str(d.slot) || "slot";
      bump(acc, "equip", t);
      stats[`gear:${slot}`] = str(d.name) || str(d.item);
      const tags = Array.isArray(d.tags) ? d.tags.map(str).filter(Boolean) : [];
      if (tags.length) stats[`tags:${slot}`] = tags.join(","); else delete stats[`tags:${slot}`];
      if (typeof d.value === "number") stats[`value:${slot}`] = d.value;
      return null;
    }
    case "gear.unequipped": {
      const slot = str(d.slot) || "slot";
      delete stats[`gear:${slot}`];
      delete stats[`tags:${slot}`];
      delete stats[`value:${slot}`];
      return null;
    }
    case "quest.accepted": {
      const q = str(d.quest);
      if (q) {
        acc.quests[q] = t;
        const keys = Object.keys(acc.quests);
        if (keys.length > 20) delete acc.quests[keys[0]];
      }
      inc("quests_accepted");
      return null;
    }
    case "quest.completed": {
      const q = str(d.quest);
      bump(acc, "questDone", t);
      inc("quests_completed");
      const started = acc.quests[q];
      delete acc.quests[q];
      if (started && t - started <= env.options.speedQuestSec * 1000) {
        bump(acc, "questFast", t);
        return `finished ${q} in ${Math.round((t - started) / 1000)}s`;
      }
      return `completed ${q || "a quest"}`;
    }
    case "quest.failed": inc("quests_failed"); delete acc.quests[str(d.quest)]; return null;
    case "world.helped": bump(acc, "helped", t); inc("helped"); return `helped ${str(d.npc)}${d.how ? ` (${str(d.how)})` : ""}`;
    case "world.destroyed": inc("destroyed"); return `destroyed ${str(d.object)}`;
    case "world.time":
      if (typeof d.hour === "number") stats.hour = d.hour;
      if (typeof d.phase === "string") stats.phase = d.phase;
      if (typeof d.day === "number") stats.day = d.day;
      return null;
    default:
      return null;
  }
}

/** Evaluate every built-in trait at time t. */
export function scoreBuiltins(acc: ObserverAcc, stats: Record<string, number | string | boolean>, o: ObserverOptions, t: number): Record<string, number> {
  const get = (c: CounterName) => counterAt(acc, c, t);
  const out: Record<string, number> = {};
  for (const [name, info] of Object.entries(BUILTIN_TRAITS)) out[name] = Math.round(clamp01(info.score(get, stats, o)) * 1000) / 1000;
  return out;
}

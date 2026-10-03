// What the Director reads about a player: combat habits (MoveHabits) merged from three sources - the game's own
// numbers (ask params), the Observer's traits (K1 player model: dodger, turtle, ranged_camper, berserker ...) and the
// player's recent combat signals - plus active habit / trait labels, gear tags and the favourite element.
import { cleanHabits, type MoveHabits, type StoredEvent } from "@liveforge/protocol";
import type { ScopedContext } from "../../module.js";
import { gearTags, traitAt } from "../observer/view.js";

export interface PlayerRead {
  habits: MoveHabits;
  /** Habit / trait labels in force (dodger, turtle, ranged_camper, range_long, stationary ...), strongest first. */
  labels: string[];
  /** Tags of the player's current gear (lower-case). */
  gear: string[];
  /** Manifest element the player deals most damage with (null = none / physical). */
  topElement: string | null;
  /** Short human evidence for the `why`. */
  evidence: string[];
  /** Trait scores (0-1) from the Observer, when available. */
  traits: Record<string, number>;
}

const WINDOW_MS = 2 * 60_000;

/** The Observer's player model (null when the Observer is disabled or has not seen the player). */
function playerModel(ctx: ScopedContext, player: string | null) {
  if (!player) return null;
  try {
    return ctx.projections.get("observer.player_model", { world: ctx.world, player }) ?? null;
  } catch {
    return null;
  }
}

/** Observer trait scores decayed to now (K1 view.traitAt); empty without an Observer model. */
export function traitScores(ctx: ScopedContext, player: string | null): Record<string, number> {
  const pm = playerModel(ctx, player);
  if (!pm) return {};
  const now = ctx.now();
  const out: Record<string, number> = {};
  for (const k of Object.keys(pm.traits ?? {})) out[k] = traitAt(pm, k, now, ctx.manifest);
  return out;
}

const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Habits from the player's combat signals in the last two minutes (Observer-independent fallback). */
function fromEvents(evs: StoredEvent[], now: number): { h: Record<string, unknown>; evidence: string[]; elementDamage: Record<string, number> } {
  const minutes = Math.max(0.5, Math.min(2, (now - (evs[0]?.ts ?? now)) / 60_000));
  let dodges = 0, left = 0, right = 0, blocks = 0, hurt = 0, hits = 0, jumps = 0, deaths = 0, still = 0, cover = 0;
  let close = 0, mid = 0, long = 0, hp = 1;
  const elementDamage: Record<string, number> = {};
  for (const e of evs) {
    const d = e.data;
    switch (e.type) {
      case "combat.dodged": {
        dodges++;
        const dir = String(d.direction ?? "").toLowerCase();
        if (dir.includes("left")) left++;
        else if (dir.includes("right")) right++;
        break;
      }
      case "combat.blocked": case "combat.parried": blocks++; break;
      case "combat.hurt": hurt++; hp = num(d.hp, hp); break;
      case "combat.died": deaths++; break;
      case "combat.hit": {
        hits++;
        const r = num(d.range, -1);
        if (r >= 0) { if (r < 3) close++; else if (r < 10) mid++; else long++; }
        const el = typeof d.element === "string" ? d.element.toLowerCase() : "";
        if (el) elementDamage[el] = (elementDamage[el] ?? 0) + Math.max(1, num(d.damage, 1));
        break;
      }
      case "movement.jumped": jumps++; break;
      case "movement.idle": still++; break;
      case "movement.cover": cover++; break;
    }
  }
  const ranged = close + mid + long;
  const h: Record<string, unknown> = {
    dodgeRate: dodges / minutes,
    dodgeLeft: left + right > 0 ? left / (left + right) : 0.5,
    blockRate: blocks + hurt > 0 ? blocks / (blocks + hurt) : 0,
    jumpRate: jumps / minutes,
    spam: hits / (minutes * 60),
    playerHp: hp,
    deaths,
    stationary: Math.min(1, still / 10),
    coverShare: Math.min(1, cover / 10),
    ...(ranged > 0 ? { range: { close: close / ranged, mid: mid / ranged, long: long / ranged } } : {}),
  };
  const evidence: string[] = [];
  if (dodges >= 3) evidence.push(`${dodges} dodges${left + right > 2 ? ` (${Math.round((left / Math.max(1, left + right)) * 100)}% left)` : ""}`);
  if (blocks >= 3) evidence.push(`${blocks} blocks`);
  if (ranged >= 4 && long / ranged > 0.5) evidence.push(`${Math.round((long / ranged) * 100)}% hits from range`);
  if (ranged >= 4 && close / ranged > 0.5) evidence.push(`${Math.round((close / ranged) * 100)}% hits up close`);
  if (deaths) evidence.push(`${deaths} deaths`);
  return { h, evidence, elementDamage };
}

/** Merge order: signal-derived < Observer traits (max) < the game's explicit habits (override). */
export function readPlayer(ctx: ScopedContext, player: string | null, explicit: Record<string, unknown> | undefined, gearParam?: string[]): PlayerRead {
  const now = ctx.now();
  const evs = player ? ctx.events({ world: ctx.world, player, type: "combat.*", since: now - WINDOW_MS, limit: 500 }) : [];
  const moves = player ? ctx.events({ world: ctx.world, player, type: "movement.*", since: now - WINDOW_MS, limit: 200 }) : [];
  const { h, evidence, elementDamage } = fromEvents([...evs, ...moves].sort((a, b) => a.ts - b.ts), now);
  const traits = traitScores(ctx, player);
  const t = (k: string) => traits[k] ?? 0;
  // traits raise habits (they summarise a longer window than the 2-minute signal read)
  const range = (h.range as MoveHabits["range"] | undefined) ?? { close: 0.33, mid: 0.34, long: 0.33 };
  if (t("ranged_camper") > 0) range.long = Math.max(range.long, t("ranged_camper"));
  if (t("berserker") > 0) range.close = Math.max(range.close, t("berserker"));
  const merged: Record<string, unknown> = {
    ...h,
    range,
    dodgeRate: Math.max(num(h.dodgeRate), t("dodger") * 10),
    blockRate: Math.max(num(h.blockRate), t("turtle") * 0.8),
    spam: Math.max(num(h.spam), t("berserker") * 1.5),
    ...(explicit ?? {}),
  };
  if (explicit?.range && typeof explicit.range === "object") merged.range = { ...range, ...(explicit.range as object) };
  const habits = cleanHabits(merged);

  const labels: Array<[string, number]> = [];
  for (const [k, v] of Object.entries(traits)) if (v >= 0.5) labels.push([k, v]);
  const side = Math.abs(habits.dodgeLeft - 0.5) * 2 * Math.min(1, habits.dodgeRate / 6);
  const derived: Array<[string, number]> = [
    ["range_long", habits.range.long], ["range_close", habits.range.close], ["dodger", Math.min(1, habits.dodgeRate / 8)],
    [habits.dodgeLeft > 0.5 ? "dodges_left" : "dodges_right", side], ["turtle", habits.blockRate], ["stationary", habits.stationary],
    ["jumper", Math.min(1, habits.jumpRate / 10)], ["masher", Math.min(1, habits.spam / 1.5)], ["cover", habits.coverShare],
  ];
  for (const [k, v] of derived) if (v >= 0.5 && !labels.some(([x]) => x === k)) labels.push([k, v]);
  labels.sort((a, b) => b[1] - a[1]);

  // gear: the game's list, else the Observer's equipped gear tags, else tags from recent gear.equipped signals
  let gear = (gearParam ?? []).map((g) => g.toLowerCase());
  if (!gear.length) {
    const pm = playerModel(ctx, player);
    if (pm) gear = gearTags(pm).map((g) => g.toLowerCase());
  }
  if (!gear.length && player) {
    const eq = ctx.events({ world: ctx.world, player, type: "gear.equipped", limit: 10, desc: true });
    const set = new Set<string>();
    for (const e of eq) for (const tag of Array.isArray(e.data.tags) ? e.data.tags : []) if (typeof tag === "string") set.add(tag.toLowerCase());
    gear = [...set];
  }

  // favourite element: damage by element, else an element named in the gear tags
  const elements = ctx.manifest.elements;
  let topElement: string | null = null;
  let best = 0;
  for (const [el, dmg] of Object.entries(elementDamage)) {
    const m = elements.find((e) => e.toLowerCase() === el);
    if (m && dmg > best && !/^(physical|none|neutral)$/i.test(m)) { best = dmg; topElement = m; }
  }
  if (!topElement) topElement = elements.find((e) => gear.includes(e.toLowerCase()) && !/^(physical|none|neutral)$/i.test(e)) ?? null;
  if (topElement) evidence.push(`favours ${topElement}`);
  for (const [k, v] of Object.entries(traits)) if (v >= 0.6 && evidence.length < 5) evidence.push(`trait ${k} ${v.toFixed(2)}`);

  return { habits, labels: labels.map(([k]) => k), gear, topElement, evidence: evidence.slice(0, 5), traits };
}

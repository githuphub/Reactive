// Monsters & squads (spec §3.4): tactic assignment per unit (flank, kite, ambush, shield_wall, focus_healer, rush,
// hold, surround, retreat - or the game's own list) and counter elite modifiers chosen from the manifest list
// (director options eliteModifiers) against the player's habits, traits, gear tags and favourite element.
import { cleanText, hashString, mulberry32, type AskParams, type AskResult } from "@liveforge/protocol";
import type { AskContext } from "../../module.js";
import { readPlayer, type PlayerRead } from "./habits.js";
import { currentAggression } from "./difficulty.js";
import { directorOptions, type EliteModifier } from "./options.js";

type Unit = AskParams<"director.encounter">["units"][number];

/** Unit role from its type id ("goblin_archer" -> ranged). */
function unitRole(type: string): "ranged" | "tank" | "skirmisher" | "support" | "melee" {
  const t = type.toLowerCase();
  if (/heal|priest|cleric|medic|shaman|druid|support|bard/.test(t)) return "support";
  if (/arch|ranger|gun|mage|caster|sniper|crossbow|wizard|warlock|sorcer|thrower|slinger|turret|spitter/.test(t)) return "ranged";
  if (/knight|guard|shield|tank|brute|golem|paladin|warden|ogre|troll|juggernaut/.test(t)) return "tank";
  if (/rogue|assassin|thief|scout|wolf|hound|cat|ninja|bat|raptor|stalker|skirmish/.test(t)) return "skirmisher";
  return "melee";
}

/** Preferred tactics per role, then per the player's strongest habit (first one present in the game's list wins). */
const ROLE_TACTICS: Record<ReturnType<typeof unitRole>, string[]> = {
  ranged: ["kite", "hold", "ambush"], tank: ["shield_wall", "hold", "rush"], skirmisher: ["flank", "ambush", "surround"],
  support: ["hold", "retreat", "kite"], melee: ["rush", "surround", "flank"],
};
const HABIT_TACTICS: Record<string, Partial<Record<ReturnType<typeof unitRole>, string[]>>> = {
  range_long: { melee: ["rush", "flank"], skirmisher: ["flank", "ambush"], tank: ["rush", "shield_wall"], ranged: ["ambush", "kite"] },
  ranged_camper: { melee: ["rush", "flank"], skirmisher: ["flank", "ambush"], tank: ["rush"], ranged: ["ambush"] },
  turtle: { melee: ["surround", "flank"], skirmisher: ["flank"], ranged: ["kite"], tank: ["hold"] },
  range_close: { ranged: ["kite"], tank: ["shield_wall"], melee: ["hold", "surround"], skirmisher: ["flank"] },
  berserker: { ranged: ["kite"], tank: ["shield_wall"], melee: ["hold"], skirmisher: ["ambush"] },
  dodger: { melee: ["surround"], ranged: ["kite", "hold"], skirmisher: ["surround", "flank"] },
  stationary: { ranged: ["hold"], melee: ["surround"], skirmisher: ["flank"] },
  glass_cannon: { melee: ["rush"], skirmisher: ["flank", "rush"] },
};

/** Elite modifiers that counter what the player relies on (best matches first). */
export function counterModifiers(mods: EliteModifier[], read: PlayerRead, seed: number, n: number): { id: string; reason: string }[] {
  if (n <= 0 || !mods.length) return [];
  const have = new Set([...read.labels, ...read.gear, ...(read.topElement ? [read.topElement.toLowerCase()] : [])].map((x) => x.toLowerCase()));
  const scored = mods.map((m, i) => {
    const hits = m.counters.filter((c) => have.has(c.toLowerCase()));
    const rank = hits.reduce((a, h) => a + Math.max(0.2, 1 - read.labels.indexOf(h) * 0.15), 0);
    return { m, hits, score: rank + ((hashString(`${seed}|${m.id}`) % 100) / 1000) - i * 1e-4 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n).map((s) => ({ id: s.m.id, reason: s.hits.length ? `vs ${s.hits.join(", ")}` : "variety" }));
}

/** Keyless encounter plan. */
export function encounterRules(ctx: AskContext, p: AskParams<"director.encounter">): { result: AskResult<"director.encounter">; why: string } {
  const opts = directorOptions(ctx.manifest, ctx.options);
  const read = readPlayer(ctx, ctx.player, p.habits);
  const tactics = opts.tactics;
  const seed = typeof p.seed === "number" ? p.seed >>> 0 : hashString(JSON.stringify([p.units.map((u) => u.type), read.labels, ctx.player]));
  const rng = mulberry32(seed);
  const top = read.labels.find((l) => HABIT_TACTICS[l]);
  const assignments = p.units.map((u: Unit, i) => {
    const role = unitRole(u.type);
    const wanted = [...(top ? HABIT_TACTICS[top][role] ?? [] : []), ...ROLE_TACTICS[role]];
    let tactic = wanted.find((t) => tactics.includes(t)) ?? tactics[Math.floor(rng() * tactics.length) % tactics.length];
    // a squad of 4+ never commits everyone to the same tactic: every 4th unit takes the next option
    if (p.units.length >= 4 && i % 4 === 3) tactic = wanted.filter((t) => tactics.includes(t))[1] ?? tactic;
    return { unit: u.id, tactic, target: "player" };
  });
  const elites = p.units.filter((u) => u.elite).length;
  const modifiers = counterModifiers(opts.eliteModifiers, read, seed, Math.min(3, Math.max(elites ? 1 : 0, Math.ceil(elites / 2))));
  const aggression = currentAggression(ctx);
  const counts: Record<string, number> = {};
  for (const a of assignments) counts[a.tactic] = (counts[a.tactic] ?? 0) + 1;
  const why = [
    top ? `player ${top}` : "no strong habit",
    Object.entries(counts).map(([t, n]) => `${n}x ${t}`).join(", "),
    modifiers.length ? `elites: ${modifiers.map((m) => `${m.id} (${m.reason})`).join(", ")}` : "",
  ].filter(Boolean).join(" | ");
  return { result: { assignments, modifiers: modifiers.map((m) => m.id), aggression }, why };
}

/** Structured schema for the AI encounter upgrade. */
export function encounterSchema(tactics: string[], mods: string[], unitIds: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      why: { type: "string" },
      assignments: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          properties: { unit: { type: "string", enum: unitIds }, tactic: { type: "string", enum: tactics } },
          required: ["unit", "tactic"],
        },
      },
      modifiers: { type: "array", items: mods.length ? { type: "string", enum: mods } : { type: "string" } },
    },
    required: ["why", "assignments", "modifiers"],
  };
}

/** AI encounter: one call re-assigning tactics / modifiers; clamped to the unit ids, tactic + modifier lists. */
export async function encounterAi(ctx: AskContext, p: AskParams<"director.encounter">, instant: AskResult<"director.encounter">): Promise<{ result: AskResult<"director.encounter">; why: string } | null> {
  if (!ctx.llm) return null;
  const opts = directorOptions(ctx.manifest, ctx.options);
  const read = readPlayer(ctx, ctx.player, p.habits);
  const ids = p.units.map((u) => u.id);
  const mods = opts.eliteModifiers.map((m) => m.id);
  const system = `You are the Director of "${ctx.manifest.game.name}". Assign a squad tactic to every unit so the squad counters how this player fights, and pick elite modifiers (only for elite units) that counter the player. Tactics: ${opts.tactics.join(", ")}. Elite modifiers: ${opts.eliteModifiers.map((m) => `${m.id}${m.description ? ` (${m.description})` : ""}`).join("; ")}. Tone: ${ctx.manifest.lore.tone}. The user message is JSON {units, read, habits, gear, zone}. why: one short sentence (max 160 chars). Output only the JSON object.`;
  let raw: unknown;
  try {
    raw = (await ctx.llm.json(encounterSchema(opts.tactics, mods, ids), system, JSON.stringify({ units: p.units, read: read.labels, habits: read.habits, gear: read.gear, zone: p.zone ?? null }), { tier: "fast", maxTokens: 500, signal: ctx.signal, task: ctx.kind })).value;
  } catch (e) {
    ctx.log.debug("encounter llm failed", { error: e instanceof Error ? e.message : String(e) });
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const byUnit = new Map<string, string>();
  for (const a of Array.isArray(o.assignments) ? o.assignments : []) {
    const r = a as Record<string, unknown>;
    if (ids.includes(String(r.unit)) && opts.tactics.includes(String(r.tactic))) byUnit.set(String(r.unit), String(r.tactic));
  }
  const assignments = instant.assignments.map((a) => ({ ...a, tactic: byUnit.get(a.unit) ?? a.tactic }));
  const elites = p.units.filter((u) => u.elite).length;
  const modifiers = (Array.isArray(o.modifiers) ? o.modifiers : []).map(String).filter((m) => mods.includes(m)).slice(0, Math.max(instant.modifiers.length, elites ? 1 : 0, 0));
  const why = cleanText(o.why, 200) || "AI squad plan";
  return { result: { assignments, modifiers: elites ? (modifiers.length ? [...new Set(modifiers)] : instant.modifiers) : [], aggression: instant.aggression }, why };
}

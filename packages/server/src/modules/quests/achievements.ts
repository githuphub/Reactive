// Achievements: designer achievements from the manifest plus personal ones generated from the player's style
// (title, description, icon glyph + colour + VFX burst, DSL condition). Evaluated continuously; unlocking records
// lf.quests.achievement and pushes an `achievement.unlocked` directive. Personal titles are optionally re-worded by
// a fast-tier LLM call (budgeted); the condition always stays the rules one.
import { clampVfx, type Achievement } from "@liveforge/protocol";
import type { ModuleContext, ScopedContext, TickContext } from "../../module.js";
import { evalWith, makeDslEnv, type HostDslEnv } from "../world/dsl.js";
import { clip, loreSystem, moderateOut, numOr, opt, scopeFor, shortId, titleCase } from "../world/util.js";
import { questLog } from "./log.js";

type Rarity = Achievement["rarity"];

/** A burst of sparks in the achievement colour (engine-neutral VFX recipe). */
export function glyphVfx(color: string) {
  return clampVfx({
    v: 1, name: "achievement_burst", duration: 2,
    emitters: [{
      shape: "ring", radius: 0.4, rate: 0, burst: 48, maxParticles: 64, lifetime: [0.6, 1.2],
      velocity: { dir: [0, 1, 0], speed: [0.6, 1.6], spread: 0.6 }, gravity: -0.4,
      colorRamp: [{ t: 0, color, alpha: 1 }, { t: 1, color, alpha: 0 }], sizeCurve: [{ t: 0, size: 0.07 }, { t: 1, size: 0 }],
      sprite: "spark", blend: "additive",
    }],
    tags: ["achievement"],
  }, color) ?? undefined;
}

/** Designer achievements (manifest `achievements`) as wire Achievements. */
export function designerAchievements(m: ModuleContext["manifest"]): Achievement[] {
  return m.achievements.map((a) => ({
    id: a.id, title: a.title, description: a.description, icon: { glyph: a.glyph ?? "star" }, condition: a.condition, rarity: a.rarity, personal: false,
  }));
}

/** Per-trait templates: the bar is set a bit above what the player already does. */
interface StyleTemplate {
  title: string;
  description: (n: number) => string;
  condition: (n: number) => string;
  /** Current value of the measured quantity (so the goal stretches it). */
  measure?: string;
  base: number;
  glyph: string;
  color: string;
}

const T = (title: string, glyph: string, color: string, base: number, measure: string | undefined, condition: (n: number) => string, description: (n: number) => string): StyleTemplate =>
  ({ title, glyph, color, base, measure, condition, description });

export const STYLE_TEMPLATES: Record<string, StyleTemplate> = {
  dodger: T("Untouchable", "feather", "#7fd3ff", 20, "count(combat.dodged, 2m)", (n) => `count(combat.dodged, 2m) >= ${n}`, (n) => `Dodge ${n} attacks within two minutes.`),
  turtle: T("Immovable", "shield", "#9fb4c7", 15, "count(combat.blocked, 2m)", (n) => `count(combat.blocked, 2m) >= ${n}`, (n) => `Block ${n} attacks within two minutes.`),
  glass_cannon: T("All or Nothing", "flame", "#ff6a3d", 5, "count(combat.killed, 1m)", (n) => `count(combat.killed, 1m) >= ${n} & count(combat.hurt, 1m) == 0`, (n) => `Defeat ${n} enemies in a minute without getting hurt.`),
  ranged_camper: T("Eagle Eye", "bow", "#c7e86b", 25, "count(combat.hit, 2m)", (n) => `count(combat.hit, 2m) >= ${n} & avg(combat.hit.range, 2m) > 8`, (n) => `Land ${n} hits from range within two minutes.`),
  berserker: T("Red Mist", "axe", "#e0313a", 6, "count(combat.killed, 1m)", (n) => `count(combat.killed, 1m) >= ${n}`, (n) => `Defeat ${n} enemies within a minute.`),
  hoarder: T("Dragon's Hoard", "coin", "#ffd23f", 1000, "stat(gold)", (n) => `stat(gold) >= ${n}`, (n) => `Hold ${n} gold at once.`),
  big_spender: T("Patron", "coin", "#ffb000", 800, "sum(economy.bought.price, 10m)", (n) => `sum(economy.bought.price, 10m) >= ${n}`, (n) => `Spend ${n} gold within ten minutes.`),
  rich: T("Gilded", "crown", "#ffe066", 1500, "stat(gold)", (n) => `stat(gold) >= ${n}`, (n) => `Amass ${n} gold.`),
  pacifist: T("Gentle Soul", "dove", "#bfe9ff", 6, "count(social.talked_to, 30m)", (n) => `count(social.talked_to, 30m) >= ${n} & count(combat.killed, 30m) == 0`, (n) => `Talk your way through ${n} conversations without a single kill.`),
  murderer: T("Body Count", "skull", "#8b0000", 20, "count(combat.killed, 10m)", (n) => `count(combat.killed, 10m) >= ${n}`, (n) => `Defeat ${n} foes within ten minutes.`),
  thief: T("Light Fingers", "hand", "#a07cff", 5, "count(economy.stole, 30m)", (n) => `count(economy.stole, 30m) >= ${n}`, (n) => `Pocket ${n} things that aren't yours in half an hour.`),
  explorer: T("Cartographer", "compass", "#5ad19a", 4, "distinct(movement.entered_zone.zone, 1h)", (n) => `distinct(movement.entered_zone.zone, 1h) >= ${n}`, (n) => `Visit ${n} different places within an hour.`),
  speedrunner: T("Blink and Miss It", "bolt", "#fff36b", 6, "count(movement.entered_zone, 5m)", (n) => `count(movement.entered_zone, 5m) >= ${n}`, (n) => `Pass through ${n} zones in five minutes.`),
  chatterbox: T("Silver Tongue", "speech", "#ffffff", 15, "count(social.said, 10m)", (n) => `count(social.said, 10m) >= ${n}`, (n) => `Say ${n} things in ten minutes.`),
  liar: T("Forked Tongue", "mask", "#7a5cff", 4, "count(social.lied, 30m)", (n) => `count(social.lied, 30m) >= ${n}`, (n) => `Tell ${n} lies in half an hour.`),
  feared: T("Dread", "skull", "#40304f", 0, undefined, () => "trait(feared) >= 0.9", () => "Become truly feared."),
  famous: T("Talk of the Town", "star", "#ffd700", 0, undefined, () => "trait(famous) >= 0.9", () => "Have everyone talking about you."),
  beloved: T("Heart of Gold", "heart", "#ff7aa8", 0, undefined, () => "trait(beloved) >= 0.9", () => "Be loved by all."),
};

const rarityFor = (stretch: number): Rarity => (stretch >= 2.5 ? "epic" : stretch >= 1.8 ? "rare" : stretch >= 1.3 ? "uncommon" : "common");

/** Generate personal achievements for strong traits that don't have one yet (rules). Returns the new ones. */
export function generatePersonal(ctx: ScopedContext, player: string, env?: HostDslEnv): Achievement[] {
  const log = questLog(ctx, ctx.world, player);
  const e = env ?? makeDslEnv(ctx, ctx.world, player);
  const traits = Object.keys(e.model.traits ?? {}).map((k) => [k, numOr(e.call("trait", [k]), 0)] as const).filter(([, v]) => v >= opt(ctx, "personalTraitMin", 0.6)).sort((a, b) => b[1] - a[1]);
  const have = new Set([...log.personal, ...log.achievements].map((a) => a.id));
  const max = opt(ctx, "maxPersonalPending", 6);
  const out: Achievement[] = [];
  for (const [trait, score] of traits) {
    if (log.personal.length + out.length >= max) break;
    const id = shortId(`pa_${trait.replace(/[^A-Za-z0-9_]/g, "_")}`.slice(0, 40), `${ctx.world}:${player}:${trait}`);
    if (have.has(id)) continue;
    const designer = ctx.manifest.traits[trait];
    const tpl = STYLE_TEMPLATES[trait];
    let a: Achievement;
    if (tpl) {
      let n = tpl.base;
      if (tpl.measure) {
        const cur = Number(evalWith(e, tpl.measure).value) || 0;
        n = Math.max(tpl.base, Math.ceil(cur * 1.5));
      }
      const stretch = tpl.base ? n / tpl.base : 1 + score;
      a = { id, title: tpl.title, description: tpl.description(n), icon: { glyph: tpl.glyph, color: tpl.color, vfx: glyphVfx(tpl.color) }, condition: tpl.condition(n), rarity: rarityFor(stretch), personal: true };
    } else if (designer) {
      a = { id, title: `Master of ${titleCase(trait)}`, description: `Push your ${titleCase(trait).toLowerCase()} streak to the limit.`, icon: { glyph: "star", color: "#ffd23f", vfx: glyphVfx("#ffd23f") }, condition: `trait(${trait}) >= 0.95`, rarity: "rare", personal: true };
    } else continue;
    ctx.record("lf.quests.personal", { achievement: a, trait, source: "rules" }, { player });
    out.push(a);
  }
  return out;
}

const RENAME_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "Short, punchy achievement title (max 40 chars)." },
    description: { type: "string", description: "One sentence restating the goal in the game's tone (max 140 chars). Keep the numbers." },
    glyph: { type: "string", description: "One lowercase icon word (e.g. skull, coin, flame, feather, star)." },
  },
  required: ["title", "description", "glyph"],
};

/** Optional fast-tier re-wording of a generated achievement (condition unchanged). */
export async function flavourPersonal(ctx: ScopedContext, player: string, a: Achievement): Promise<void> {
  if (!ctx.llm || !ctx.budgets.check(player).ok || opt(ctx, "llmAchievements", true) === false) return;
  try {
    const res = await ctx.llm.json<{ title?: unknown; description?: unknown; glyph?: unknown }>(
      RENAME_SCHEMA,
      loreSystem(ctx.manifest, "You name personal achievements for one player, in the game's tone. Never change what the goal is."),
      `Achievement: ${a.title} — ${a.description}\nCondition (do not change): ${a.condition}`,
      { tier: "fast", maxTokens: 150, task: "quests.achievement", player },
    );
    const title = await moderateOut(ctx, res.value.title, 64);
    const description = await moderateOut(ctx, res.value.description, 200);
    const glyph = typeof res.value.glyph === "string" ? res.value.glyph.toLowerCase().replace(/[^a-z_]/g, "").slice(0, 32) : "";
    if (!title || !description) return;
    if (questLog(ctx, ctx.world, player).achievements.some((x) => x.id === a.id)) return;
    ctx.record("lf.quests.personal", { achievement: { ...a, title, description, icon: { ...a.icon, ...(glyph ? { glyph } : {}) } }, source: "ai" }, { player });
  } catch (e) {
    ctx.log.debug("achievement flavour skipped", { error: (e as Error).message });
  }
}

/** Evaluate every locked achievement (designer + personal); unlock + push directives. Returns the new unlocks. */
export function checkAchievements(ctx: ScopedContext, player: string, env?: HostDslEnv): Achievement[] {
  const log = questLog(ctx, ctx.world, player);
  const unlocked = new Set(log.achievements.map((a) => a.id));
  const e = env ?? makeDslEnv(ctx, ctx.world, player);
  const out: Achievement[] = [];
  const now = ctx.now();
  for (const a of [...designerAchievements(ctx.manifest), ...log.personal]) {
    if (unlocked.has(a.id)) continue;
    const r = evalWith(e, a.condition);
    if (!r.ok) continue;
    const won: Achievement = { ...a, unlockedAt: now };
    ctx.record("lf.quests.achievement", { achievement: won }, { player });
    ctx.emit({ kind: "achievement.unlocked", target: "ui", args: { achievement: won }, why: clip(`${a.title}: ${a.condition}`, 200) }, { player });
    unlocked.add(a.id);
    out.push(won);
  }
  return out;
}

/** Tick: generate personal achievements for active players, flavour them, and evaluate time-based conditions. */
export async function achievementTick(ctx: TickContext): Promise<void> {
  for (const player of ctx.activePlayers.slice(0, 100)) {
    const sc = scopeFor(ctx, ctx.world, player);
    const env = makeDslEnv(sc, ctx.world, player);
    const fresh = generatePersonal(sc, player, env);
    checkAchievements(sc, player, env);
    for (const a of fresh.slice(0, 1)) await flavourPersonal(sc, player, a);
  }
}

export const recentlyUnlocked = (ctx: Pick<ModuleContext, "projections" | "now">, world: string, player: string, withinMs = 10 * 60_000): Achievement[] =>
  questLog(ctx, world, player).achievements.filter((a) => (a.unlockedAt ?? 0) >= ctx.now() - withinMs);

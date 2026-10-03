// Forge service: the rules (instant) and AI (upgrade) producers for every forge ask kind, shared by the ask handlers
// and bake mode. Pure of HTTP; the AI path needs a ScopedLlm and always falls back to null (keep the rules answer).
import { cleanText, hashString, type AskParams, type AskResult, type ForgedItem } from "@liveforge/protocol";
import type { Logger } from "../../log.js";
import type { ScopedLlm } from "../../module.js";
import type { Moderator } from "../../core/moderation.js";
import type { ForgeEnv } from "./env.js";
import {
  armourSlots, forgeArmourSetRules, forgeItemRules, forgeLootRules, itemFromLlm, resolveElement, setBonusFor,
  type LootContext,
} from "./items.js";
import { creatureFromLlm, forgeCreatureRules, forgePropRules, propFromLlm, type CreatureRole } from "./creatures.js";
import { accessories, forgeLookRules, lookFromLlm } from "./variants.js";
import { buildVfx, vfxFromStyle, vfxIntent } from "./vfx.js";
import {
  armourSetJsonSchema, creatureJsonSchema, forgeSystem, itemJsonSchema, lootJsonSchema, MAX_TOKENS, npcLookJsonSchema,
  propJsonSchema, vfxJsonSchema, type ForgeTask,
} from "./llm.js";
import { lookJsonSchema } from "./variants.js";
import { clampStats, rarityIndexOf, slotKind } from "./schema.js";
import { clampN, finOr, isObj } from "./model.js";

export type ForgeKind = "forge.item" | "forge.armour_set" | "forge.look" | "forge.vfx" | "forge.creature" | "forge.npc_look" | "forge.prop" | "forge.loot";
export const FORGE_KINDS: readonly ForgeKind[] = ["forge.item", "forge.armour_set", "forge.look", "forge.vfx", "forge.creature", "forge.npc_look", "forge.prop", "forge.loot"];

/** Extra context the ask handler resolves (loot fight context, NPC persona). */
export interface ForgeExtras {
  loot?: LootContext;
  /** forge.npc_look: the persona card (name, role, personality) and its asset. */
  persona?: { name: string; role: string; personality: string; asset?: string };
}

export interface Produced<K extends ForgeKind> { result: AskResult<K>; why: string }

/** A deterministic seed for a request: the client's, else a hash of the params. */
export const seedFor = (seed: number | undefined, material: unknown): number =>
  typeof seed === "number" && Number.isFinite(seed) ? seed >>> 0 : hashString(JSON.stringify(material ?? null));

/** Text describing an item request when the client sent no prompt (context-driven forging). */
function contextPrompt(p: AskParams<"forge.item">): string {
  const c = isObj(p.context) ? p.context : {};
  const bits = [c.theme, c.enemy, c.zone, c.moment, p.element, p.family ?? p.slot].filter((v): v is string => typeof v === "string" && !!v.trim());
  return bits.join(" ").replace(/[_-]+/g, " ").trim();
}

// ------------------------------------------------------------------------------------------------ rules

/** Keyless producer for any forge kind. */
export function produceRules<K extends ForgeKind>(kind: K, env: ForgeEnv, params: AskParams<K>, extras: ForgeExtras = {}): Produced<K> {
  const p = params as Record<string, unknown>;
  const seed = seedFor(p.seed as number | undefined, { kind, ...p, seed: undefined });
  switch (kind) {
    case "forge.item": {
      const q = params as AskParams<"forge.item">;
      const prompt = (q.prompt ?? "").trim() || contextPrompt(q);
      const item = forgeItemRules(env, { prompt, family: q.family, slot: q.slot, element: q.element, seed });
      return { result: { item } as AskResult<K>, why: `keyword forge: ${item.family ?? item.slot ?? "item"} / ${item.element}, ${item.rarity} (creativity ${item.creativity})` };
    }
    case "forge.armour_set": {
      const q = params as AskParams<"forge.armour_set">;
      const set = forgeArmourSetRules(env, q.prompt, armourSlots(env, q.slots), seed);
      return { result: set as AskResult<K>, why: `keyword set: ${set.pieces.length} pieces (${set.pieces.map((x) => x.slot).join(", ")})` };
    }
    case "forge.look": {
      const q = params as AskParams<"forge.look">;
      const variant = forgeLookRules(env, { prompt: q.prompt, asset: q.asset, slots: q.slots, seed });
      return { result: { variant } as AskResult<K>, why: `keyword look: ${variant.recolour?.length ?? 0} recolours, ${variant.materialSwaps.length} material swaps` };
    }
    case "forge.vfx": {
      const q = params as AskParams<"forge.vfx">;
      const element = resolveElement(env, q.prompt);
      const intent = vfxIntent(q.prompt);
      const vfx = buildVfx({ intent, element, seed, attach: q.attach, durationSec: q.durationSec ?? undefined, name: cleanText(q.prompt, 64) || undefined, scale: /\b(huge|giant|massive|big)\b/i.test(q.prompt) ? 2 : /\b(tiny|small|subtle)\b/i.test(q.prompt) ? 0.5 : 1 });
      return { result: { vfx } as AskResult<K>, why: `keyword vfx: ${intent} / ${element}` };
    }
    case "forge.creature": {
      const q = params as AskParams<"forge.creature">;
      const creature = forgeCreatureRules(env, { prompt: q.prompt, role: q.role as CreatureRole | undefined, seed });
      return { result: { creature } as AskResult<K>, why: `keyword creature: ${creature.role}, behaviour ${creature.behaviour}` };
    }
    case "forge.npc_look": {
      const q = params as AskParams<"forge.npc_look">;
      const asset = q.asset ?? extras.persona?.asset;
      const element = resolveElement(env, q.prompt);
      const acc = accessories(env, q.prompt, element, seed).map((a) => a.blueprint);
      const variant = asset ? forgeLookRules(env, { prompt: q.prompt, asset, seed }) : undefined;
      if (variant) delete variant.attachments; // accessories are returned separately for npc looks
      return {
        result: { npc: q.npc, ...(variant ? { variant } : {}), accessories: acc } as AskResult<K>,
        why: `keyword npc look: ${variant ? `restyle of ${asset}` : "no asset"}, ${acc.length} accessories`,
      };
    }
    case "forge.prop": {
      const q = params as AskParams<"forge.prop">;
      const prop = forgePropRules(env, { prompt: q.prompt, seed });
      return { result: { prop } as AskResult<K>, why: `keyword prop: ${prop.name}` };
    }
    case "forge.loot": {
      const q = params as AskParams<"forge.loot">;
      const ctx = { enemy: q.enemy, zone: q.zone, moment: q.moment, ...extras.loot };
      const items = forgeLootRules(env, ctx, q.count ?? 1, seed);
      const from = [ctx.boss ? "boss" : ctx.elite ? "elite" : "", ctx.enemy, ctx.zone && `in ${ctx.zone}`].filter(Boolean).join(" ");
      return { result: { items } as AskResult<K>, why: `themed loot${from ? ` from ${from}` : ""}: ${items.map((i) => i.rarity).join(", ")}` };
    }
  }
  throw new Error(`unknown forge kind ${kind}`);
}

// ------------------------------------------------------------------------------------------------ AI

export interface LlmDeps {
  llm: ScopedLlm;
  log: Logger;
  moderation: Moderator;
  signal?: AbortSignal;
  player?: string | null;
}

async function callLlm(deps: LlmDeps, env: ForgeEnv, task: ForgeTask, kind: ForgeKind, schema: object, user: unknown): Promise<unknown | null> {
  try {
    const r = await deps.llm.json(schema, forgeSystem(env, task), JSON.stringify(user), {
      tier: "fast", maxTokens: MAX_TOKENS[task], signal: deps.signal, task: kind, player: deps.player ?? null,
    });
    return r.value;
  } catch (e) {
    deps.log.debug("forge llm failed, keeping rules answer", { kind, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Mask LLM text that fails output moderation. */
async function safeText(deps: LlmDeps, env: ForgeEnv, text: string): Promise<string> {
  if (!text) return text;
  const v = await deps.moderation.check(text, { direction: "output", manifest: env.manifest });
  return v.ok ? text : v.cleaned;
}

async function moderateItem(deps: LlmDeps, env: ForgeEnv, item: ForgedItem): Promise<ForgedItem> {
  item.name = (await safeText(deps, env, item.name)) || item.name;
  item.flavor = await safeText(deps, env, item.flavor);
  return item;
}

/** AI producer (null = keep the instant answer). `instant` is the rules / cache answer already sent. */
export async function produceAi<K extends ForgeKind>(kind: K, env: ForgeEnv, deps: LlmDeps, params: AskParams<K>, instant: AskResult<K>, extras: ForgeExtras = {}): Promise<Produced<K> | null> {
  const p = params as Record<string, unknown>;
  const seed = seedFor(p.seed as number | undefined, { kind, ...p, seed: undefined });
  switch (kind) {
    case "forge.item": {
      const q = params as AskParams<"forge.item">;
      const fallback = (instant as AskResult<"forge.item">).item;
      const prompt = (q.prompt ?? "").trim() || contextPrompt(q);
      const raw = await callLlm(deps, env, "item", kind, itemJsonSchema(env), { prompt, family: q.family ?? null, slot: q.slot ?? null, element: q.element ?? null, context: q.context ?? null });
      const item = raw ? itemFromLlm(env, raw, { prompt, family: q.family, slot: q.slot, element: q.element, seed }, fallback) : null;
      if (!item) return null;
      if (fallback.mesh) item.mesh = fallback.mesh;
      const reason = isObj(raw) && typeof raw.creativityReason === "string" ? cleanText(raw.creativityReason, 100) : "";
      return { result: { item: await moderateItem(deps, env, item) } as AskResult<K>, why: `AI forge: ${item.rarity}, creativity ${item.creativity}${reason ? ` (${reason})` : ""}` };
    }
    case "forge.armour_set": {
      const q = params as AskParams<"forge.armour_set">;
      const inst = instant as AskResult<"forge.armour_set">;
      const slots = inst.pieces.map((x) => x.slot ?? "chest");
      const raw = await callLlm(deps, env, "armour_set", kind, armourSetJsonSchema(env), { prompt: q.prompt, slots });
      if (!isObj(raw) || !Array.isArray(raw.pieces)) return null;
      const n = env.schema.rarities.length;
      const creativity = clampN(finOr(raw.creativity, 0.3), 0, env.schema.creativity.max);
      const ri = Math.round(clampN(Math.min(Math.max(0, rarityIndexOf(env.schema, raw.rarity)), Math.round(creativity * (n - 1)) + 1), 0, n - 1));
      const element = typeof raw.element === "string" ? resolveElement(env, q.prompt, raw.element) : inst.pieces[0]?.element ?? resolveElement(env, q.prompt);
      const pieces: ForgedItem[] = [];
      for (const [i, slot] of slots.entries()) {
        const fb = inst.pieces[i];
        const rp = (raw.pieces as unknown[]).find((x) => isObj(x) && typeof x.slot === "string" && x.slot.toLowerCase() === slot.toLowerCase()) as Record<string, unknown> | undefined;
        const item = itemFromLlm(env, { kind: "armour", slot, element, rarity: env.schema.rarities[ri], creativity, style: raw.style, name: rp?.name, flavor: rp?.flavor, stats: rp?.stats, tags: rp?.tags, meshPrompt: `${q.prompt} ${slotKind(slot)} piece` }, { prompt: q.prompt, slot, element, rarity: ri, seed: (seed + i * 7919) >>> 0 }, fb);
        if (item) pieces.push(await moderateItem(deps, env, item));
        else if (fb) pieces.push(fb);
      }
      if (!pieces.length) return null;
      const sb = isObj(raw.setBonus) ? raw.setBonus : null;
      const bonusFloor = setBonusFor(env, pieces.length, ri);
      const setBonus = sb && bonusFloor
        ? { description: (await safeText(deps, env, cleanText(sb.description, 200))) || bonusFloor.description, stats: shrinkBonus(env, clampStats(env.schema, sb.stats, ri), bonusFloor.stats) }
        : bonusFloor;
      return {
        result: { name: (await safeText(deps, env, cleanText(raw.name, 64))) || inst.name, pieces, ...(setBonus ? { setBonus } : {}) } as AskResult<K>,
        why: `AI set: ${pieces.length} pieces, ${env.schema.rarities[ri]}`,
      };
    }
    case "forge.look": {
      const q = params as AskParams<"forge.look">;
      const raw = await callLlm(deps, env, "look", kind, lookJsonSchema(), { prompt: q.prompt, asset: q.asset, slots: q.slots ?? null });
      const variant = raw ? lookFromLlm(env, raw, { prompt: q.prompt, asset: q.asset, slots: q.slots, seed }, (instant as AskResult<"forge.look">).variant) : null;
      return variant ? { result: { variant } as AskResult<K>, why: "AI look" } : null;
    }
    case "forge.vfx": {
      const q = params as AskParams<"forge.vfx">;
      const raw = await callLlm(deps, env, "vfx", kind, vfxJsonSchema(env), { prompt: q.prompt, attach: q.attach ?? null, durationSec: q.durationSec ?? null });
      if (!isObj(raw)) return null;
      const element = typeof raw.element === "string" ? resolveElement(env, q.prompt, raw.element) : resolveElement(env, q.prompt);
      const vfx = vfxFromStyle(raw, { element, seed, attach: q.attach, durationSec: q.durationSec ?? undefined });
      return { result: { vfx } as AskResult<K>, why: `AI vfx: ${vfx.tags?.[0] ?? "effect"} / ${element}` };
    }
    case "forge.creature": {
      const q = params as AskParams<"forge.creature">;
      const fb = (instant as AskResult<"forge.creature">).creature;
      const raw = await callLlm(deps, env, "creature", kind, creatureJsonSchema(env), { prompt: q.prompt, role: q.role ?? null });
      const creature = raw ? creatureFromLlm(env, raw, { prompt: q.prompt, role: q.role as CreatureRole | undefined, seed }, fb) : null;
      if (!creature) return null;
      creature.name = (await safeText(deps, env, creature.name)) || fb.name;
      creature.flavor = await safeText(deps, env, creature.flavor);
      if (fb.mesh) creature.mesh = fb.mesh;
      return { result: { creature } as AskResult<K>, why: `AI creature: ${creature.role}, ${creature.behaviour}` };
    }
    case "forge.npc_look": {
      const q = params as AskParams<"forge.npc_look">;
      const inst = instant as AskResult<"forge.npc_look">;
      const raw = await callLlm(deps, env, "npc_look", kind, npcLookJsonSchema(), { prompt: q.prompt, npc: q.npc, persona: extras.persona ?? null, asset: q.asset ?? extras.persona?.asset ?? null });
      if (!isObj(raw)) return null;
      const asset = q.asset ?? extras.persona?.asset;
      const variant = asset && inst.variant ? lookFromLlm(env, raw, { prompt: q.prompt, asset, seed }, inst.variant) : inst.variant;
      const accText = Array.isArray(raw.accessories) ? raw.accessories.filter((a): a is string => typeof a === "string").slice(0, 3).join(", ") : "";
      const element = resolveElement(env, q.prompt);
      const acc = accText ? accessories(env, accText, element, seed).map((a) => a.blueprint) : inst.accessories;
      return { result: { npc: q.npc, ...(variant ? { variant } : {}), accessories: acc.length ? acc : inst.accessories } as AskResult<K>, why: `AI npc look: ${acc.length} accessories` };
    }
    case "forge.prop": {
      const q = params as AskParams<"forge.prop">;
      const fb = (instant as AskResult<"forge.prop">).prop;
      const raw = await callLlm(deps, env, "prop", kind, propJsonSchema(env), { prompt: q.prompt });
      const prop = raw ? propFromLlm(env, raw, { prompt: q.prompt, seed }, fb) : null;
      if (!prop) return null;
      prop.name = (await safeText(deps, env, prop.name)) || fb.name;
      return { result: { prop } as AskResult<K>, why: "AI prop" };
    }
    case "forge.loot": {
      const q = params as AskParams<"forge.loot">;
      const inst = (instant as AskResult<"forge.loot">).items;
      const ctx = { enemy: q.enemy, zone: q.zone, moment: q.moment, ...extras.loot };
      const raw = await callLlm(deps, env, "loot", kind, lootJsonSchema(env), { count: inst.length, ...ctx });
      if (!isObj(raw) || !Array.isArray(raw.items)) return null;
      const items: ForgedItem[] = [];
      for (const [i, fb] of inst.entries()) {
        const r = raw.items[i];
        // loot keeps the rules rarity roll (boss / elite boost): the LLM themes it, it does not raise power
        const item = isObj(r) ? itemFromLlm(env, r, { prompt: fb.meshPrompt ?? fb.name, rarity: fb.rarity, seed: (seed + i * 104729) >>> 0 }, fb) : null;
        items.push(item ? await moderateItem(deps, env, item) : fb);
      }
      return { result: { items } as AskResult<K>, why: `AI themed loot: ${items.map((i) => i.name).join(", ").slice(0, 160)}` };
    }
  }
  return null;
}

/** A set bonus may not exceed twice the rules bonus per stat. */
function shrinkBonus(env: ForgeEnv, raw: Record<string, number>, floor: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(floor)) {
    const r = env.schema.stats[k];
    const want = typeof raw[k] === "number" ? raw[k] - (r?.min ?? 0) : v;
    out[k] = Math.max(0, Math.min(want, v * 2));
  }
  return out;
}


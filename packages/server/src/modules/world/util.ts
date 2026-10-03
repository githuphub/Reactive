// Small helpers shared by the World and Quests modules (K2). Pure functions over the manifest + context.
import { cleanText, hashString, mulberry32 } from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";
import type { ModuleContext, ScopedContext } from "../../module.js";

export type Persona = Manifest["personas"][number];
export type Faction = Manifest["factions"][number];
export type Reaction = Manifest["reactions"][number];

export const clamp = (v: number, lo: number, hi: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
export const round3 = (v: number): number => Math.round(v * 1000) / 1000;
export const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1)).trimEnd()}…`);
export const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");
export const numOr = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Seeded RNG from any string (deterministic rules fast-paths). */
export const rngFrom = (seed: string): (() => number) => mulberry32(hashString(seed));
export const pick = <T>(list: readonly T[], r: () => number): T | undefined => (list.length ? list[Math.floor(r() * list.length) % list.length] : undefined);
export function shuffle<T>(list: readonly T[], r: () => number): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Short wire-safe id: "<prefix>_<base36 hash>". */
export const shortId = (prefix: string, material: string): string => `${prefix}_${hashString(material).toString(36)}${(hashString(`${material}#`) % 1296).toString(36)}`;

/** "first_kill_of_type" -> "first kill of type"; "goblin_shaman" -> "goblin shaman". */
export const humanise = (id: string): string => id.replace(/[_\-.]+/g, " ").trim();
export const titleCase = (s: string): string => humanise(s).replace(/\b\p{L}/gu, (c) => c.toUpperCase());

export const personaById = (m: Manifest, id: string | undefined | null): Persona | undefined => (id ? m.personas.find((p) => p.id === id) : undefined);
export const factionById = (m: Manifest, id: string | undefined | null): Faction | undefined => (id ? m.factions.find((f) => f.id === id) : undefined);
/** Display name for an npc / faction / zone / boss id, else the humanised id. */
export function nameOf(m: Manifest, id: string): string {
  return personaById(m, id)?.name ?? factionById(m, id)?.name ?? m.zones.find((z) => z.id === id)?.name ?? m.bosses.find((b) => b.id === id)?.name ?? humanise(id);
}
export const personasInZone = (m: Manifest, zone: string): Persona[] => (zone ? m.personas.filter((p) => p.zone === zone) : []);
export const neighbours = (m: Manifest, zone: string | undefined): string[] => {
  if (!zone) return [];
  const z = m.zones.find((x) => x.id === zone);
  const out = new Set(z?.neighbours ?? []);
  for (const o of m.zones) if (o.neighbours.includes(zone)) out.add(o.id);
  return [...out];
};
/** Stance between two factions (-1..1), symmetric fallback; same faction = 1. */
export function factionRelation(m: Manifest, a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return factionById(m, a)?.relations[b] ?? factionById(m, b)?.relations[a] ?? 0;
}

/** Faction an id refers to: a faction id itself, or the faction of a persona. */
export function resolveFaction(m: Manifest, ref: unknown): string | undefined {
  const id = str(ref);
  if (!id) return undefined;
  if (factionById(m, id)) return id;
  return personaById(m, id)?.faction;
}

/** Read any projection without throwing (module disabled / not registered -> null). */
export function safeProjection<T>(ctx: Pick<ModuleContext, "projections">, name: string, scope: { world: string; player?: string | null }): T | null {
  try {
    return (ctx.projections.get<T>(name, scope) as T) ?? null;
  } catch {
    return null;
  }
}

/** Module options with a typed default (manifest modules.<id>.options.<key>). */
type Widen<T> = T extends boolean ? boolean : T extends number ? number : T extends string ? string : T;
export function opt<T>(ctx: Pick<ModuleContext, "options">, key: string, fallback: T): Widen<T> {
  const v = ctx.options?.[key];
  const out = (x: unknown) => x as Widen<T>;
  if (v === undefined || v === null) return out(fallback);
  if (typeof fallback === "number") return out(typeof v === "number" && Number.isFinite(v) ? v : fallback);
  if (typeof fallback === "boolean") return out(typeof v === "boolean" ? v : fallback);
  if (typeof fallback === "string") return out(typeof v === "string" ? v : fallback);
  return out(v);
}

/** How rules text refers to the player: player-model stat "name", else options.playerNoun, else "the newcomer". */
export function playerLabel(ctx: Pick<ModuleContext, "projections" | "options">, world: string, player: string): string {
  const model = safeProjection<{ stats?: Record<string, unknown> }>(ctx, "observer.player_model", { world, player });
  const name = model?.stats?.name;
  if (typeof name === "string" && name.trim()) return cleanText(name, 40);
  return opt(ctx, "playerNoun", "the newcomer");
}

/** Fill "{{key}}" placeholders in any JSON value. A string that is exactly "{{key}}" takes the raw value's type. */
export function fillTemplate(v: unknown, vars: (key: string) => unknown): unknown {
  if (typeof v === "string") {
    const whole = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(v);
    if (whole) {
      const val = vars(whole[1]);
      return val === undefined ? v : val;
    }
    return v.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (all, k: string) => {
      const val = vars(k);
      return val === undefined || val === null ? all : String(val);
    });
  }
  if (Array.isArray(v)) return v.map((x) => fillTemplate(x, vars));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, fillTemplate(x, vars)]));
  return v;
}

/**
 * Stable system prompt for LLM calls (lore bible + tone + safety); keep it identical across calls so prompt
 * caching works. `role` is appended last.
 */
export function loreSystem(m: Manifest, role: string): string {
  const s = m.safety;
  return [
    `You write content for the game "${m.game.name}".`,
    `LORE BIBLE:\n${m.lore.bible}`,
    `TONE: ${m.lore.tone}`,
    `SAFETY: content rating ${s.rating}. Stay inside the game world${s.inWorldOnly ? " (no real-world references)" : ""}. Never touch: ${s.refusedTopics.join("; ") || "nothing listed"}.`,
    role,
  ].join("\n\n");
}

/** Short persona card for prompts. */
export function personaCard(p: Persona): string {
  return [
    `${p.name} (${p.role}${p.faction ? `, faction ${p.faction}` : ""})`,
    `Personality: ${p.personality}`,
    p.likes.length ? `Likes: ${p.likes.join(", ")}` : "",
    p.dislikes.length ? `Dislikes: ${p.dislikes.join(", ")}` : "",
    p.voice.style ? `Voice: ${p.voice.style}` : "",
  ].filter(Boolean).join("\n");
}

/** Moderate + clean LLM text. Returns "" when blocked. */
export async function moderateOut(ctx: Pick<ModuleContext, "moderation" | "manifest">, text: unknown, max: number): Promise<string> {
  const t = cleanText(text, max);
  if (!t) return "";
  const v = await ctx.moderation.check(t, { direction: "output", manifest: ctx.manifest });
  return v.ok ? t : "";
}

/** In-memory throttle: true when `key` may run now (at most once per `ms`). */
const lastRun = new Map<string, number>();
export function throttle(key: string, ms: number, now = Date.now()): boolean {
  const last = lastRun.get(key) ?? 0;
  if (now - last < ms) return false;
  lastRun.set(key, now);
  if (lastRun.size > 20_000) lastRun.clear();
  return true;
}

/**
 * Bind a ModuleContext (e.g. the one saved in init, used by routes) to a world + player, like the core's scoped
 * contexts: emit / record default to that scope. Getters (manifest, options) stay live.
 */
export function scopeFor(ctx: ModuleContext, world: string, player: string | null): ScopedContext {
  const base = Object.create(Object.getPrototypeOf(ctx), Object.getOwnPropertyDescriptors(ctx)) as ModuleContext;
  return Object.assign(base, {
    world,
    player,
    session: null,
    emit: (draft: Parameters<ModuleContext["emit"]>[0], scope?: { world?: string; player?: string | null }) =>
      ctx.emit(draft, { world: scope?.world ?? world, player: scope && "player" in scope ? scope.player ?? null : player }),
    record: (type: string, data: Record<string, unknown>, scope?: { world?: string; player?: string | null }) =>
      ctx.record(type, data, { world: scope?.world ?? world, player: scope && "player" in scope ? scope.player ?? null : player }),
  }) as unknown as ScopedContext;
}

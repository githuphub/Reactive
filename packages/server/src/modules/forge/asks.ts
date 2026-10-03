// Ask handlers for the eight forge kinds: moderation + rate limit + rules instant answer (+ optional Hyper3D job) ->
// lf.forge.created; AI upgrade -> clamped result -> lf.forge.created (source ai). Modules never touch HTTP.
import type { AskParams, AskResult, ForgeJob } from "@liveforge/protocol";
import type { AskContext, AskHandler, AskHandlers, InstantAnswer, UpgradeAnswer } from "../../module.js";
import { forgeEnv, type ForgeEnv } from "./env.js";
import { FORGE_KINDS, produceAi, produceRules, type ForgeExtras, type ForgeKind } from "./service.js";
import type { LootContext } from "./items.js";
import { isObj } from "./model.js";

const sleep = (ms: number) => new Promise<null>((r) => setTimeout(() => r(null), ms));

/** Results that can carry a Hyper3D mesh job, and the text prompt to send for them. */
function meshTarget(kind: ForgeKind, result: unknown): { holder: Record<string, unknown>; prompt: string } | null {
  if (!isObj(result)) return null;
  const pick = (o: unknown, fallback: string) => (isObj(o) ? { holder: o, prompt: String(o.meshPrompt ?? o.name ?? fallback) } : null);
  if (kind === "forge.item") return pick(result.item, "item");
  if (kind === "forge.creature") return pick(result.creature, "creature");
  if (kind === "forge.prop") return pick(result.prop, "prop");
  return null;
}

/**
 * Start a Hyper3D job when asked (`mesh: true`) and allowed (manifest clamps.forge.meshJobs + a key). Waits at most
 * forge options meshWaitMs for the job id; the job keeps running either way and the core pushes `forge.ready`
 * (with this askId) when the GLB is stored. The blueprint is the stand-in until then.
 */
async function attachMesh(ctx: AskContext, env: ForgeEnv, kind: ForgeKind, params: Record<string, unknown>, result: unknown): Promise<string | null> {
  if (params.mesh !== true || !env.manifest.clamps.forge.meshJobs) return null;
  const t = meshTarget(kind, result);
  if (!t) return null;
  const submit = ctx.jobs.submitMesh(t.prompt.slice(0, 400), { world: ctx.world, player: ctx.player, askId: ctx.askId, meta: { kind } }).catch((e: unknown) => {
    ctx.log.warn("mesh job failed to start", { error: e instanceof Error ? e.message : String(e) });
    return null;
  });
  const job = (await Promise.race([submit, sleep(env.options.meshWaitMs)])) as ForgeJob | null;
  if (job) {
    t.holder.mesh = { jobId: job.id, state: job.state, ...(job.url ? { url: job.url } : {}) };
    return `mesh job ${job.id} ${job.state}`;
  }
  return "mesh job starting (forge.ready follows)";
}

/** Per-player forge rate (manifest clamps.forge.maxPerMinPerPlayer). true = over the limit. */
function overRate(ctx: AskContext, env: ForgeEnv): boolean {
  if (!ctx.player) return false;
  const key = `rate:${ctx.world}:${ctx.player}`;
  const now = ctx.now();
  const recent = (ctx.kv.get<number[]>(key) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  ctx.kv.set(key, recent.slice(-64));
  return recent.length > env.manifest.clamps.forge.maxPerMinPerPlayer;
}

/** Fight context for forge.loot: explicit params, else the player's latest kill / zone; boss / elite detection. */
function lootContext(ctx: AskContext, p: AskParams<"forge.loot">): LootContext {
  const out: LootContext = {};
  let enemy = p.enemy;
  let zone = p.zone;
  if ((!enemy || !zone) && ctx.player) {
    const kills = ctx.events({ world: ctx.world, player: ctx.player, type: "combat.killed", limit: 1, desc: true });
    const k = kills[0]?.data;
    if (k && !enemy) enemy = String(k.target_type ?? k.target ?? "") || undefined;
    if (k?.elite === true) out.elite = true;
    if (k?.boss === true) out.boss = true;
    if (!zone) {
      const z = ctx.events({ world: ctx.world, player: ctx.player, type: "movement.entered_zone", limit: 1, desc: true })[0]?.data;
      if (z && typeof z.zone === "string") zone = z.zone;
    }
  }
  if (enemy && ctx.manifest.bosses.some((b) => b.id === enemy || b.name.toLowerCase() === enemy!.toLowerCase())) out.boss = true;
  if (enemy) out.enemy = ctx.manifest.bosses.find((b) => b.id === enemy)?.name ?? enemy;
  if (zone) out.zone = ctx.manifest.zones.find((z) => z.id === zone)?.name ?? zone;
  if (p.moment) out.moment = p.moment;
  return out;
}

function extrasFor(ctx: AskContext, kind: ForgeKind, params: Record<string, unknown>): ForgeExtras {
  if (kind === "forge.loot") return { loot: lootContext(ctx, params as AskParams<"forge.loot">) };
  if (kind === "forge.npc_look") {
    const p = ctx.manifest.personas.find((x) => x.id === params.npc);
    if (p) return { persona: { name: p.name, role: p.role, personality: p.personality, ...(p.asset ? { asset: p.asset } : {}) } };
  }
  return {};
}

const FIZZLE: Partial<Record<ForgeKind, string>> = {
  "forge.item": "a harmless lump of slag", "forge.armour_set": "plain slag armour", "forge.creature": "a small harmless slime",
  "forge.prop": "a lump of slag", "forge.look": "plain grey", "forge.npc_look": "plain grey", "forge.vfx": "a puff of grey smoke",
};

function handler<K extends ForgeKind>(kind: K): AskHandler<K> {
  return {
    async instant(ctx, params): Promise<InstantAnswer<K>> {
      const env = forgeEnv(ctx.manifest, ctx.options);
      const p = { ...(params as Record<string, unknown>) };
      let final = false;
      const notes: string[] = [];
      if (typeof p.prompt === "string" && p.prompt.trim()) {
        const v = await ctx.moderation.check(p.prompt, { direction: "input", manifest: ctx.manifest });
        if (!v.ok) {
          // Counterforge's fizzle rule: blocked wishes forge something harmless, never an error
          p.prompt = FIZZLE[kind] ?? v.cleaned;
          final = true;
          notes.push(`fizzled (${v.reason ?? "moderated"})`);
        }
      }
      if (overRate(ctx, env)) {
        final = true;
        notes.push(`rate limit ${env.manifest.clamps.forge.maxPerMinPerPlayer}/min: rules only`);
      }
      const extras = extrasFor(ctx, kind, p);
      const { result, why } = produceRules(kind, env, p as AskParams<K>, extras);
      if (notes[0]?.startsWith("fizzled") && kind === "forge.item") {
        const r = result as AskResult<"forge.item">;
        r.item.name = "Fizzled Slag";
        r.item.creativity = 0;
      }
      const mesh = await attachMesh(ctx, env, kind, p, result);
      if (mesh) notes.push(mesh);
      ctx.record("lf.forge.created", { askKind: kind, askId: ctx.askId, result, source: "rules", key: typeof p.prompt === "string" ? p.prompt.slice(0, 200) : kind });
      return { result, why: [why, ...notes].join("; ").slice(0, 300), source: "rules", final };
    },
    async upgrade(ctx, params, instant): Promise<UpgradeAnswer<K> | null> {
      if (!ctx.llm) return null;
      const env = forgeEnv(ctx.manifest, ctx.options);
      const extras = extrasFor(ctx, kind, params as Record<string, unknown>);
      const out = await produceAi(kind, env, { llm: ctx.llm, log: ctx.log, moderation: ctx.moderation, signal: ctx.signal, player: ctx.player }, params, instant, extras);
      if (!out) return null;
      const p = params as Record<string, unknown>;
      ctx.record("lf.forge.created", { askKind: kind, askId: ctx.askId, result: out.result, source: "ai", key: typeof p.prompt === "string" ? p.prompt.slice(0, 200) : kind });
      return { result: out.result, why: out.why.slice(0, 300) };
    },
    // identical requests share an upgraded answer across players (forged content is not personal); loot is
    // personal (themed on this player's fight) and keeps the default per-player key
    ...(kind === "forge.loot" ? {} : { cacheKey: (p: AskParams<K>) => ({ kind, p }) }),
    cacheTtlSec: 24 * 3600,
  };
}

/** The forge's ask handlers. */
export const forgeAsks: AskHandlers = Object.fromEntries(FORGE_KINDS.map((k) => [k, handler(k)])) as AskHandlers;

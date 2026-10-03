// Forge HTTP routes.
//   Admin (/admin/m/forge/*):
//     POST /bake            generate a catalogue: {kind, count?, prompts?, params?, world?, ai?} -> review queue (pending)
//     GET  /review          list gallery entries: ?world=&status=pending|approved|rejected|none&kind=
//     POST /review/:id      {status: approved|rejected|pending, world?, note?}
//     GET  /pack            export a bake pack of approved entries: ?world=&kinds=forge.item,forge.look
//   Public (/v1/m/forge/*):
//     GET  /mesh/:jobId     asset proxy: 302 to the stored GLB when done, 202 {state} while generating, 404 unknown
// Bake + review is event-sourced (lf.forge.created with review "pending", lf.forge.review): the dashboard reads the
// same `forge.gallery` projection.
import { Hono } from "hono";
import { ASKS, PROTOCOL_ID, hashString, type AskParams, type BakePack, type ForgeGallery } from "@liveforge/protocol";
import type { LfEnv, ModuleContext } from "../../module.js";
import { forgeEnv, type ForgeEnv } from "./env.js";
import { FORGE_KINDS, produceAi, produceRules, type ForgeKind } from "./service.js";
import type { ForgeGalleryEntry } from "./gallery.js";
import { LIBRARY_FAMILIES } from "./library/archetypes.js";
import { armourSlots } from "./items.js";
import { isObj, mulberry32 } from "./model.js";

/** Module contexts per game (filled by the module's init). */
export const forgeContexts = new Map<string, ModuleContext>();

const ADJ = ["ancient", "cursed", "radiant", "rusted", "elegant", "brutal", "whispering", "gilded", "jagged", "humble", "royal", "feral"];
const CREATURES = ["wolf", "golem", "imp", "slime", "bat", "spider", "beetle", "wisp", "boar", "serpent", "crow", "toad"];
const PROPS = ["crate", "barrel", "statue", "totem", "lantern", "chest", "anvil", "signpost", "well", "shrine", "cart", "bench"];
const VFX = ["aura", "trail", "burst", "hit", "cast", "heal", "shield", "explosion"];

/** Catalogue prompt #i for a kind when the admin sent none (cycles families / elements / nouns). */
function cataloguePrompt(env: ForgeEnv, kind: ForgeKind, i: number, seed: number): string {
  const r = mulberry32(seed + i * 977);
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length) % a.length];
  const el = env.elements[i % env.elements.length];
  switch (kind) {
    case "forge.item": {
      const fams = env.schema.families.length ? env.schema.families : [...LIBRARY_FAMILIES];
      return `${pick(ADJ)} ${el} ${fams[i % fams.length].replace(/_/g, " ")}`;
    }
    case "forge.armour_set": return `${pick(ADJ)} ${el} armour`;
    case "forge.creature": return `${pick(ADJ)} ${el} ${CREATURES[i % CREATURES.length]}`;
    case "forge.prop": return `${pick(ADJ)} ${PROPS[i % PROPS.length]}`;
    case "forge.vfx": return `${el} ${VFX[i % VFX.length]}`;
    case "forge.look":
    case "forge.npc_look": return `${pick(ADJ)} ${el} look`;
    case "forge.loot": return "";
  }
}

/** Params for catalogue entry #i (validated with the protocol schema; null when invalid). */
function catalogueParams(env: ForgeEnv, kind: ForgeKind, i: number, base: Record<string, unknown>, prompt: string | undefined, seed: number): AskParams<ForgeKind> | null {
  const p: Record<string, unknown> = { ...base, seed: (seed + i * 7919) >>> 0 };
  const text = prompt ?? cataloguePrompt(env, kind, i, seed);
  if (kind === "forge.loot") {
    if (!p.enemy) {
      const bosses = env.manifest.bosses;
      if (bosses.length) p.enemy = bosses[i % bosses.length].name;
    }
    if (prompt) p.moment = prompt;
  } else {
    p.prompt = text;
  }
  if (kind === "forge.look" && !p.asset) {
    const assets = env.schema.assets;
    if (!assets.length) return null;
    p.asset = assets[i % assets.length].id;
  }
  if (kind === "forge.npc_look" && !p.npc) {
    const personas = env.manifest.personas;
    if (!personas.length) return null;
    p.npc = personas[i % personas.length].id;
  }
  if (kind === "forge.armour_set" && !p.slots) p.slots = armourSlots(env);
  const parsed = ASKS[kind].params.safeParse(p);
  return parsed.success ? (parsed.data as AskParams<ForgeKind>) : null;
}

const err = (code: string, message: string) => ({ error: { code, message } });

function galleryOf(ctx: ModuleContext, world: string): ForgeGalleryEntry[] {
  return (ctx.projections.get("forge.gallery", { world }) as ForgeGallery).entries as ForgeGalleryEntry[];
}

/** Admin routes (/admin/m/forge/*). */
export const forgeAdmin = new Hono<LfEnv>();

forgeAdmin.post("/bake", async (c) => {
  const ctx = forgeContexts.get(c.get("game"));
  if (!ctx) return c.json(err("module_disabled", "forge is not enabled for this game"), 404);
  const body = await c.req.json().catch(() => null);
  if (!isObj(body)) return c.json(err("bad_request", "expected a JSON body {kind, count?, prompts?, params?, world?, ai?}"), 400);
  const kind = (String(body.kind ?? "").startsWith("forge.") ? body.kind : `forge.${String(body.kind ?? "")}`) as ForgeKind;
  if (!FORGE_KINDS.includes(kind)) return c.json(err("bad_request", `kind must be one of ${FORGE_KINDS.join(", ")}`), 400);
  const env = forgeEnv(ctx.manifest, ctx.options);
  const prompts = Array.isArray(body.prompts) ? body.prompts.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, env.options.maxBake) : [];
  const count = Math.max(1, Math.min(env.options.maxBake, Math.round(Number(body.count ?? prompts.length) || prompts.length || 10)));
  const world = typeof body.world === "string" && /^[A-Za-z0-9_\-.:]{1,64}$/.test(body.world) ? body.world : env.options.bakeWorld;
  const base = isObj(body.params) ? body.params : {};
  const seed = typeof body.seed === "number" ? body.seed >>> 0 : hashString(`${kind}|${ctx.now()}`);
  const made: { id: string; key: string }[] = [];
  const skipped: number[] = [];
  const todo: { id: string; key: string; params: AskParams<ForgeKind>; result: unknown }[] = [];
  for (let i = 0; i < count; i++) {
    const prompt = prompts.length ? prompts[i % prompts.length] : undefined;
    const params = catalogueParams(env, kind, i, base, prompt, seed);
    if (!params) { skipped.push(i); continue; }
    const v = typeof (params as { prompt?: string }).prompt === "string"
      ? await ctx.moderation.check((params as { prompt: string }).prompt, { direction: "input", manifest: ctx.manifest })
      : { ok: true };
    if (!v.ok) { skipped.push(i); continue; }
    const { result } = produceRules(kind, env, params);
    const key = String((params as { prompt?: string }).prompt ?? (params as { enemy?: string }).enemy ?? kind).slice(0, 200);
    const id = `bake_${kind.slice(6)}_${(seed >>> 0).toString(36)}_${i}`;
    ctx.record("lf.forge.created", { askKind: kind, askId: id, result, source: "bake", review: "pending", key }, { world });
    made.push({ id, key });
    todo.push({ id, key, params, result });
  }
  // AI pass in the background (budgets permitting): each entry is re-recorded with the upgraded result
  const ai = body.ai === true && !!ctx.llm;
  if (ai) {
    void (async () => {
      for (const t of todo) {
        if (!ctx.llm || !ctx.budgets.check(null).ok) break;
        const out = await produceAi(kind, env, { llm: ctx.llm, log: ctx.log, moderation: ctx.moderation, player: null }, t.params, t.result as never).catch(() => null);
        if (out) ctx.record("lf.forge.created", { askKind: kind, askId: t.id, result: out.result, source: "bake", review: "pending", key: t.key }, { world });
      }
    })();
  }
  return c.json({ kind, world, queued: made.length, skipped, ai: ai ? "running" : body.ai === true ? "unavailable (no LLM key)" : "off", entries: made }, 202);
});

forgeAdmin.get("/review", (c) => {
  const ctx = forgeContexts.get(c.get("game"));
  if (!ctx) return c.json(err("module_disabled", "forge is not enabled for this game"), 404);
  const env = forgeEnv(ctx.manifest, ctx.options);
  const world = c.req.query("world") || env.options.bakeWorld;
  const status = c.req.query("status");
  const kind = c.req.query("kind");
  const items = galleryOf(ctx, world).filter((e) => (!status || e.review === status) && (!kind || e.askKind === kind || e.askKind === `forge.${kind}`));
  return c.json({ world, items: items.slice().reverse() });
});

forgeAdmin.post("/review/:id", async (c) => {
  const ctx = forgeContexts.get(c.get("game"));
  if (!ctx) return c.json(err("module_disabled", "forge is not enabled for this game"), 404);
  const env = forgeEnv(ctx.manifest, ctx.options);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const status = String(body.status ?? "");
  if (!["approved", "rejected", "pending", "none"].includes(status)) return c.json(err("bad_request", "status must be approved, rejected or pending"), 400);
  const world = typeof body.world === "string" && body.world ? body.world : c.req.query("world") || env.options.bakeWorld;
  const id = c.req.param("id");
  if (!galleryOf(ctx, world).some((e) => e.id === id)) return c.json(err("not_found", `no gallery entry "${id}" in world "${world}"`), 404);
  ctx.record("lf.forge.review", { id, status, ...(typeof body.note === "string" ? { note: body.note.slice(0, 300) } : {}) }, { world });
  return c.json({ id, world, status });
});

forgeAdmin.get("/pack", (c) => {
  const ctx = forgeContexts.get(c.get("game"));
  if (!ctx) return c.json(err("module_disabled", "forge is not enabled for this game"), 404);
  const env = forgeEnv(ctx.manifest, ctx.options);
  const world = c.req.query("world") || env.options.bakeWorld;
  const kinds = (c.req.query("kinds") ?? "").split(",").map((k) => k.trim()).filter(Boolean).map((k) => (k.startsWith("forge.") ? k : `forge.${k}`));
  const entries: BakePack["entries"] = {};
  const assets = new Set<string>();
  for (const e of galleryOf(ctx, world)) {
    if (e.review !== "approved" || (kinds.length && !kinds.includes(e.askKind))) continue;
    (entries[e.askKind] ??= []).push({ key: e.key ?? e.id, result: e.result, tags: tagsOf(e.result) });
    collectMeshUrls(e.result, assets);
  }
  const pack: BakePack & { assets: string[] } = {
    protocol: PROTOCOL_ID, game: ctx.game, createdAt: ctx.now(), entries, assets: [...assets],
  };
  c.header("content-disposition", `attachment; filename="${ctx.game}-forge-pack.json"`);
  return c.json(pack);
});

function tagsOf(result: unknown): string[] | undefined {
  if (!isObj(result)) return undefined;
  for (const k of ["item", "creature", "prop"]) {
    const o = result[k];
    if (isObj(o) && Array.isArray(o.tags)) return o.tags.filter((t): t is string => typeof t === "string").slice(0, 8);
  }
  return undefined;
}

function collectMeshUrls(v: unknown, out: Set<string>, depth = 0): void {
  if (depth > 4 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) { for (const x of v) collectMeshUrls(x, out, depth + 1); return; }
  const o = v as Record<string, unknown>;
  if (isObj(o.mesh) && typeof o.mesh.url === "string") out.add(o.mesh.url);
  for (const k of ["item", "items", "pieces", "creature", "prop"]) if (k in o) collectMeshUrls(o[k], out, depth + 1);
}

/** Public routes (/v1/m/forge/*). */
export const forgePublic = new Hono<LfEnv>();

forgePublic.get("/mesh/:jobId", (c) => {
  const ctx = forgeContexts.get(c.get("game"));
  if (!ctx) return c.json(err("module_disabled", "forge is not enabled for this game"), 404);
  const job = ctx.jobs.get(c.req.param("jobId"));
  if (!job) return c.json(err("not_found", "unknown mesh job"), 404);
  if (job.state === "done" && job.url) return c.redirect(job.url, 302);
  if (job.state === "failed") return c.json({ id: job.id, state: job.state, error: job.error ?? "generation failed" }, 410);
  return c.json({ id: job.id, state: job.state }, 202);
});

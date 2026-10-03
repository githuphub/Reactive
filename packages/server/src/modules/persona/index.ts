// Module "persona" - OWNER: K1. Only edit files inside packages/server/src/modules/persona/.
// Persona & Voice: persona cards, NPC x player memory, bark pools, streamed conversation with validated actions.
// Contract: docs/CONTRACTS.md. Asks owned here: npc.bark, npc.reply.
// Projections owned here: persona.memories (player scope; PersonaMemories).
//
// Routes: POST /v1/m/persona/stt?npc=<id>&language=en  (speech -> text biased to that NPC's names + topics)
//         GET  /admin/m/persona/pools                    (bark pools + wanted refills, for the dashboard)
import { Hono } from "hono";
import { cleanText, type SttResponse } from "@liveforge/protocol";
import { defineModule, type LfEnv, type ModuleContext, type ScopedContext } from "../../module.js";
import { LfError } from "../../errors.js";
import { forPlayer } from "../observer/scope.js";
import { barkHandler, BK, prefetchGreeting, refillPools, type BarkPool } from "./barks.js";
import { personaCard } from "./cards.js";
import { MEMORIES, memoriesProjection, PERSONA_EVENTS, salientEntries, type MemoryState } from "./memory.js";
import { replyHandler } from "./reply.js";

export { personaCard, voiceFor, allowedActions, sanitizeActions, priceMultiplier, type PersonaCard } from "./cards.js";
export { memoriesProjection, readMemory, effectiveSalience, MEMORIES, PERSONA_EVENTS } from "./memory.js";
export { classifyIntent, screenInput } from "./intent.js";

/** Per-game init contexts (module routes only know the game id). */
const contexts = new Map<string, ModuleContext>();

// ---------------------------------------------------------------- routes

const pub = new Hono<LfEnv>();
/**
 * POST /v1/m/persona/stt?npc=<id>&language=en - multipart field "audio" (or a raw audio/* body) -> SttResponse.
 * Like core /v1/stt, but the recogniser is biased toward that NPC's name, knowledge and the lore glossary.
 */
pub.post("/stt", async (c) => {
  const ctx = contexts.get(c.get("game"));
  if (!ctx) throw new LfError("module_disabled", "persona module is not initialised for this game");
  const stt = ctx.stt;
  if (!stt) throw new LfError("provider_unavailable", "no STT provider configured (set OPENAI_API_KEY or WHISPER_CPP_BIN + WHISPER_CPP_MODEL), or use browser STT and send text");
  const ct = c.req.header("content-type") ?? "";
  let audio: Uint8Array;
  let mime: string;
  if (ct.startsWith("multipart/form-data")) {
    const body = await c.req.parseBody();
    const f = body.audio ?? body.file;
    if (!(f instanceof File)) throw new LfError("bad_request", "multipart field 'audio' (a file) is required");
    audio = new Uint8Array(await f.arrayBuffer());
    mime = f.type || "audio/wav";
  } else if (ct.startsWith("audio/") || ct === "application/octet-stream") {
    audio = new Uint8Array(await c.req.arrayBuffer());
    mime = ct === "application/octet-stream" ? "audio/wav" : ct;
  } else throw new LfError("bad_request", "send multipart/form-data with field 'audio', or a raw audio/* body");
  if (!audio.byteLength) throw new LfError("bad_request", "empty audio");
  if (audio.byteLength > 10 * 1024 * 1024) throw new LfError("bad_request", "audio larger than 10 MB");
  const m = ctx.manifest;
  const npc = c.req.query("npc");
  const card = npc ? personaCard(m, npc) : null;
  const hint = [card?.name, ...(card?.knowledge ?? []), ...m.personas.map((p) => p.name), ...Object.keys(m.lore.glossary)].filter(Boolean).join(", ");
  try {
    const r = await stt.transcribe({ audio, mimeType: mime, language: c.req.query("language") ?? undefined, prompt: hint.slice(0, 800) || undefined });
    const text = r.text.trim();
    const v = await ctx.moderation.check(text, { direction: "input", manifest: m });
    const res: SttResponse = { id: `stt_${Date.now().toString(36)}`, text, ...(r.language ? { language: r.language } : {}), ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}), provider: stt.id, flagged: !v.ok };
    return c.json(res);
  } catch (e) {
    throw new LfError("provider_error", `STT failed: ${(e as Error).message.slice(0, 200)}`);
  }
});

const admin = new Hono<LfEnv>();
/** GET /admin/m/persona/pools - every bark pool + the buckets waiting for an AI refill. */
admin.get("/pools", (c) => {
  const ctx = contexts.get(c.get("game"));
  if (!ctx) return c.json({ pools: [], wanted: [] });
  const pools = ctx.kv.list<BarkPool>("pool:", 1000).map(({ key, value }) => {
    const [, npc, ...bucket] = key.split(":");
    return { npc, bucket: bucket.join(":"), lines: value.lines, updatedAt: value.updatedAt };
  });
  return c.json({ pools, wanted: (ctx.kv.get<string[]>(BK.wanted) ?? []).map((w) => { const [npc, bucket] = w.split("|"); return { npc, bucket }; }) });
});

// ---------------------------------------------------------------- memory summarisation (fast tier)

const SUMMARY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary"],
  properties: { summary: { type: "string", description: "First person, as the NPC: 2-4 sentences about this player." } },
};

async function summariseMemories(ctx: ScopedContext, player: string): Promise<void> {
  if (!ctx.llm || !ctx.budgets.check(player).ok) return;
  let st: MemoryState | undefined;
  try { st = ctx.projections.get<MemoryState>(MEMORIES, { world: ctx.world, player }); } catch { return; }
  const now = ctx.now();
  for (const mem of Object.values(st?.npcs ?? {})) {
    if (mem.entries.length < 9) continue;
    const key = `sum:${ctx.world}:${player}:${mem.npc}`;
    if ((ctx.kv.get<number>(key) ?? 0) > now - 10 * 60_000) continue;
    ctx.kv.set(key, now);
    const card = personaCard(ctx.manifest, mem.npc);
    const ranked = salientEntries(mem, now, mem.entries.length);
    const forget = ranked.slice(Math.ceil(ranked.length / 2)).map((e) => e.ts);
    try {
      const r = await ctx.llm.json<{ summary?: unknown }>(SUMMARY_SCHEMA,
        `You are ${card.name}, ${card.role}. Summarise what you remember about one player, in your own voice. Keep facts; drop small talk.`,
        `Earlier summary: ${mem.summary || "(none)"}\nMemories:\n${mem.entries.map((e) => `- ${e.text}`).join("\n")}\nAttitude: ${mem.attitude.toFixed(2)}`,
        { tier: "fast", task: "persona.memory", player, maxTokens: 220 });
      const summary = cleanText(r.value?.summary, 650);
      if (summary) ctx.record(PERSONA_EVENTS.summary, { npc: mem.npc, summary, forget }, { world: ctx.world, player });
    } catch (e) {
      ctx.log.debug("memory summarisation failed; rules eviction stands", { npc: mem.npc, error: e as Error });
      return;
    }
  }
}

// ---------------------------------------------------------------- module

export default defineModule({
  id: "persona",
  description: "Persona & Voice: persona cards, NPC x player memory, bark pools, streamed conversation with validated actions.",
  projections: [memoriesProjection],
  signalHandlers: [
    {
      // Prefetch: a fresh greeting is generated as the player approaches (served by npc.bark trigger approach).
      types: ["movement.near_npc", "social.approach"],
      handle(ctx, ev) {
        prefetchGreeting(ctx, ev);
      },
    },
  ],
  asks: {
    "npc.bark": barkHandler,
    "npc.reply": replyHandler,
  },
  ticks: [
    { name: "refill-barks", everyMs: 30_000, run: (ctx) => refillPools(ctx, 2) },
    {
      name: "summarise-memories",
      everyMs: 60_000,
      async run(ctx) {
        for (const player of ctx.activePlayers.slice(0, 20)) await summariseMemories(forPlayer(ctx, player), player);
      },
    },
  ],
  routes: { public: pub, admin },
  init(ctx) {
    contexts.set(ctx.game, ctx);
    // Seed pools from the manifest so the first barks are instant and in voice.
    for (const p of ctx.manifest.personas) {
      if (!p.barks.length) continue;
      const key = BK.pool(p.id, "trigger:idle");
      const pool = ctx.kv.get<BarkPool>(key) ?? { lines: [], updatedAt: 0 };
      for (const l of p.barks) if (!pool.lines.includes(l)) pool.lines.push(l);
      ctx.kv.set(key, { lines: pool.lines.slice(-12), updatedAt: ctx.now() });
    }
  },
});

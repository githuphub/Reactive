// Hono app (spec §4.2). Handlers are thin: validation + delegation to the runtime. The WebSocket upgrade on
// /v1/ws is handled by the node server (core/hub.ts); a plain GET there answers 426.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { getConnInfo } from "@hono/node-server/conninfo";
import { ZodError } from "zod";
import { HEADERS, PROTOCOL_ID, SimulateRequest, type ErrorCode } from "@liveforge/protocol";
import { moduleEnabled, parseManifest, validateManifestObject } from "@liveforge/manifest";
import { LfError } from "../errors.js";
import type { Liveforge } from "../core/runtime.js";
import type { LfEnv, LiveforgeModule } from "../module.js";
import { adminRoutes } from "./admin.js";
import { dashboardRoutes } from "../admin/dashboard.js";
import { dashboardAdminRoutes } from "../admin/routes.js";
import { cassetteAdminRoutes } from "../admin/cassettes.js";
import { staticHandler } from "./static.js";

const errBody = (code: ErrorCode, message: string, details?: unknown) => ({ error: { code, message, ...(details !== undefined ? { details } : {}) } });

function keyFrom(c: Context): string | null {
  const auth = c.req.header("authorization");
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return c.req.header(HEADERS.key) ?? c.req.query("key") ?? null;
}

/** The client's IP behind a trusted proxy (LIVEFORGE_TRUST_PROXY): CF-Connecting-IP / True-Client-IP, else the first X-Forwarded-For entry; else the socket. */
function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    // Edge-set headers first (Cloudflare in front of Render overwrites them, so clients can't spoof them),
    // then the first X-Forwarded-For entry.
    const edge = c.req.header("cf-connecting-ip") ?? c.req.header("true-client-ip");
    if (edge?.trim()) return edge.trim();
    const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (xff) return xff;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // app.request() in tests: no socket
  }
}

export function createApp(lf: Liveforge, modules: LiveforgeModule[]): Hono<LfEnv> {
  const app = new Hono<LfEnv>();
  const origins = lf.config.corsOrigins;
  const sttDay = { day: "", n: new Map<string, number>() };

  app.use("*", cors({
    origin: origins.includes("*") ? "*" : origins,
    allowHeaders: ["Content-Type", "Authorization", HEADERS.key, HEADERS.game],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: [HEADERS.protocol],
    maxAge: 600,
  }));
  app.use("*", async (c, next) => {
    await next();
    c.header(HEADERS.protocol, PROTOCOL_ID);
  });

  app.onError((err, c) => {
    if (err instanceof LfError) return c.json(errBody(err.code, err.message, err.details), err.status as 400);
    if (err instanceof ZodError) return c.json(errBody("bad_request", "validation failed", err.issues), 400);
    if (err instanceof SyntaxError) return c.json(errBody("bad_request", `invalid JSON: ${err.message}`), 400);
    lf.log.error("unhandled error", { path: c.req.path, error: err });
    return c.json(errBody("internal", "internal error"), 500);
  });
  app.notFound((c) => c.json(errBody("not_found", `no route ${c.req.method} ${c.req.path}`), 404));

  app.get("/health", (c) => c.json({ ok: true, protocol: PROTOCOL_ID, games: [...lf.games.keys()], llm: !!lf.providers.llm, stt: lf.providers.stt?.id ?? null }));

  // dashboard static files at /dashboard (K5); no auth - it asks for the admin key itself. "/" redirects there
  // unless a game is served at "/" (LIVEFORGE_STATIC_DIR, registered last).
  app.route("/", dashboardRoutes(undefined, { rootRedirect: !lf.config.staticDir }));

  // ---------------------------------------------------------------- auth: /v1/* (SDK or admin key)
  app.use("/v1/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const key = keyFrom(c);
    const who = lf.authenticate(key, c.req.header(HEADERS.game) ?? c.req.query("game") ?? null);
    if (!who) return c.json(errBody("unauthorized", "missing or invalid key (Authorization: Bearer <publishable key>)"), 401);
    // per client: every player shares the game's publishable key, so the bucket is key + client IP
    if (!who.admin && !lf.rateLimit(`${key}|${clientIp(c, lf.config.trustProxy)}`)) return c.json(errBody("rate_limited", `over ${lf.config.rateLimitPerMin} requests/min`), 429);
    c.set("game", who.game);
    c.set("admin", who.admin);
    c.set("key", key!);
    await next();
  });

  app.get("/v1/config", (c) => c.json(lf.publicConfig(c.get("game"))));

  app.post("/v1/signals", async (c) => c.json(lf.ingestSignals(c.get("game"), await c.req.json())));

  app.post("/v1/ask/:kind{.+}", async (c) => c.json(await lf.ask(c.get("game"), c.req.param("kind"), await c.req.json())));

  app.get("/v1/upgrades/:id", async (c) => {
    const wait = Math.min(30, Math.max(0, Number(c.req.query("wait") ?? 25))) * 1000;
    const r = await lf.waitUpgrade(c.get("game"), c.req.param("id"), wait);
    return r ? c.json(r) : c.body(null, 204);
  });

  // Brain feed history (live entries arrive over WS {t:"brain"}): ?world= (required), ?after=<entry id>, ?limit=
  app.get("/v1/brain", (c) => {
    const world = c.req.query("world");
    if (!world) throw new LfError("bad_request", "?world= is required");
    const limit = Math.max(1, Math.min(300, Number(c.req.query("limit") ?? 300) || 300));
    return c.json(lf.brainBuffer.page(c.get("game"), world, c.req.query("after") ?? null, limit));
  });

  app.get("/v1/ws", (c) => c.json(errBody("bad_request", "WebSocket endpoint: connect with an Upgrade: websocket request"), 426 as 400));

  app.post("/v1/stt", async (c) => {
    const stt = lf.providers.stt;
    if (!stt) throw new LfError("provider_unavailable", "no STT provider configured (set OPENAI_API_KEY or WHISPER_CPP_BIN + WHISPER_CPP_MODEL)");
    // STT is paid per call and not covered by the LLM budgets: cap it per client per minute and per game per day.
    const { perMin, perDay } = lf.config.stt;
    if (!c.get("admin") && !lf.rateLimit(`stt|${c.get("key")}|${clientIp(c, lf.config.trustProxy)}`, perMin)) {
      throw new LfError("rate_limited", `over ${perMin} transcriptions/min; type instead or wait a moment`);
    }
    if (perDay > 0) {
      const today = new Date().toISOString().slice(0, 10);
      if (sttDay.day !== today) {
        sttDay.day = today;
        sttDay.n.clear();
      }
      const n = sttDay.n.get(c.get("game")) ?? 0;
      if (n >= perDay) throw new LfError("rate_limited", `over ${perDay} transcriptions today for this game`);
      sttDay.n.set(c.get("game"), n + 1);
    }
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
    if (audio.byteLength > lf.config.stt.maxBytes) throw new LfError("bad_request", `audio larger than ${lf.config.stt.maxBytes} bytes`);
    const game = c.get("game");
    const m = lf.game(game).manifest;
    const hint = [...m.personas.map((p) => p.name), ...Object.keys(m.lore.glossary)].join(", ");
    try {
      const r = await stt.transcribe({ audio, mimeType: mime, language: c.req.query("language") ?? undefined, prompt: hint || undefined });
      const v = await lf.moderator.check(r.text, { direction: "input", manifest: m });
      return c.json({ id: `stt_${Date.now().toString(36)}`, text: r.text, language: r.language, durationMs: r.durationMs, provider: stt.id, flagged: !v.ok });
    } catch (e) {
      throw new LfError("provider_error", `STT failed: ${(e as Error).message.slice(0, 200)}`);
    }
  });

  app.get("/v1/forge/jobs/:id", (c) => {
    const job = lf.jobs.get(c.req.param("id"), c.get("game"));
    if (!job) throw new LfError("not_found", "no such job");
    return c.json(job);
  });

  app.get("/v1/assets/:file", (c) => {
    const file = c.req.param("file");
    if (!/^[A-Za-z0-9_\-]+\.glb$/.test(file)) throw new LfError("bad_request", "bad asset name");
    const path = join(lf.jobs.assetsDir, file);
    if (!existsSync(path)) throw new LfError("not_found", "no such asset");
    return c.body(readFileSync(path), 200, { "content-type": "model/gltf-binary", "cache-control": "public, max-age=31536000, immutable" });
  });

  app.get("/v1/snapshot", (c) => {
    const world = c.req.query("world");
    if (!world) throw new LfError("bad_request", "?world= is required");
    return c.json(lf.exportSnapshot(c.get("game"), world));
  });
  app.post("/v1/snapshot", async (c) => c.json(lf.importSnapshot(c.get("game"), await c.req.json(), c.req.query("world") ?? undefined)));

  // module public routes: /v1/m/<id>/*
  for (const m of modules) {
    if (!m.routes?.public) continue;
    app.use(`/v1/m/${m.id}/*`, async (c, next) => {
      if (!moduleEnabled(lf.game(c.get("game")).manifest, m.id)) return c.json(errBody("module_disabled", `module ${m.id} is disabled for this game`), 409);
      await next();
    });
    app.route(`/v1/m/${m.id}`, m.routes.public);
  }

  // ---------------------------------------------------------------- admin
  app.use("/admin/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const key = keyFrom(c);
    const who = lf.authenticate(key, c.req.header(HEADERS.game) ?? c.req.query("game") ?? null);
    if (!who?.admin) return c.json(errBody(who ? "forbidden" : "unauthorized", "admin key required"), who ? 403 : 401);
    c.set("game", who.game);
    c.set("admin", true);
    c.set("key", key!);
    await next();
  });
  app.route("/admin", adminRoutes(lf, { parseManifest, validateManifestObject, SimulateRequest }));
  app.route("/admin", dashboardAdminRoutes(lf));
  app.route("/admin", cassetteAdminRoutes());
  for (const m of modules) if (m.routes?.admin) app.route(`/admin/m/${m.id}`, m.routes.admin);

  // ---------------------------------------------------------------- a web game at "/" (LIVEFORGE_STATIC_DIR), last
  if (lf.config.staticDir) {
    if (!existsSync(join(lf.config.staticDir, "index.html"))) lf.log.warn("LIVEFORGE_STATIC_DIR has no index.html; / will 404", { dir: lf.config.staticDir });
    else lf.log.info("serving a web game at /", { dir: lf.config.staticDir });
    app.get("*", staticHandler(lf.config.staticDir));
  }

  return app;
}

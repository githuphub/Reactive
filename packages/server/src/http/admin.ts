// /admin/* routes for the dashboard (K5) and tooling. Admin key required (checked in app.ts).
import { Hono } from "hono";
import type { SimulateRequest as SimulateRequestSchema } from "@liveforge/protocol";
import type { parseManifest as ParseManifest, validateManifestObject as ValidateManifestObject } from "@liveforge/manifest";
import { moduleEnabled } from "@liveforge/manifest";
import { LfError } from "../errors.js";
import type { Liveforge } from "../core/runtime.js";
import type { LfEnv } from "../module.js";

export function adminRoutes(
  lf: Liveforge,
  deps: { parseManifest: typeof ParseManifest; validateManifestObject: typeof ValidateManifestObject; SimulateRequest: typeof SimulateRequestSchema },
): Hono<LfEnv> {
  const r = new Hono<LfEnv>();
  const int = (v: string | undefined) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

  r.get("/games", (c) => c.json({
    games: [...lf.games.values()].map((g) => ({
      id: g.id,
      name: g.manifest.game.name,
      manifestPath: g.manifestPath,
      modules: Object.fromEntries(Object.keys(g.manifest.modules).map((m) => [m, moduleEnabled(g.manifest, m)])),
      worlds: lf.events.worlds(g.id).length,
      warnings: g.warnings,
    })),
  }));

  // ---- manifest
  r.get("/manifest", (c) => c.json(lf.game(c.get("game")).manifest));
  r.post("/manifest/validate", async (c) => {
    const ct = c.req.header("content-type") ?? "";
    const result = ct.includes("json") ? deps.validateManifestObject(await c.req.json()) : deps.parseManifest(await c.req.text());
    return c.json(result.ok ? { ok: true, errors: [], warnings: result.warnings } : { ok: false, errors: result.errors, warnings: result.warnings });
  });
  r.post("/manifest/reload", async (c) => {
    const text = (c.req.header("content-type") ?? "").includes("yaml") || (c.req.header("content-type") ?? "").startsWith("text/") ? await c.req.text() : undefined;
    const res = await lf.reloadManifest(c.get("game"), text);
    return c.json(res, res.ok ? 200 : 422);
  });

  // ---- tenancy + log
  r.get("/worlds", (c) => c.json({ worlds: lf.events.worlds(c.get("game")) }));
  r.get("/players", (c) => c.json({ players: lf.events.players(c.get("game"), c.req.query("world")) }));
  r.get("/events", (c) => {
    const limit = Math.min(int(c.req.query("limit")) ?? 200, 2000);
    const desc = c.req.query("desc") === "1" || c.req.query("desc") === "true";
    const events = lf.events.query({
      game: c.get("game"), world: c.req.query("world"), player: c.req.query("player"), type: c.req.query("type"),
      after: int(c.req.query("after")), before: int(c.req.query("before")), limit, desc,
    });
    const next = events.length === limit ? events[events.length - 1].seq : null;
    return c.json({ events, next });
  });

  // ---- projections
  r.get("/projections", (c) => c.json({ projections: lf.projections.names(c.get("game")) }));
  r.get("/projections/:name", (c) => {
    const game = c.get("game");
    const name = c.req.param("name");
    const world = c.req.query("world");
    if (!world) throw new LfError("bad_request", "?world= is required");
    const scope = lf.projections.scopeOf(game, name);
    if (!scope) throw new LfError("not_found", `unknown projection "${name}" (module disabled?)`);
    const player = c.req.query("player");
    if (scope === "player" && !player) {
      return c.json({ name, scope, world, players: Object.fromEntries(lf.projections.all(game, name, world).map((x) => [x.player, x.state])) });
    }
    return c.json({ name, scope, world, player: player ?? null, state: lf.projections.get(game, name, world, player) });
  });
  r.post("/rebuild", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { world?: string };
    return c.json(lf.projections.rebuild(c.get("game"), body.world));
  });
  r.get("/directives", (c) => {
    const world = c.req.query("world");
    if (!world) throw new LfError("bad_request", "?world= is required");
    return c.json(lf.projections.get(c.get("game"), "core.directives", world));
  });

  // ---- stats
  r.get("/stats", (c) => {
    const game = c.get("game");
    const since = int(c.req.query("since")) ?? Date.now() - 86_400_000;
    return c.json({
      game,
      since,
      modules: lf.metrics.stats(game, since),
      budgets: { game: lf.budgets.snapshot(game, lf.game(game).manifest) },
      cache: { entries: lf.cacheStore.count(game), hits: lf.cacheStore.hits, misses: lf.cacheStore.misses },
      ws: { connections: lf.hub.count(game) },
    });
  });

  // ---- jobs
  r.get("/jobs", (c) => c.json({ jobs: lf.jobs.list(c.get("game")) }));

  // ---- review / bake
  r.get("/review", (c) => c.json({ items: lf.listReview(c.get("game"), c.req.query("status")) }));
  r.post("/review", async (c) => {
    const body = (await c.req.json()) as { kind?: string; payload?: unknown; note?: string };
    if (!body.kind || body.payload === undefined) throw new LfError("bad_request", "{kind, payload} required");
    return c.json(lf.enqueueReview(c.get("game"), body.kind, body.payload, body.note));
  });
  r.post("/review/:id", async (c) => {
    const body = (await c.req.json()) as { status?: string; note?: string };
    if (!body.status || !["pending", "approved", "rejected"].includes(body.status)) throw new LfError("bad_request", "status must be pending | approved | rejected");
    lf.setReview(c.get("game"), c.req.param("id"), body.status as "approved", body.note);
    return c.json({ ok: true });
  });
  r.get("/bake", (c) => c.json(lf.bakePack(c.get("game"))));

  // ---- simulate
  r.get("/simulate/presets", (c) => c.json({ presets: lf.simulatePresets() }));
  r.post("/simulate", async (c) => {
    const req = deps.SimulateRequest.parse(await c.req.json());
    return c.json(lf.simulate(c.get("game"), req));
  });

  return r;
}

// K7: record / replay cassette admin routes (mounted at /admin; the admin-key middleware guards them).
//   GET  /admin/cassettes?limit=          -> CassetteStatus + {cassettes: CassetteSummary[]}
//   POST /admin/cassettes/mode {mode}     -> switch live | record | replay at runtime (409 without an API key)
//   POST /admin/cassettes/reload          -> re-read the cassettes directory
import { Hono } from "hono";
import { LfError } from "../errors.js";
import type { LfEnv } from "../module.js";
import { cassettes, PROVIDER_MODES, type ProviderMode } from "../providers/cassette.js";

export function cassetteAdminRoutes(): Hono<LfEnv> {
  const r = new Hono<LfEnv>();

  r.get("/cassettes", (c) => {
    const store = cassettes();
    const limit = Math.max(1, Math.min(2000, Number(c.req.query("limit") ?? 200) || 200));
    return c.json({ ...store.status(), cassettes: store.list(limit) });
  });

  r.post("/cassettes/mode", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { mode?: string };
    const mode = String(body.mode ?? "").toLowerCase();
    if (!(PROVIDER_MODES as readonly string[]).includes(mode)) throw new LfError("bad_request", `mode must be one of ${PROVIDER_MODES.join(", ")}`);
    try {
      cassettes().setMode(mode as ProviderMode);
    } catch (e) {
      throw new LfError("provider_unavailable", (e as Error).message);
    }
    return c.json(cassettes().status());
  });

  r.post("/cassettes/reload", (c) => {
    cassettes().load();
    return c.json(cassettes().status());
  });

  return r;
}

// Extra /admin/* routes the dashboard uses, added by K5 (additive; mounted next to http/admin.ts). The admin-key
// middleware in http/app.ts already guards every /admin/* path.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { Hono } from "hono";
import { LfError } from "../errors.js";
import type { Liveforge } from "../core/runtime.js";
import type { LfEnv } from "../module.js";

export function dashboardAdminRoutes(lf: Liveforge): Hono<LfEnv> {
  const r = new Hono<LfEnv>();

  /** GET /admin/manifest/source -> { filename, yaml } (the raw liveforge.yaml, for the dashboard validator). */
  r.get("/manifest/source", (c) => {
    const rt = lf.game(c.get("game"));
    if (!rt.manifestPath) throw new LfError("not_found", "this game was loaded without a manifest file");
    let yaml: string;
    try {
      yaml = readFileSync(rt.manifestPath, "utf8");
    } catch (e) {
      throw new LfError("not_found", `cannot read ${basename(rt.manifestPath)}: ${(e as Error).message}`);
    }
    return c.json({ filename: basename(rt.manifestPath), yaml });
  });

  return r;
}

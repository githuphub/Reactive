// LIVEFORGE_STATIC_DIR: serve a built web game (e.g. examples/livecraft/dist) at "/" from the same process, so one
// URL is the game, the API (/v1), the WebSocket (/v1/ws) and the dashboard (/dashboard). Registered after every
// other route: API, admin, dashboard and health paths are never shadowed.
import { existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { Context } from "hono";
import { sendFile } from "../admin/dashboard.js";
import type { LfEnv } from "../module.js";

const RESERVED = /^\/(v1|admin|dashboard|health)(\/|$)/;

/**
 * GET handler for `app.get("*", ...)`:
 * - real files: `/assets/*` (hashed build output) immutable for a year, index.html no-cache, others 1 hour;
 * - unknown paths without a file extension: index.html (SPA fallback);
 * - reserved prefixes and missing files with an extension: the app's JSON 404.
 */
export function staticHandler(dir: string) {
  const root = resolve(dir);
  const index = join(root, "index.html");
  const html = (file: string) => sendFile(file, "no-cache");
  return (c: Context<LfEnv>) => {
    const path = c.req.path;
    if (RESERVED.test(path)) return c.notFound();
    let rel: string;
    try {
      rel = decodeURIComponent(path).replace(/^\/+/, "");
    } catch {
      return c.notFound();
    }
    if (rel) {
      const file = normalize(join(root, rel));
      if (!file.startsWith(root + sep) || rel.includes("\0")) return c.notFound();
      if (existsSync(file) && statSync(file).isFile()) {
        if (file === index) return html(file);
        return sendFile(file, /^assets\//.test(rel.replace(/\\/g, "/")) ? "public, max-age=31536000, immutable" : extname(file) === ".html" ? "no-cache" : "public, max-age=3600");
      }
      if (extname(rel)) return c.notFound();
    }
    if (!existsSync(index)) return c.notFound();
    return html(index);
  };
}

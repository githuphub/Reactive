// Serves the built dashboard (packages/dashboard/dist) at /dashboard, and redirects / there. Static files only: the
// dashboard asks for the admin key itself and talks to /admin/* + the admin WebSocket. Added by K5.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { LfEnv } from "../module.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".glb": "model/gltf-binary",
  ".map": "application/json",
};

/** Where the dashboard build lives: LIVEFORGE_DASHBOARD_DIR, else packages/dashboard/dist next to this package. */
export function dashboardDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LIVEFORGE_DASHBOARD_DIR) return resolve(env.LIVEFORGE_DASHBOARD_DIR);
  // works from both src/admin (tsx) and dist/admin (node)
  return fileURLToPath(new URL("../../../dashboard/dist", import.meta.url));
}

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>Liveforge dashboard</title>
<body style="background:#07080c;color:#e8ebf2;font:15px system-ui;display:grid;place-content:center;height:100vh;margin:0">
<h2>The dashboard is not built yet</h2><p>Run <code>npm run build</code> (or <code>npm run build -w @liveforge/dashboard</code>) and reload.</p></body>`;

/** Mount with app.route("/", dashboardRoutes()). */
export function dashboardRoutes(dir = dashboardDir()): Hono<LfEnv> {
  const r = new Hono<LfEnv>();
  const root = normalize(dir);
  const send = (file: string) => {
    const body = readFileSync(file);
    const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
    const immutable = /[\/]assets[\/]/.test(file);
    return new Response(body, { headers: { "content-type": type, "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" } });
  };
  r.get("/", (c) => c.redirect("/dashboard/"));
  r.get("/dashboard", (c) => c.redirect("/dashboard/"));
  r.get("/dashboard/*", (c) => {
    const index = join(root, "index.html");
    if (!existsSync(index)) return c.html(NOT_BUILT, 503);
    const rel = decodeURIComponent(c.req.path.replace(/^\/dashboard\/?/, ""));
    const file = normalize(join(root, rel));
    if (rel && file.startsWith(root) && existsSync(file) && statSync(file).isFile()) return send(file);
    return send(index); // SPA fallback (the dashboard routes with #hash, so this is mostly "/dashboard/")
  });
  return r;
}

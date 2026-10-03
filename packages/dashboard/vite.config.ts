// Vite config for the Liveforge dashboard. `npm run dev -w @liveforge/dashboard` serves it on :5173 and proxies
// the admin API + WebSocket to a local server (LIVEFORGE_URL, default http://localhost:8787). `npm run build`
// writes static files to dist/, which the server serves at /dashboard.
import { defineConfig } from "vite";

const target = process.env.LIVEFORGE_URL ?? "http://localhost:8787";

export default defineConfig({
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 1200 },
  server: {
    port: 5173,
    fs: { allow: ["../.."] },
    proxy: {
      "/admin": { target, changeOrigin: true },
      "/v1": { target, changeOrigin: true, ws: true },
    },
  },
});

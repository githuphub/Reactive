import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { defineConfig, searchForWorkspaceRoot } from 'vite';

/**
 * Liveforge packages are linked into node_modules by scripts/link-liveforge.mjs (runs before dev / build /
 * typecheck). They live outside this repo, so the dev server must be allowed to serve them, and three must stay
 * one instance (@liveforge/three imports it too).
 */
function liveforgeRoot(): string | null {
  try {
    const entry = createRequire(import.meta.url).resolve('@liveforge/sdk');
    return path.resolve(fs.realpathSync(entry), '../../../..');
  } catch {
    return null;
  }
}
const lfRoot = liveforgeRoot();

export default defineConfig({
  server: {
    port: 5180,
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), ...(lfRoot ? [lfRoot] : [])] },
  },
  preview: { port: 5180 },
  resolve: { dedupe: ['three'] },
  optimizeDeps: lfRoot ? { include: ['@liveforge/sdk', '@liveforge/three'] } : {},
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});

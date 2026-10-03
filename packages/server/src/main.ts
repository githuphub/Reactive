#!/usr/bin/env node
// CLI entry: `npm run dev` / `npm start` / `liveforge-server`. Configuration comes from env (see .env.example).
import { existsSync, readFileSync } from "node:fs";
import { ManifestError } from "@liveforge/manifest";
import { createLiveforgeServer } from "./server.js";

// Minimal .env loader (KEY=VALUE lines; existing env wins). Never logs values.
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

try {
  const s = await createLiveforgeServer();
  await s.listen();
  const shutdown = async (sig: string) => {
    console.log(`\n${sig}: shutting down`);
    await s.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
} catch (e) {
  if (e instanceof ManifestError) console.error(e.message);
  else console.error(e);
  process.exit(1);
}

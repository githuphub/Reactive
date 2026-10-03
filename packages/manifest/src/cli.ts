#!/usr/bin/env node
// liveforge-validate <file...>: validate manifests, print issues with line numbers, exit 1 on errors.
import { readFileSync } from "node:fs";
import { parseManifest, formatIssues } from "./validate.js";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: liveforge-validate <liveforge.yaml> [more.yaml ...]");
  process.exit(2);
}
let failed = false;
for (const f of files) {
  const r = parseManifest(readFileSync(f, "utf8"), { filename: f });
  if (r.warnings.length) console.warn(formatIssues(r.warnings, f));
  if (r.ok) console.log(`${f}: ok (${r.manifest.game.id}, ${r.manifest.personas.length} personas, ${r.manifest.bosses.length} bosses)`);
  else {
    failed = true;
    console.error(formatIssues(r.errors, f));
  }
}
process.exit(failed ? 1 : 0);

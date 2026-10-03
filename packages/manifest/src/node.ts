// Node-only helpers: load liveforge.yaml from disk.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { ManifestError, parseManifest, formatIssues, type ManifestIssue } from "./validate.js";
import type { Manifest } from "./schema.js";

/** Load + validate a manifest file. Throws ManifestError (with every issue, line numbers included) when invalid. */
export function loadManifest(path: string): { manifest: Manifest; warnings: ManifestIssue[] } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ManifestError([{ path: "(file)", message: `cannot read ${path}: ${(e as Error).message}`, severity: "error" }], basename(path));
  }
  const r = parseManifest(text, { filename: path });
  if (!r.ok) throw new ManifestError(r.errors, path);
  return { manifest: r.manifest, warnings: r.warnings };
}

export { formatIssues };

// Build step: JSON Schema for liveforge.yaml (editors: `# yaml-language-server: $schema=<path>/liveforge.schema.json`).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ManifestSchema } from "./schema.js";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "schema");
mkdirSync(out, { recursive: true });
const json = z.toJSONSchema(ManifestSchema, { target: "draft-2020-12", io: "input", unrepresentable: "any" }) as Record<string, unknown>;
json.$id = "https://liveforge.dev/schema/v1/liveforge.schema.json";
json.title = "Liveforge manifest (liveforge.yaml)";
writeFileSync(join(out, "liveforge.schema.json"), JSON.stringify(json, null, 2) + "\n");
console.log(`[manifest] wrote ${join(out, "liveforge.schema.json")}`);

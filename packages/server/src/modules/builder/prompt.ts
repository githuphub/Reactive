// Builder prompts: a stable system prompt that teaches the Voxel DSL with two compact examples (plus lore, tone,
// safety and the game's block ids), and a per-request user message (prompt, site, palette, style, context).
import { VOXEL_OPS, type AskParams } from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";
import { loreBlock, personaLine, safetyBlock } from "../agents/lore.js";

const EXAMPLE_HOUSE = `{"name":"Cosy cottage","summary":"A snug oak cottage with a brick gable roof.",
 "palette":[{"key":"wall","block":"oak_planks"},{"key":"trim","block":"spruce_log"},{"key":"roof","block":"bricks"}],
 "ops":[{"op":"hollow_box","from":[1,0,1],"to":[7,4,6],"block":"wall"},
  {"op":"edges","from":[1,0,1],"to":[7,4,6],"block":"trim"},
  {"op":"fill_air","from":[2,1,2],"to":[6,3,5]},
  {"op":"roof","style":"gable","from":[0,5,0],"to":[8,5,7],"block":"roof"},
  {"op":"door","at":[4,1,1],"facing":"north"},
  {"op":"repeat","count":3,"step":[2,0,0],"ops":[{"op":"window","at":[2,2,6],"block":"glass"}]},
  {"op":"mirror","axis":"x","at":4,"ops":[{"op":"window","at":[1,2,3],"block":"glass"}]},
  {"op":"block","at":[2,1,2],"block":"torch"}]}`;

const EXAMPLE_TOWER = `{"name":"Watchtower","summary":"A round stone watchtower with battlements.",
 "palette":[{"key":"stone","block":"stone_bricks"}],
 "ops":[{"op":"cylinder","center":[3,0,3],"radius":3,"height":12,"hollow":true,"block":"stone"},
  {"op":"cylinder","center":[3,11,3],"radius":2,"height":1,"block":"oak_planks"},
  {"op":"door","at":[3,1,0],"facing":"north"},
  {"op":"stairs","from":[1,1,2],"to":[1,10,2],"block":"oak_planks"},
  {"op":"cylinder","center":[3,12,3],"radius":3,"height":1,"hollow":true,"block":"stone"}]}`;

/** Stable system prompt (manifest-dependent only). */
export function builderSystem(m: Manifest): string {
  const ids = m.builder.blockIds?.length ? m.builder.blockIds.join(", ") : "";
  return [
    "You design buildings for a blocky voxel world as a Voxel DSL build plan (JSON). Builders place your blocks layer by layer, so plans must be sturdy, readable and charming.",
    "",
    "Voxel DSL:",
    "- Coordinates are integers [x,y,z] relative to the plot origin; y=0 is the ground/floor layer; +x east, +z south, -z (north) is the front. Corners are inclusive.",
    `- Ops: ${VOXEL_OPS.join(", ")}.`,
    "  box / hollow_box (shell incl. floor and ceiling) / edges (12 edges) / line / stairs / fill_air: from, to (+ block; fill_air has none).",
    "  cylinder: center (bottom centre), radius, height, hollow?. sphere: center, radius, hollow?.",
    "  roof: style gable|hip|flat over the from-to footprint at from.y (gable ridge along the longer axis unless axis x|z).",
    "  door: at (lower half; cuts a 2-tall opening), facing north|south|east|west. window: at (one block, default glass). block: at + block (torches, chests).",
    "  repeat: count, step, ops (each copy offset by step*i). mirror: axis x|z, at (plane coordinate, .5 allowed), ops (adds a mirrored copy).",
    "- block = a palette key or a block id. Later ops overwrite earlier ones. Use fill_air to hollow interiors.",
    "- Every op object in your answer carries every field; set the ones an op does not use to null. Nested ops (inside repeat/mirror) cannot nest again.",
    ids ? `- Use only these block ids: ${ids}.` : "- Use simple block ids (oak_planks, spruce_log, cobblestone, stone_bricks, bricks, glass, torch, door, wool colours ...).",
    "- Stay inside the plot. Keep it under about 50 ops and the block budget. Give it a short evocative name and a one-sentence summary.",
    m.builder.styleGuide ? `- House style: ${m.builder.styleGuide}` : "",
    "",
    "Example (house on a 9x12x8 plot):",
    EXAMPLE_HOUSE,
    "",
    "Example (tower on a 7x14x7 plot):",
    EXAMPLE_TOWER,
    "",
    loreBlock(m, 3000),
    "",
    "Rules:",
    safetyBlock(m),
  ].filter((l) => l !== "").join("\n");
}

/** Per-request user message. */
export function builderUser(m: Manifest, p: AskParams<"builder.plan">, palette: readonly string[], template: string): string {
  const [x, y, z] = p.site.size;
  const persona = personaLine(m, p.npc);
  return [
    persona ? `${persona} Design this the way you would build it.` : "",
    `Build: ${p.prompt}`,
    `Plot: ${x} wide (x 0..${x - 1}), ${z} deep (z 0..${z - 1}), ${y} tall (y 0..${y - 1}).${p.site.ground ? ` Ground: ${p.site.ground}.` : ""}`,
    palette.length ? `Preferred blocks (wall, trim, roof, floor, glass, accent): ${palette.join(", ")}.` : "",
    p.style ? `Style: ${p.style}.` : "",
    `Block budget: ${m.builder.maxBlocks}.`,
    p.context ? `Context: ${p.context}` : "",
    `(The rules fallback would build the "${template}" template; do better.)`,
  ].filter(Boolean).join("\n");
}

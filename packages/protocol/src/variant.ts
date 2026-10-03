// Variant v1 (spec §3.5): a modification of a developer-authored asset (glTF / scene) instead of a generated model.
// The game resolves `baseAsset` to its own asset; SDKs apply the swaps by material-slot / node name.
import { z } from "zod";
import { Hex, Vec3 } from "./common.js";
import { Blueprint, Material } from "./blueprint.js";
import { VfxRecipe } from "./vfx.js";

export const Variant = z.object({
  v: z.literal(1),
  /** Developer asset id (as declared in the manifest item / persona schema, or any id the game understands). */
  baseAsset: z.string().min(1).max(128),
  name: z.string().max(64).optional(),
  /** Replace materials by slot / material name ("*" = every slot). */
  materialSwaps: z.array(z.object({ slot: z.string().max(64), material: Material })).default([]),
  /** Hue-preserving recolour: map a palette role or exact colour to a new colour. */
  recolour: z.array(z.object({ from: z.union([Hex, z.enum(["primary", "secondary", "trim", "accent"])]), to: Hex })).optional(),
  /** Projected decals / emblems. */
  decals: z.array(z.object({
    /** Glyph name the SDK knows ("skull", "sun", "rune_1", faction emblem id) or a texture asset id. */
    glyph: z.string().max(64),
    /** Node / bone / attachment to project onto. */
    on: z.string().max(64).optional(),
    position: Vec3.optional(),
    size: z.number().positive().max(4),
    color: Hex.optional(),
  })).optional(),
  /** Uniform or per-axis scale (0.5-2). */
  scale: z.union([z.number(), Vec3]).optional(),
  /** Show / hide nodes or blueprint parts by name / id / role. */
  partToggles: z.record(z.string(), z.boolean()).optional(),
  /** Extra generated pieces bolted on (e.g. a horned helm on an NPC). */
  attachments: z.array(z.object({ point: z.string().max(64), blueprint: Blueprint })).optional(),
  vfx: z.array(VfxRecipe).optional(),
  tags: z.array(z.string()).optional(),
});
export type Variant = z.infer<typeof Variant>;
export type VariantInput = z.input<typeof Variant>;

// Grip + attachment guards (ported from Counterforge validate.ts gripGuard): an LLM-styled or LLM-shaped held model
// must keep the hand at the origin and the tip toward +Y, whatever the model did.
import { partHalfHeight, partsBounds, type RawModel, type RawPart } from "./model.js";

/**
 * Library families held at the bottom end (the hand sits at y ~ 0). Bows / crossbows / guns / cannons / thrown items
 * keep the authored mid-model grip; fist and focus items are authored around the hand and are left alone.
 */
const BOTTOM_GRIP: ReadonlySet<string> = new Set([
  "dagger", "sword", "greatsword", "axe", "hammer", "spear", "scythe", "whip", "staff", "shield_small", "shield_large",
]);

const partBottom = (p: RawPart): number => p.offset[1] - partHalfHeight(p);

/**
 * Grip guard for bottom-held template families: a model whose lowest point is more than 10 % of its extent below
 * y = 0 (e.g. an LLM shape centred on the origin, which would put the hand mid-blade) is shifted up so the handle's
 * bottom (or, without a handle, the model's bottom) sits at y = 0. Mutates and returns `m`.
 */
export function gripGuard(m: RawModel, template: string): RawModel {
  if (!BOTTOM_GRIP.has(template) || m.parts.length === 0) return m;
  const b = partsBounds(m.parts);
  const extent = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  const minY = Math.min(...m.parts.map(partBottom));
  if (!(minY < -0.1 * extent)) return m;
  const handles = m.parts.filter((p) => p.role === "handle");
  const shift = -(handles.length ? Math.min(...handles.map(partBottom)) : minY);
  for (const p of m.parts) p.offset = [p.offset[0], p.offset[1] + shift, p.offset[2]];
  return m;
}

/**
 * Object guard (creatures / props): stand the model on y = 0 and centre it on X / Z, so `base` / `mount` attachment
 * points are where an engine expects them. Mutates and returns `m`.
 */
export function groundGuard(m: RawModel): RawModel {
  if (!m.parts.length) return m;
  const b = partsBounds(m.parts);
  // mirrored parts reflect about x = 0 / z = 0, so those axes are never shifted
  const dx = m.parts.some((p) => p.mirror === "x") ? 0 : -(b.min[0] + b.max[0]) / 2;
  const dz = m.parts.some((p) => p.mirror === "z") ? 0 : -(b.min[2] + b.max[2]) / 2;
  const dy = -b.min[1];
  if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3 && Math.abs(dz) < 1e-3) return m;
  for (const p of m.parts) p.offset = [p.offset[0] + dx, p.offset[1] + dy, p.offset[2] + dz];
  return m;
}

/** Worn guard (armour / accessories): centre the model on the origin (the socket). Mutates and returns `m`. */
export function centreGuard(m: RawModel): RawModel {
  if (!m.parts.length) return m;
  const b = partsBounds(m.parts);
  const d = [
    m.parts.some((p) => p.mirror === "x") ? 0 : -(b.min[0] + b.max[0]) / 2,
    -(b.min[1] + b.max[1]) / 2,
    m.parts.some((p) => p.mirror === "z") ? 0 : -(b.min[2] + b.max[2]) / 2,
  ];
  for (const p of m.parts) p.offset = [p.offset[0] + d[0], p.offset[1] + d[1], p.offset[2] + d[2]];
  return m;
}

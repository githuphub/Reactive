/**
 * Blueprints as Livecraft items: the spec (plan + expanded blocks, saved with the forge), live registration (scroll
 * icon tinted by the plan's main blocks, item, held voxel model) and lookup by item id.
 */
import type { VoxelBlock, VoxelPlan } from '@liveforge/sdk';
import { BLOCK, findBlock } from '../../engine/blocks';
import { findItem, registerItem } from '../../engine/items';
import { registerTexture } from '../../engine/textures';
import { heldMeshFactories } from '../../player/held-item';
import { blockColor } from '../../village/npc/effects';
import type { Pixels } from '../forge/pixel';
import { heldVoxelMesh } from '../forge/voxel-mesh';
import { paintScroll } from './icon';

/** A forged building blueprint as the game stores it (saved; re-registered on load). */
export interface LcBlueprint {
  /** Livecraft item id (`blueprint_<hash of the prompt>`). */
  id: string;
  name: string;
  prompt: string;
  summary: string;
  plan: VoxelPlan;
  /** Expanded with Livecraft block ids, relative to the site (y = 0 is the floor layer), in build order. */
  blocks: VoxelBlock[];
  /** block id → count (air excluded). */
  materials: Record<string, number>;
  /** Site size the plan was made for [x, y, z]. */
  site: [number, number, number];
  /** Main block colours [walls, roof, accent] (#rrggbb). */
  colors: string[];
  /** rules | ai | cache | bake | replay. */
  source: string;
  /** Times the plan was replaced (AI refinement). */
  version: number;
}

const blueprints = new Map<string, LcBlueprint>();
const pixels = new Map<string, Pixels>();

/** Deterministic item id for a prompt. */
export function blueprintId(prompt: string): string {
  let h = 0x811c9dc5;
  for (const c of prompt.trim().toLowerCase()) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return `blueprint_${(h >>> 0).toString(36)}`;
}

/** The blueprint behind an item id, if any. */
export function blueprintSpec(item: string | null | undefined): LcBlueprint | undefined {
  return item ? blueprints.get(item) : undefined;
}

/** Every blueprint so far (registration order). */
export function allBlueprints(): LcBlueprint[] {
  return [...blueprints.values()];
}

/** The icon pixels of a blueprint. */
export function blueprintPixels(id: string): Pixels | undefined {
  return pixels.get(id);
}

/** The top block colours of a materials table: [most used, second, third] as #rrggbb. */
export function mainColors(materials: Record<string, number>): string[] {
  const top = Object.entries(materials).sort((a, b) => b[1] - a[1]).map(([k]) => findBlock(k)).filter((d) => d && d.id !== BLOCK.air).slice(0, 3);
  return top.map((d) => `#${blockColor(d!.id).toString(16).padStart(6, '0')}`);
}

heldMeshFactories.push((name) => {
  const px = pixels.get(name);
  return px ? heldVoxelMesh(px) : null;
});

/**
 * Registers a blueprint item (texture + item + held model), or updates the spec of an already registered one (same
 * id: the plan is replaced in place, so the save order stays the same).
 */
export function registerBlueprint(bp: LcBlueprint): void {
  const known = blueprints.has(bp.id) || !!findItem(bp.id);
  blueprints.set(bp.id, bp);
  const seed = [...bp.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
  pixels.set(bp.id, paintScroll(bp.colors, seed));
  const def = findItem(bp.id);
  if (known) {
    // the hotbar label follows the refined name (the icon texture is painted once per id)
    if (def && def.displayName !== bp.name) (def as { displayName: string }).displayName = bp.name;
    return;
  }
  const icon = pixels.get(bp.id)!;
  const key = `blueprint/${bp.id}`;
  registerTexture(key, (t) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4;
      if (icon[i + 3] > 0) t.set(x, y, [icon[i], icon[i + 1], icon[i + 2]], icon[i + 3]);
    }
  }, { pad: 'clamp' });
  registerItem({ name: bp.id, displayName: bp.name, maxStack: 1, icon: key, tags: ['blueprint', 'forged'] });
}

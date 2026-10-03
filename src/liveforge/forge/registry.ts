/**
 * Forged items as Livecraft items: the spec (stats, effect, palette, pixels), live registration (texture, item,
 * held voxel model, recipe) and lookup by item id.
 */
import { findItem, registerItem, type ToolSpec } from '../../engine/items';
import { registerTexture } from '../../engine/textures';
import { heldMeshFactories } from '../../player/held-item';
import { registerRecipe } from '../../survival';
import { paintIcon, type Pixels, type ToolShape } from './pixel';
import { heldVoxelMesh } from './voxel-mesh';

/** The effect enum forged items may carry (manifest `items.tags`). */
export const EFFECTS = ['chain_lightning', 'fire_trail', 'vein_mine', 'knockback_burst', 'heal_aura', 'frost_slow'] as const;
export type ForgeEffect = (typeof EFFECTS)[number];

/** A forged item as the game stores it (saved; re-registered on load). */
export interface LcForged {
  /** Livecraft item id (`forged_<slug>_<n>`). */
  id: string;
  name: string;
  flavor: string;
  shape: ToolShape;
  kind: ToolSpec['kind'];
  tier: number;
  stats: { speed: number; damage: number; durability: number; mining: number };
  effect: ForgeEffect | null;
  /** main, handle, trim, glow (#rrggbb). */
  palette: [string, string, string, string];
  /** AI pixel grid (16 strings), when the forge returned one. */
  grid?: string[];
  /** Recipe pattern + key (item names). */
  recipe: { pattern: string[]; key: Record<string, string> };
  source: string;
  seed: number;
}

const forged = new Map<string, LcForged>();
const pixels = new Map<string, Pixels>();

/** The forged spec behind an item id, if any. */
export function forgedSpec(item: string | null | undefined): LcForged | undefined {
  return item ? forged.get(item) : undefined;
}

/** Every forged item so far (save order). */
export function allForged(): LcForged[] {
  return [...forged.values()];
}

/** The icon pixels of a forged item. */
export function forgedPixels(id: string): Pixels | undefined {
  return pixels.get(id);
}

heldMeshFactories.push((name) => {
  const px = pixels.get(name);
  return px ? heldVoxelMesh(px) : null;
});

/**
 * Registers a forged item (texture, item with tool stats, held voxel model, crafting recipe). Idempotent per id.
 * `px` overrides the rules icon (AI pixel grid).
 */
export function registerForged(spec: LcForged, px?: Pixels | null): void {
  if (forged.has(spec.id) || findItem(spec.id)) {
    forged.set(spec.id, spec);
    return;
  }
  const icon = px ?? paintIcon({ shape: spec.shape, main: spec.palette[0], handle: spec.palette[1], trim: spec.palette[2], glow: spec.palette[3], seed: spec.seed, sparks: spec.effect === 'chain_lightning' });
  pixels.set(spec.id, icon);
  forged.set(spec.id, spec);
  const key = `forged/${spec.id}`;
  registerTexture(key, (t) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4;
      if (icon[i + 3] > 0) t.set(x, y, [icon[i], icon[i + 1], icon[i + 2]], icon[i + 3]);
    }
  }, { pad: 'clamp' });
  registerItem({
    name: spec.id,
    displayName: spec.name,
    maxStack: 1,
    icon: key,
    tool: {
      kind: spec.kind,
      tier: spec.tier,
      speed: spec.kind === 'sword' ? 1.6 : Math.max(2, Math.min(14, 2 + spec.stats.speed * 0.6)),
      durability: Math.round(Math.max(40, Math.min(2000, spec.stats.durability))),
      damage: Math.round(Math.max(2, Math.min(14, spec.stats.damage * 0.7))),
    },
    tags: ['tool', 'forged', spec.kind, ...(spec.effect ? [spec.effect] : [])],
  });
  try {
    registerRecipe({ id: `forge_${spec.id}`, pattern: spec.recipe.pattern, key: spec.recipe.key, result: { item: spec.id } });
  } catch (err) {
    console.warn('[forge] recipe not registered', err);
  }
}

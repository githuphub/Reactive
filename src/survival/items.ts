/**
 * Survival items (bow, arrows, mob drops, meat, brick) with original procedural icons.
 *
 * Registered at module load (this module is imported by survival/plugin.ts, which plugin discovery
 * loads before the game is created), so saved inventories that hold these items restore cleanly.
 * Items are keyed by name, so registration order does not affect saves.
 */
import { findItem, registerItem, type ItemDef } from '../engine/items';
import { registerTexture } from '../engine/textures';
import { hex, line, type RGB } from '../engine/paint';

const ITEM = { pad: 'clamp' as const };

// -- icons ---------------------------------------------------------------------------------------

registerTexture(
  'bow',
  (t) => {
    const wood = hex('#7a5530'), woodHi = hex('#a47a46'), str = hex('#e6e6e6');
    // Limb: an arc from top-left to bottom-right, bulging towards the top-right.
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * Math.PI;
      const x = Math.round(2 + i + Math.sin(a) * 3.2);
      const y = Math.round(14 - i - Math.sin(a) * 3.2);
      t.put(x, y, i % 3 === 0 ? woodHi : wood);
      t.put(x - 1, y, wood);
    }
    line(t, 2, 14, 14, 2, str);
    t.put(8, 8, hex('#5a3a1a'));
  },
  ITEM,
);
registerTexture(
  'arrow',
  (t) => {
    line(t, 3, 12, 12, 3, hex('#8a6438'));
    t.rect(11, 2, 3, 3, hex('#9a9aa4'));
    t.put(13, 2, hex('#d8d8e0'));
    t.put(2, 12, hex('#f2f2f2'));
    t.put(3, 13, hex('#f2f2f2'));
    t.put(2, 13, hex('#c8c8c8'));
    t.put(1, 13, hex('#e0e0e0'));
    t.put(2, 14, hex('#e0e0e0'));
  },
  ITEM,
);
registerTexture(
  'leather',
  (t, rng) => {
    for (let y = 3; y < 14; y++)
      for (let x = 2; x < 14; x++) {
        const edge = Math.abs(x - 7.5) / 6 + Math.abs(y - 8.5) / 6.5;
        if (edge < 1 + Math.sin(x * 1.7 + y) * 0.06) t.set(x, y, rng() < 0.15 ? hex('#7d4a24') : edge > 0.85 ? hex('#6a3c1c') : hex('#985a2c'));
      }
  },
  ITEM,
);
registerTexture(
  'gunpowder',
  (t, rng) => {
    for (let i = 0; i < 70; i++) {
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng()) * 5.5;
      const x = Math.round(7.5 + Math.cos(a) * r);
      const y = Math.round(10 + Math.sin(a) * r * 0.55);
      t.put(x, y, rng() < 0.3 ? hex('#8a8a8a') : rng() < 0.5 ? hex('#4a4a4a') : hex('#636363'));
    }
  },
  ITEM,
);
registerTexture(
  'bone',
  (t) => {
    const c = hex('#ece6d2'), s = hex('#bdb59a');
    line(t, 4, 11, 11, 4, c);
    line(t, 5, 11, 12, 4, s);
    for (const [x, y] of [[3, 11], [4, 12], [3, 12], [11, 3], [12, 3], [12, 4]] as const) t.put(x, y, c);
    t.put(2, 11, s);
    t.put(4, 13, s);
    t.put(13, 4, s);
    t.put(11, 2, s);
  },
  ITEM,
);
registerTexture(
  'rotten_flesh',
  (t, rng) => {
    for (let y = 4; y < 13; y++)
      for (let x = 3; x < 13; x++) {
        const d = Math.hypot((x - 7.5) / 5, (y - 8.5) / 4.2);
        if (d < 1 + (rng() - 0.5) * 0.25) t.set(x, y, rng() < 0.25 ? hex('#5e7a3a') : rng() < 0.5 ? hex('#8a4a3a') : hex('#a85a42'));
      }
  },
  ITEM,
);

function meat(raw: RGB, fat: RGB, edge: RGB): (t: import('../engine/paint').Tile, rng: () => number) => void {
  return (t, rng) => {
    for (let y = 3; y < 14; y++)
      for (let x = 2; x < 14; x++) {
        const d = Math.hypot((x - 8) / 5.6, (y - 8) / 4.6);
        if (d < 1) t.set(x, y, d > 0.8 ? edge : rng() < 0.12 ? fat : raw);
      }
    line(t, 5, 6, 10, 10, fat);
  };
}
registerTexture('raw_porkchop', meat(hex('#e88a8a'), hex('#f8d4c8'), hex('#c86464')), ITEM);
registerTexture('cooked_porkchop', meat(hex('#c48850'), hex('#e8c08a'), hex('#8a5a2a')), ITEM);
registerTexture('raw_beef', meat(hex('#c83a32'), hex('#f0c8b8'), hex('#8a221e')), ITEM);
registerTexture('cooked_beef', meat(hex('#7a4a2a'), hex('#b07a4a'), hex('#4a2a14')), ITEM);
registerTexture(
  'brick',
  (t) => {
    for (let y = 6; y < 11; y++)
      for (let x = 2 + (y === 6 ? 1 : 0); x < 14 - (y === 10 ? 1 : 0); x++) t.set(x, y, y === 6 ? hex('#c8735a') : y === 10 ? hex('#7a3a2a') : hex('#a4503a'));
    t.put(4, 7, hex('#d88a6a'));
  },
  ITEM,
);

// -- items ---------------------------------------------------------------------------------------

/** Registers an item unless it already exists (keeps hot reload and other lanes safe). */
function ensure(spec: Parameters<typeof registerItem>[0]): ItemDef {
  return findItem(spec.name) ?? registerItem(spec);
}

ensure({ name: 'bow', maxStack: 1, tool: { kind: 'none', tier: 0, speed: 1, durability: 384, damage: 1 }, tags: ['weapon', 'ranged'] });
ensure({ name: 'arrow', tags: ['ammo'] });
ensure({ name: 'leather' });
ensure({ name: 'gunpowder' });
ensure({ name: 'bone' });
ensure({ name: 'brick' });
ensure({ name: 'rotten_flesh', food: { hunger: 4, saturation: 0.8 }, tags: ['food'] });
ensure({ name: 'raw_porkchop', displayName: 'Raw Porkchop', food: { hunger: 3, saturation: 1.8 }, tags: ['food', 'raw_meat'] });
ensure({ name: 'cooked_porkchop', displayName: 'Cooked Porkchop', food: { hunger: 8, saturation: 12.8 }, tags: ['food'] });
ensure({ name: 'raw_beef', displayName: 'Raw Beef', food: { hunger: 3, saturation: 1.8 }, tags: ['food', 'raw_meat'] });
ensure({ name: 'cooked_beef', displayName: 'Steak', food: { hunger: 8, saturation: 12.8 }, tags: ['food'] });

/** Summary of an item's survival stats (tier, durability and food value). */
export interface ItemInfo {
  name: string;
  displayName: string;
  maxStack: number;
  /** Tool tier (1 wood/gold, 2 stone, 3 iron, 4 diamond), 0 for non-tools. */
  tier: number;
  /** Uses before breaking, 0 for non-tools. */
  durability: number;
  /** Melee damage in half-hearts (1 for a bare hand / non-weapons). */
  damage: number;
  /** Hunger points restored, 0 if not food. */
  food: number;
  saturation: number;
  isBlock: boolean;
}

/** Survival stats of an item, or null for unknown names. */
export function itemInfo(name: string): ItemInfo | null {
  const d = findItem(name);
  if (!d) return null;
  return {
    name: d.name,
    displayName: d.displayName,
    maxStack: d.maxStack,
    tier: d.tool?.tier ?? 0,
    durability: d.tool?.durability ?? 0,
    damage: d.tool?.damage ?? 1,
    food: d.food?.hunger ?? 0,
    saturation: d.food?.saturation ?? 0,
    isBlock: d.block !== null,
  };
}

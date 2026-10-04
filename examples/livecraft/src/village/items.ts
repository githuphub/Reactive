/**
 * Village items: `coins`, the trading currency (an original gold-coin icon painted in code).
 * Registered from the plugin on the main thread only (items never reach the gen workers).
 */
import { findItem, registerItem } from '../engine/items';
import { hex } from '../engine/paint';
import { hasTexture, registerTexture } from '../engine/textures';

/** Item id of the village currency. */
export const COINS = 'coins';

/** Registers the coins item (idempotent). */
export function registerVillageItems(): void {
  if (!hasTexture(COINS)) {
    const rim = hex('#a8760e'), face = hex('#f6c945'), shine = hex('#fff1a8'), mark = hex('#c8901a');
    registerTexture(
      COINS,
      (t) => {
        // Two stacked coins.
        const coin = (cx: number, cy: number, r: number) => {
          for (let y = -r; y <= r; y++)
            for (let x = -r; x <= r; x++) {
              const d = Math.hypot(x, y * 1.15);
              if (d > r + 0.3) continue;
              t.put(cx + x, cy + y, d > r - 1 ? rim : face);
            }
          t.put(cx - 1, cy - 2, shine);
          t.put(cx - 2, cy - 1, shine);
          t.put(cx, cy, mark);
          t.put(cx + 1, cy, mark);
          t.put(cx, cy + 1, mark);
        };
        coin(6, 9, 4);
        coin(10, 6, 4);
      },
      { pad: 'clamp' },
    );
  }
  if (!findItem(COINS)) {
    try {
      registerItem({ name: COINS, displayName: 'Coins', icon: COINS, maxStack: 64, tags: ['currency'] });
    } catch {
      // Already registered by another module.
    }
  }
}

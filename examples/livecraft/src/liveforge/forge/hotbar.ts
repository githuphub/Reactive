/**
 * The forge's give path: a forged stack goes into the hotbar (replacing an earlier version of the same item, else
 * the first empty hotbar slot, else the selected slot, whose old stack moves into the inventory) and is selected.
 */
import type { Game } from '../../game/game';
import type { ItemStack } from '../../engine/items';

/** Puts `stack` in the hotbar (in place of `replaceId`'s stack when it is there) and selects it. Returns the slot. */
export function putInHotbar(game: Game, stack: ItemStack, replaceId?: string): number {
  const inv = game.inventory;
  let slot = replaceId ? inv.slots.findIndex((s) => s?.item === replaceId) : -1;
  if (slot < 0) slot = inv.slots.slice(0, 9).findIndex((s) => !s);
  if (slot < 0) {
    slot = inv.selected;
    const old = inv.get(slot);
    if (old) inv.add(old);
  }
  inv.set(slot, stack);
  if (slot < 9) inv.select(slot);
  return slot;
}

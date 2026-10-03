/**
 * Simple inventory helpers for other systems (trading, quests, forge rewards, agent tools).
 *
 * ```ts
 * giveItem(game, 'bread', 3);            // overflow drops at the player's feet
 * if (hasItem(game, 'emerald', 2)) takeItem(game, 'emerald', 2);
 * countItem(game, 'arrow');
 * ```
 */
import * as THREE from 'three';
import { findItem, type ItemStack } from '../engine/items';
import type { Game } from '../game/game';
import { dropItem } from './item-drops';

/**
 * Gives items to the player. Returns how many went into the inventory; the rest is dropped at
 * the player's feet unless `dropOverflow` is false.
 */
export function giveItem(game: Game, item: string | ItemStack, count = 1, opts: { dropOverflow?: boolean } = {}): number {
  const stack: ItemStack = typeof item === 'string' ? { item, count } : { ...item };
  const def = findItem(stack.item);
  if (!def) throw new Error(`giveItem: unknown item "${stack.item}"`);
  let given = 0;
  let left = stack.count;
  while (left > 0) {
    const n = Math.min(left, def.maxStack);
    const rest = game.inventory.add({ ...stack, count: n });
    given += n - rest;
    left -= n;
    if (rest > 0) {
      if (opts.dropOverflow !== false) {
        const p = game.player.position;
        dropItem(game, { ...stack, count: rest + left }, { x: p.x, y: p.y + 0.5, z: p.z }, { pickupDelay: 2 });
      }
      break;
    }
  }
  return given;
}

/** Total count of an item in the inventory. */
export function countItem(game: Game, item: string): number {
  return game.inventory.count(item);
}

/** True if the inventory holds at least `count` of an item. */
export function hasItem(game: Game, item: string, count = 1): boolean {
  return game.inventory.count(item) >= count;
}

/** Removes `count` of an item. All-or-nothing: returns false (and removes nothing) if short. */
export function takeItem(game: Game, item: string, count = 1): boolean {
  if (game.inventory.count(item) < count) return false;
  return game.inventory.remove(item, count);
}

/** Throws a stack from the player's hands in the look direction. */
export function throwFromPlayer(game: Game, stack: ItemStack): void {
  const eye = game.player.eye(new THREE.Vector3());
  const dir = game.player.lookDir(new THREE.Vector3());
  dropItem(game, stack, { x: eye.x + dir.x * 0.4, y: eye.y - 0.35, z: eye.z + dir.z * 0.4 }, {
    velocity: { x: dir.x * 5, y: dir.y * 5 + 1.5, z: dir.z * 5 },
    pickupDelay: 1.5,
  });
}

/**
 * Public survival API for V2 (trading, villager gifts) and V3 (forge, quests, Liveforge signals).
 *
 * ```ts
 * import { registerRecipe, giveItem, takeItem, hasItem, countItem, hurtPlayer, getHealth } from '../survival';
 * registerRecipe({ pattern: ['L', 'S', 'S'], key: { L: 'lightning_core', S: 'stick' }, result: { item: 'lightning_pickaxe' } });
 * giveItem(game, 'emerald', 3);
 * game.events.on('itemCrafted', (e) => …);
 * ```
 */
export * from './events';
export { itemInfo, type ItemInfo } from './items';
export {
  registerRecipe, unregisterRecipe, allRecipes, getRecipe, recipesFor, matchRecipe, matchesIngredient, onRecipeRegistered,
  registerSmelting, registerFuel, smeltingFor, fuelTime, allSmelting,
  type Recipe, type RecipeSpec, type ShapedRecipeSpec, type ShapelessRecipeSpec, type RecipeResult, type Ingredient, type SmeltingRecipe,
} from './recipes';
export { giveItem, takeItem, hasItem, countItem, throwFromPlayer } from './inventory-api';
export { getHealth, hurtPlayer, deathMessage, PlayerHealth, MAX_HEALTH, MAX_HUNGER, MAX_AIR, type PlayerDamageSource, type HealthData } from './health';
export { dropItem, dropItems, getItemDrops, ItemDrop, ItemDrops, type DropOptions } from './item-drops';
export { getContainers, Containers, CHEST_SIZE, type ChestState, type FurnaceState, type ContainerState } from './containers';
export { getCombat, Combat } from './combat';
export { getParticles, Particles, type BurstOptions } from './particles';
export { PlayStyleDetectors } from './detectors';

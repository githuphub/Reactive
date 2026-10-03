/**
 * Built-in recipes (about 60 crafting recipes counting tool variants), smelting and fuels.
 * Imported once by the survival plugin.
 */
import { registerFuel, registerRecipe, registerSmelting, type Ingredient } from './recipes';

let done = false;

export function registerBuiltinRecipes(): void {
  if (done) return;
  done = true;

  // Wood.
  for (const wood of ['oak', 'birch', 'spruce']) {
    registerRecipe({ id: `${wood}_planks`, ingredients: [`${wood}_log`], result: { item: `${wood}_planks`, count: 4 } });
  }
  registerRecipe({ id: 'stick', pattern: ['P', 'P'], key: { P: '#planks' }, result: { item: 'stick', count: 4 } });
  registerRecipe({ id: 'crafting_table', pattern: ['PP', 'PP'], key: { P: '#planks' }, result: { item: 'crafting_table' } });
  registerRecipe({ id: 'chest', pattern: ['PPP', 'P P', 'PPP'], key: { P: '#planks' }, result: { item: 'chest' } });
  registerRecipe({ id: 'door', pattern: ['PP', 'PP', 'PP'], key: { P: '#planks' }, result: { item: 'door', count: 3 } });
  registerRecipe({ id: 'ladder', pattern: ['S S', 'SSS', 'S S'], key: { S: 'stick' }, result: { item: 'ladder', count: 3 } });
  registerRecipe({ id: 'bookshelf', pattern: ['PPP', 'BBB', 'PPP'], key: { P: '#planks', B: 'book' }, result: { item: 'bookshelf' } });

  // Tools: 5 materials × 5 kinds.
  const materials: [string, Ingredient][] = [
    ['wooden', '#planks'],
    ['stone', ['cobblestone', 'mossy_cobblestone']],
    ['iron', 'iron_ingot'],
    ['golden', 'gold_ingot'],
    ['diamond', 'diamond'],
  ];
  const shapes: Record<string, string[]> = {
    pickaxe: ['MMM', ' S ', ' S '],
    axe: ['MM', 'MS', ' S'],
    shovel: ['M', 'S', 'S'],
    sword: ['M', 'M', 'S'],
    hoe: ['MM', ' S', ' S'],
  };
  for (const [mat, ing] of materials)
    for (const [kind, pattern] of Object.entries(shapes))
      registerRecipe({ id: `${mat}_${kind}`, pattern, key: { M: ing, S: 'stick' }, result: { item: `${mat}_${kind}` } });
  registerRecipe({ id: 'shears', pattern: [' I', 'I '], key: { I: 'iron_ingot' }, result: { item: 'shears' } });
  registerRecipe({ id: 'bow', pattern: [' TS', 'T S', ' TS'], key: { T: 'stick', S: 'string' }, result: { item: 'bow' } });
  registerRecipe({ id: 'arrow', pattern: ['F', 'S', 'E'], key: { F: 'flint', S: 'stick', E: 'feather' }, result: { item: 'arrow', count: 4 } });
  registerRecipe({ id: 'arrow_bone', pattern: ['F', 'S', 'B'], key: { F: 'flint', S: 'stick', B: 'bone' }, result: { item: 'arrow', count: 2 } });

  // Light, utility.
  registerRecipe({ id: 'torch', pattern: ['C', 'S'], key: { C: 'coal', S: 'stick' }, result: { item: 'torch', count: 4 } });
  registerRecipe({ id: 'furnace', pattern: ['CCC', 'C C', 'CCC'], key: { C: ['cobblestone', 'mossy_cobblestone'] }, result: { item: 'furnace' } });
  registerRecipe({ id: 'glow_lamp', pattern: [' G ', 'GTG', ' G '], key: { G: 'glass', T: 'torch' }, result: { item: 'glow_lamp' } });
  registerRecipe({ id: 'tnt', pattern: ['GSG', 'SGS', 'GSG'], key: { G: 'gunpowder', S: 'sand' }, result: { item: 'tnt' } });

  // Building blocks.
  registerRecipe({ id: 'bricks', pattern: ['BB', 'BB'], key: { B: 'brick' }, result: { item: 'bricks' } });
  registerRecipe({ id: 'stone_bricks', pattern: ['SS', 'SS'], key: { S: 'stone' }, result: { item: 'stone_bricks', count: 4 } });
  registerRecipe({ id: 'sandstone', pattern: ['SS', 'SS'], key: { S: 'sand' }, result: { item: 'sandstone' } });
  registerRecipe({ id: 'white_wool', pattern: ['SS', 'SS'], key: { S: 'string' }, result: { item: 'white_wool' } });
  for (const [block, item] of [['iron_block', 'iron_ingot'], ['gold_block', 'gold_ingot'], ['diamond_block', 'diamond'], ['hay_bale', 'wheat']]) {
    registerRecipe({ id: block, pattern: ['III', 'III', 'III'], key: { I: item }, result: { item: block } });
    registerRecipe({ id: `${item}_from_${block}`, ingredients: [block], result: { item, count: 9 } });
  }

  // Food.
  registerRecipe({ id: 'bread', pattern: ['WWW'], key: { W: 'wheat' }, result: { item: 'bread' } });

  // Smelting (4 s per item).
  registerSmelting({ input: 'iron_ore', output: 'iron_ingot' });
  registerSmelting({ input: 'gold_ore', output: 'gold_ingot' });
  registerSmelting({ input: 'sand', output: 'glass' });
  registerSmelting({ input: 'cobblestone', output: 'stone' });
  registerSmelting({ input: 'clay', output: 'brick', count: 4 });
  registerSmelting({ input: 'raw_porkchop', output: 'cooked_porkchop' });
  registerSmelting({ input: 'raw_beef', output: 'cooked_beef' });
  registerSmelting({ input: '#log', output: 'coal' });
  registerSmelting({ input: 'cactus', output: 'green_wool' });

  // Fuels (seconds).
  registerFuel('coal', 40);
  registerFuel('#planks', 7.5);
  registerFuel('#log', 7.5);
  registerFuel('stick', 2.5);
  registerFuel('#sapling', 2.5);
  registerFuel(['crafting_table', 'chest', 'bookshelf', 'ladder'], 7.5);
  registerFuel(['wooden_pickaxe', 'wooden_axe', 'wooden_shovel', 'wooden_sword', 'wooden_hoe', 'bow'], 5);
  registerFuel('hay_bale', 20);
}

/** Biome ids stored per column in each chunk. */
export const BIOME = {
  plains: 0,
  forest: 1,
  desert: 2,
  snowy_taiga: 3,
  mountains: 4,
  beach: 5,
  lake: 6,
} as const;

export type BiomeName = keyof typeof BIOME;
export type BiomeId = (typeof BIOME)[BiomeName];

export const BIOME_NAMES: readonly BiomeName[] = ['plains', 'forest', 'desert', 'snowy_taiga', 'mountains', 'beach', 'lake'];

export function biomeName(id: number): BiomeName {
  return BIOME_NAMES[id] ?? 'plains';
}

/** Display names for the debug overlay and UI. */
export const BIOME_LABELS: Record<BiomeName, string> = {
  plains: 'Plains',
  forest: 'Forest',
  desert: 'Desert',
  snowy_taiga: 'Snowy Taiga',
  mountains: 'Mountains',
  beach: 'Beach',
  lake: 'Lake',
};

/** True for biomes where precipitation falls as snow. */
export function isSnowy(id: number): boolean {
  return id === BIOME.snowy_taiga;
}

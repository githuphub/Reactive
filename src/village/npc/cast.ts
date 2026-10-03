/**
 * The Oakhollow cast. Ids match the Liveforge manifest personas (`examples/livecraft.liveforge.yaml`);
 * aliases cover the manifest's longer ids (e.g. `captain_rowan`). Generic villagers are rolled per
 * seed in `layout.ts` and added with {@link genericCast}.
 */
import type { GenericVillagerSpec } from '../layout';
import type { LookSpec, Profession } from './model';

export type WorkKind = 'yard' | 'farm' | 'smithy' | 'library' | 'gate' | 'plaza' | 'patrol';

export interface CastMember {
  /** Manifest persona id. */
  id: string;
  name: string;
  role: string;
  profession: Profession;
  /** Building id of the home (null for the golem). */
  home: string | null;
  work: WorkKind;
  /** Opens a trade screen. */
  trader: boolean;
  /** Fights hostiles and holds posts. */
  guard: boolean;
  /** Can't die (drops to 1 hp and is "injured" instead). */
  immortal: boolean;
  aliases: string[];
  greeting: string;
  barks: string[];
  /** Lines while building (builders). */
  buildLines?: string[];
  look: LookSpec;
}

export const NAMED_CAST: CastMember[] = [
  {
    id: 'bram', name: 'Bram', role: 'Builder', profession: 'builder', home: 'bram_house', work: 'yard', trader: true, guard: false, immortal: true,
    aliases: ['builder'],
    greeting: 'Ah, a visitor! Need something built?',
    barks: ['Bottom up, always bottom up.', "That roof won't lay itself.", 'Oak for the walls, spruce for the trim. Trust me.'],
    buildLines: ['Bottom up, as my father taught me.', 'Walls first, then the roof.', 'Mind the corners, they make the house.', 'Nearly there now!', 'There! Built to last.'],
    look: { skin: '#c98e6b', hair: '#6b3d1e', robe: '#9c5b2c', trim: '#5e3518', beard: true },
  },
  {
    id: 'mara', name: 'Mara', role: 'Farmer', profession: 'farmer', home: 'mara_house', work: 'farm', trader: true, guard: false, immortal: true,
    aliases: ['farmer'],
    greeting: 'Mind the wheat.',
    barks: ['Off the crops, please.', 'If you break it, you mend it. Simple.', "Rain's coming, I can smell it."],
    look: { skin: '#e0ac8a', hair: '#8a3a1e', robe: '#6c8a3c', trim: '#46602a' },
  },
  {
    id: 'hilde', name: 'Hilde', role: 'Smith', profession: 'smith', home: 'hilde_house', work: 'smithy', trader: true, guard: false, immortal: true,
    aliases: ['smith', 'trader'],
    greeting: 'Buying or selling? Either way, wipe your hands.',
    barks: ["Iron's up this week. Don't ask why.", 'Good steel never lies.', 'Haggle all you like. I remember.'],
    look: { skin: '#a8714f', hair: '#2b211b', robe: '#4b4b52', trim: '#2d2d33', eyes: '#5a3a1a' },
  },
  {
    id: 'pip', name: 'Pip', role: 'Librarian', profession: 'librarian', home: 'library', work: 'library', trader: false, guard: false, immortal: true,
    aliases: ['librarian'],
    greeting: 'Oh! Have you heard?',
    barks: ["I shouldn't say, but...", "Everyone's talking about it.", 'Books back by Thursday, please.'],
    look: { skin: '#f0c4a0', hair: '#d8a640', robe: '#6a4c9c', trim: '#3f2c63', glasses: true, eyes: '#2a4a8a' },
  },
  {
    id: 'rowan', name: 'Captain Rowan', role: 'Guard captain', profession: 'guard', home: 'guard_tower', work: 'gate', trader: false, guard: true, immortal: true,
    aliases: ['captain_rowan', 'captain', 'guard'],
    greeting: 'Keep your torch lit after dark.',
    barks: ['Torches up before sundown.', 'The night watch starts at dusk.', 'Eyes on the treeline.'],
    look: { skin: '#8d5a3b', hair: '#1f1712', robe: '#3a5ba0', trim: '#243a6b', beard: true },
  },
  {
    id: 'iron_golem', name: 'Iron Golem', role: 'Guardian', profession: 'golem', home: null, work: 'patrol', trader: false, guard: true, immortal: true,
    aliases: ['golem'],
    greeting: '*creaks and nods*',
    barks: ['*creaks and stares*', '*offers a poppy*', '*stamps once*'],
    look: { skin: '#cfcac0', hair: '#3a3532', robe: '#cfcac0', trim: '#9d978c' },
  },
];

const ROBES = ['#8a5a44', '#c7b18a', '#5b7f9b', '#9b5b6e', '#6f8f5a', '#b8863b'];
const SKINS = ['#c98e6b', '#e0ac8a', '#a8714f', '#8d5a3b', '#f0c4a0', '#b97e5a'];
const HAIRS = ['#3b2414', '#8a5a2b', '#1f1712', '#c9a050', '#6e6e6e', '#7a2f1b'];

/** Cast entries for the seed's generic villagers. */
export function genericCast(gens: GenericVillagerSpec[]): CastMember[] {
  return gens.map((g, i) => ({
    id: g.id,
    name: g.name,
    role: g.work === 'farm' ? 'Farmhand' : g.work === 'yard' ? 'Labourer' : g.work === 'library' ? 'Scholar' : 'Villager',
    profession: g.work === 'farm' ? 'farmer' : 'villager',
    home: g.home,
    work: g.work,
    trader: false,
    guard: false,
    immortal: true,
    aliases: [g.name.toLowerCase()],
    greeting: 'Good day to you!',
    barks: ['Lovely weather.', 'Have you met Bram? He builds everything here.', "Mara's bread is the best in the valley."],
    look: {
      skin: SKINS[(g.robe + i) % SKINS.length],
      hair: HAIRS[(g.robe * 3 + i) % HAIRS.length],
      robe: ROBES[g.robe % ROBES.length],
      trim: '#3a2c20',
      beard: (g.robe + i) % 3 === 0,
    },
  }));
}

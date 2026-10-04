/**
 * The local achievement list (offline rules): about 25 quirky achievements over Game events, measured by
 * PlayerStats. The server's `achievement.check` adds generated ones on top when online.
 */
import type { PlayerStats } from '../stats';
import type { LcRumour } from '../rumours';

/** What a local achievement can look at. */
export interface AchContext {
  stats: PlayerStats;
  rumours: LcRumour[];
  nickname: string | null;
  chainsDone: number;
}

export interface LocalAchievement {
  id: string;
  title: string;
  description: string;
  /** Shown in the journal while locked. */
  hint: string;
  /** Emoji icon. */
  icon: string;
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  test(c: AchContext): boolean;
}

const forgedLike = (c: AchContext, re: RegExp) => c.stats.forgedNames.some((n) => re.test(n));

export const LOCAL_ACHIEVEMENTS: LocalAchievement[] = [
  { id: 'wb_fresh_air', title: 'Fresh Air', description: 'Walked 500 blocks. Your boots have opinions now.', hint: 'Go for a long walk.', icon: '🥾', rarity: 'common', test: (c) => c.stats.count('distance') >= 500 },
  { id: 'wb_knock_knock', title: 'Knock Knock', description: 'Talked to three different villagers.', hint: 'Say hello around Oakhollow.', icon: '🚪', rarity: 'common', test: (c) => c.stats.talkedTo.size >= 3 },
  { id: 'wb_people_person', title: 'People Person', description: 'Talked to every named villager in Oakhollow.', hint: 'Meet all five.', icon: '🤝', rarity: 'uncommon', test: (c) => ['bram', 'mara', 'hilde', 'pip', 'captain_rowan'].every((n) => c.stats.talkedTo.has(n)) },
  { id: 'wb_gossip_fodder', title: 'Gossip Fodder', description: 'Became the subject of a village rumour.', hint: 'Do something worth whispering about.', icon: '🗞️', rarity: 'common', test: (c) => c.rumours.some((r) => r.aboutPlayer) },
  { id: 'wb_talk_of_the_town', title: 'Talk of the Town', description: 'A rumour about you reached four villagers.', hint: 'Let a rumour run.', icon: '📣', rarity: 'uncommon', test: (c) => c.rumours.some((r) => r.aboutPlayer && r.knownBy.length >= 4) },
  { id: 'wb_broken_telephone', title: 'Broken Telephone', description: 'A rumour about you changed its story three times.', hint: 'Rumours grow in the telling…', icon: '☎️', rarity: 'rare', test: (c) => c.rumours.some((r) => r.mutations >= 3) },
  { id: 'wb_home_wrecker', title: 'Home Wrecker', description: "Broke three blocks of somebody's house. They noticed.", hint: 'Not recommended.', icon: '🏚️', rarity: 'common', test: (c) => c.stats.count('griefs') >= 3 },
  { id: 'wb_sunrise', title: 'Sunrise Survivor', description: 'Saw the sun come up after a night outside.', hint: 'Survive a night.', icon: '🌅', rarity: 'common', test: (c) => c.stats.count('nights') >= 1 },
  { id: 'wb_three_nights', title: 'Nocturnal', description: 'Survived three nights.', hint: 'Keep surviving.', icon: '🦉', rarity: 'uncommon', test: (c) => c.stats.count('nights') >= 3 },
  { id: 'wb_undertaker', title: 'Undertaker', description: 'Put ten zombies back in the ground.', hint: 'Zombies, ten of them.', icon: '⚰️', rarity: 'uncommon', test: (c) => (c.stats.kills.zombie ?? 0) + (c.stats.kills.baby_zombie ?? 0) >= 10 },
  { id: 'wb_bone_collector', title: 'Bone Collector', description: 'Rattled five skeletons apart.', hint: 'Skeletons.', icon: '🦴', rarity: 'uncommon', test: (c) => (c.stats.kills.skeleton ?? 0) >= 5 },
  { id: 'wb_sssurprise', title: 'Sssssurprise!', description: 'Died to an explosion. Classic.', hint: 'Hug a creeper (don’t).', icon: '💥', rarity: 'common', test: (c) => Object.keys(c.stats.deathCauses).some((k) => /explo|creeper|blew/i.test(k)) },
  { id: 'wb_gravity_check', title: 'Gravity Check', description: 'Gravity: still working. Died from a fall.', hint: 'Mind the edge.', icon: '🪂', rarity: 'common', test: (c) => Object.keys(c.stats.deathCauses).some((k) => /fall|fell/i.test(k)) },
  { id: 'wb_shopaholic', title: 'Shopaholic', description: 'Made five trades in Oakhollow.', hint: 'Shop around.', icon: '🛍️', rarity: 'common', test: (c) => c.stats.count('trades') >= 5 },
  { id: 'wb_silver_tongue', title: 'Silver Tongue', description: 'Won a haggle.', hint: 'Haggle with a trader.', icon: '🗣️', rarity: 'uncommon', test: (c) => c.stats.count('hagglesWon') >= 1 },
  { id: 'wb_feathered_friend', title: 'Feathered Friend', description: 'Forged a chicken and you both made it through the night.', hint: 'Forge a bird, then survive a night.', icon: '🐔', rarity: 'rare', test: (c) => forgedLike(c, /chicken|hen|bird|duck|feather/i) && c.stats.count('nights') >= 1 },
  { id: 'wb_forge_fanatic', title: 'Forge Fanatic', description: 'Forged three things. The anvil is warm.', hint: 'Use the forge (F).', icon: '⚒️', rarity: 'uncommon', test: (c) => c.stats.count('forged') >= 3 },
  { id: 'wb_storm_chaser', title: 'Storm Chaser', description: 'Forged something with lightning in it.', hint: 'Something electric…', icon: '⚡', rarity: 'rare', test: (c) => forgedLike(c, /lightning|storm|thunder|volt|spark/i) },
  { id: 'wb_architect', title: 'Architect', description: 'Placed 100 blocks.', hint: 'Build something.', icon: '🧱', rarity: 'common', test: (c) => c.stats.count('blocksPlaced') >= 100 },
  { id: 'wb_civic_pride', title: 'Civic Pride', description: 'Placed 40 blocks inside Oakhollow.', hint: 'Build for the village.', icon: '🏘️', rarity: 'uncommon', test: (c) => c.stats.count('placedInVillage') >= 40 },
  { id: 'wb_tunnel_vision', title: 'Tunnel Vision', description: 'Broke 150 blocks. The ground fears you.', hint: 'Dig.', icon: '⛏️', rarity: 'common', test: (c) => c.stats.count('blocksBroken') >= 150 },
  { id: 'wb_pillar_of_community', title: 'Pillar of the Community', description: 'Pillared ten blocks into the sky.', hint: 'Up, up, up.', icon: '🗼', rarity: 'uncommon', test: (c) => c.stats.maxPillar >= 10 },
  { id: 'wb_robin_hood', title: 'Robin Hood', description: 'Shot 30 arrows.', hint: 'Practise archery.', icon: '🏹', rarity: 'common', test: (c) => c.stats.count('arrows') >= 30 },
  { id: 'wb_fashion_icon', title: 'Fashion Icon', description: 'A villager got a makeover because of you.', hint: 'Make an impression on someone.', icon: '🎩', rarity: 'uncommon', test: (c) => c.stats.count('makeovers') >= 1 },
  { id: 'wb_errand_runner', title: 'Errand Runner', description: 'Completed three quests.', hint: 'Help the villagers.', icon: '📜', rarity: 'uncommon', test: (c) => c.stats.count('quests') >= 3 },
  { id: 'wb_saga', title: 'A Proper Saga', description: 'Finished a whole quest chain.', hint: 'See a villager’s story to the end.', icon: '📚', rarity: 'rare', test: (c) => c.chainsDone >= 1 },
  { id: 'wb_nicknamed', title: 'Nicknamed', description: 'The village gave you a name of your own.', hint: 'Earn a reputation.', icon: '🏷️', rarity: 'rare', test: (c) => !!c.nickname },
  { id: 'wb_villain_arc', title: 'Villain Arc', description: 'Hit a villager. They will remember.', hint: 'Please don’t.', icon: '😈', rarity: 'common', test: (c) => c.stats.count('villagersHit') >= 1 },
];

/** Server icon glyph names → emoji. */
export const GLYPH_EMOJI: Record<string, string> = {
  moon: '🌙', brick: '🧱', hammer: '🔨', tower: '🗼', heart: '❤️', anvil: '⚒️', skull: '💀', coin: '🪙', flame: '🔥', star: '⭐',
  sword: '⚔️', shield: '🛡️', crown: '👑', bow: '🏹', book: '📖', scroll: '📜', gem: '💎', leaf: '🍃', bolt: '⚡', eye: '👁️',
  chicken: '🐔', trophy: '🏆', house: '🏠', key: '🗝️', mask: '🎭', potion: '🧪', ghost: '👻', sun: '☀️', snow: '❄️',
};

/**
 * Trade offers per trader, priced in `coins`. A village-wide price multiplier (posture, haggles)
 * scales them: the player pays `ceil(price × mult)` when buying and receives
 * `max(1, floor(price / mult))` when selling.
 */

export interface TradeOffer {
  id: string;
  /** 'buy': the player buys `item` for coins. 'sell': the player sells `item` for coins. */
  kind: 'buy' | 'sell';
  item: string;
  count: number;
  /** Base price in coins. */
  price: number;
}

const o = (id: string, kind: TradeOffer['kind'], item: string, count: number, price: number): TradeOffer => ({ id, kind, item, count, price });

/** Offers by villager id. */
export const OFFERS: Record<string, TradeOffer[]> = {
  hilde: [
    o('h_pick', 'buy', 'iron_pickaxe', 1, 8),
    o('h_sword', 'buy', 'iron_sword', 1, 9),
    o('h_axe', 'buy', 'iron_axe', 1, 7),
    o('h_shovel', 'buy', 'iron_shovel', 1, 5),
    o('h_ingot', 'buy', 'iron_ingot', 3, 4),
    o('h_shears', 'buy', 'shears', 1, 3),
    o('h_coal', 'sell', 'coal', 8, 2),
    o('h_iron_ore', 'sell', 'iron_ore', 4, 3),
    o('h_gold', 'sell', 'gold_ingot', 1, 3),
  ],
  mara: [
    o('m_bread', 'buy', 'bread', 3, 2),
    o('m_apple', 'buy', 'apple', 4, 2),
    o('m_seeds', 'buy', 'wheat_seeds', 8, 1),
    o('m_pumpkin', 'buy', 'pumpkin', 1, 2),
    o('m_hay', 'buy', 'hay_bale', 2, 3),
    o('m_wheat', 'sell', 'wheat', 12, 2),
    o('m_pumpkin_s', 'sell', 'pumpkin', 2, 1),
  ],
  bram: [
    o('b_planks', 'buy', 'oak_planks', 16, 1),
    o('b_bricks', 'buy', 'bricks', 8, 2),
    o('b_glass', 'buy', 'glass', 8, 2),
    o('b_stone', 'buy', 'stone_bricks', 16, 2),
    o('b_lamp', 'buy', 'glow_lamp', 4, 3),
    o('b_door', 'buy', 'door', 1, 1),
    o('b_torch', 'buy', 'torch', 16, 1),
    o('b_logs', 'sell', 'oak_log', 8, 1),
    o('b_cobble', 'sell', 'cobblestone', 32, 1),
  ],
};

/** Coins the player pays (buy) or gets (sell) at a multiplier. */
export function priceAt(offer: TradeOffer, mult: number): number {
  const m = Math.max(0.1, mult);
  return offer.kind === 'buy' ? Math.max(1, Math.ceil(offer.price * m - 1e-9)) : Math.max(1, Math.floor(offer.price / m + 1e-9));
}

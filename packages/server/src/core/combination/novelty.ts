// Novelty (Reaction Library combination engine, R1): a speaker never repeats a line while it is in their ledger.
// Variant choice is deterministic for (fingerprint, speaker, use count): replays of the same log pick the same
// lines, and every new combination or every next use walks to a different variant.
import { hashString, mulberry32 } from "@liveforge/protocol";

/** Lower-case words only, for "is this the same line?" comparisons. */
export const normaliseLine = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

/** Seeded permutation of 0..n-1. */
export function seededOrder(n: number, seed: number): number[] {
  const r = mulberry32(seed);
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface VariantPick {
  index: number;
  text: string;
  /** true when every variant was already in the ledger (the least recently used one was taken). */
  reused: boolean;
}

/**
 * Pick a pool variant: walk a permutation seeded by (fingerprint, speaker, salt) starting at `count` (times this
 * combination was used) and take the first line not in `recent` (normalised, oldest first). When all are used,
 * take the one used longest ago.
 */
export function pickVariant(pool: string[], o: { fingerprint: string; speaker: string; count: number; recent: string[]; salt?: string }): VariantPick | null {
  if (!pool.length) return null;
  const order = seededOrder(pool.length, hashString(`${o.fingerprint}|${o.speaker}|${o.salt ?? ""}`));
  // ledger lines may carry a voice tic or a woven aside: a variant counts as used when a recent line contains it
  const recent = o.recent.map(normaliseLine);
  const usedAt = (line: string) => {
    const n = normaliseLine(line);
    for (let i = recent.length - 1; i >= 0; i--) if (recent[i] === n || (n.length >= 8 && recent[i].includes(n))) return i;
    return -1;
  };
  const start = o.count % pool.length;
  for (let k = 0; k < pool.length; k++) {
    const index = order[(start + k) % pool.length];
    if (usedAt(pool[index]) < 0) return { index, text: pool[index], reused: false };
  }
  // all used: least recently used (smallest last index in the ledger)
  let best = order[start];
  let bestAt = Infinity;
  for (const i of order) {
    const at = usedAt(pool[i]);
    if (at < bestAt) { bestAt = at; best = i; }
  }
  return { index: best, text: pool[best], reused: true };
}

/** True when `line` (after filling) is already in the speaker's recent lines. */
export const isRepeat = (line: string, recent: string[]): boolean => {
  const n = normaliseLine(line);
  return recent.some((r) => { const x = normaliseLine(r); return x === n || (n.length >= 8 && x.includes(n)); });
};

/** Prompt block for AI upgrades: the lines this speaker must not repeat. */
export function doNotRepeatBlock(lines: string[], max = 8): string {
  const list = [...new Set(lines.filter(Boolean))].slice(-max);
  return list.length ? `Do not repeat (or closely paraphrase) any of these recent lines:\n${list.map((l) => `- ${l}`).join("\n")}` : "";
}

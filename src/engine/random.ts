/** Small deterministic random helpers (no deps). */

/** Hashes a string to a uint32 (FNV-1a). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG: returns a function producing floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash of up to 4 ints and a seed, as uint32. Stable across threads. */
export function hash4(seed: number, a: number, b = 0, c = 0): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ Math.imul(a, 0xcc9e2d51), 0x1b873593);
  h = (h << 13) | (h >>> 19);
  h = Math.imul(h ^ Math.imul(b, 0x27d4eb2f), 0x165667b1);
  h = (h << 11) | (h >>> 21);
  h = Math.imul(h ^ Math.imul(c, 0x9e3779b1), 0x85ebca77);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** {@link hash4} mapped to [0, 1). */
export function hash01(seed: number, a: number, b = 0, c = 0): number {
  return hash4(seed, a, b, c) / 4294967296;
}

/** Parses a seed from a URL param (number or any string). */
export function parseSeed(raw: string | null | undefined, fallback = 'livecraft'): { text: string; value: number } {
  const text = (raw ?? '').trim() || fallback;
  const n = Number(text);
  const value = Number.isInteger(n) ? n >>> 0 : hashString(text);
  return { text, value };
}

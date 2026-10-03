// Small shared primitives.
import { z } from "zod";

/** "#rrggbb" colour. */
export const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "expected a #rrggbb colour");
export type Hex = z.infer<typeof Hex>;

export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3>;

/** Ids: lowercase-ish slugs, 1-64 chars (letters, digits, _ - . :). */
export const Id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_\-.:]+$/, "ids may only use letters, digits and _ - . :");
export type Id = z.infer<typeof Id>;

/** Free JSON-ish bag (signal data, args, params extensions). */
export const Bag = z.record(z.string(), z.unknown());
export type Bag = z.infer<typeof Bag>;

/** Unit interval. */
export const Unit = z.number().min(0).max(1);

/** Milliseconds since the Unix epoch. */
export const Timestamp = z.number().int().nonnegative();

/** Seeded PRNG (mulberry32), shared by all rules fast-paths so instant answers are deterministic. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit string hash (seed derivation for prompts / ids). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const clampNum = (v: unknown, lo: number, hi: number, d: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
export const oneOf = <T extends string>(list: readonly T[], v: unknown): T | undefined =>
  typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : undefined;
/** Printable text only (no control / markup characters), whitespace collapsed, capped. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.replace(/[^\p{L}\p{N} '’!?,.:;\-–—()"]/gu, "").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

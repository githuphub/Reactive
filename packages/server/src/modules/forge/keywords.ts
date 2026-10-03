// Keyword rules for the keyless forge (ported from Counterforge keywords.ts / rules.ts and generalised to any
// manifest): head-noun archetype picking, element detection over the manifest's element names, names, raw-power
// detection for the creativity rules.
import { ARCHETYPES, type Archetype, type LibraryCategory } from "./library/archetypes.js";
import { ELEMENT_WORDS, canonicalElement, plainElement } from "./elements.js";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whole-word, case-insensitive, optional plural ("bows", "axes"); spaces match any whitespace run so multi-word
 * keywords ("rocket launcher") work. "price" / "dice" never match "ice".
 */
export const keywordRe = (alts: readonly string[], flags = "i") =>
  new RegExp(`\\b(?:${alts.map((a) => esc(a).replace(/ /g, "\\s+")).join("|")})(?:s|es)?\\b`, flags);

/** First connective that ends the head phrase: "frost harpoon | on a chain", "tower shield | of storms". */
export const HEAD_END = /\b(?:of|on|with|from|for|in|made|that|which|who|and|but|wielded|held|holding|wielding|like)\b/i;

interface Kw { arch: Archetype; re: RegExp; len: number }
const KWS: Kw[] = ARCHETYPES.flatMap((arch) => arch.keywords.map((k) => ({ arch, re: keywordRe([k], "gi"), len: k.length })));

/**
 * Picks the library archetype a text names, restricted to a category (held = no category) and optionally to a set
 * of library families. Head-noun rule: among keyword matches that START in the head phrase (before the first
 * connective), the one that ENDS last wins (ties: the longer keyword, so "tower shield" beats "shield"); with no
 * match in the head phrase the same rule runs over the whole text. Null when nothing matches.
 */
export function pickArchetype(text: string, category: LibraryCategory | "held" = "held", families?: readonly string[]): Archetype | null {
  const cut = text.search(HEAD_END);
  const headEnd = cut < 0 ? text.length : cut;
  let bestHead: { arch: Archetype; end: number; len: number } | null = null;
  let bestAll: { arch: Archetype; end: number; len: number } | null = null;
  const better = (a: { end: number; len: number } | null, end: number, len: number) => !a || end > a.end || (end === a.end && len > a.len);
  for (const kw of KWS) {
    const inCategory = category === "held" ? !kw.arch.category : kw.arch.category === category;
    if (!inCategory) continue;
    if (families && !families.includes(kw.arch.family)) continue;
    kw.re.lastIndex = 0;
    for (const m of text.matchAll(kw.re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (start < headEnd && better(bestHead, end, kw.len)) bestHead = { arch: kw.arch, end, len: kw.len };
      if (better(bestAll, end, kw.len)) bestAll = { arch: kw.arch, end, len: kw.len };
    }
  }
  return (bestHead ?? bestAll)?.arch ?? null;
}

/** "fire(s)" used as a verb ("a crossbow that fires bolts"): blanked before element detection. */
const FIRE_VERB = /\b(?:(?:that|which|who|it|can|could|will|to)\s+fires?|fires)\b/gi;

/**
 * Keyless element over the manifest's elements: head phrase first (the first element named before the first
 * connective wins), else the rest of the prompt, else the manifest's plain element. Each manifest element matches
 * its own name plus the synonyms of its canonical element ("frost" -> "Ice").
 */
export function keywordElement(text: string, elements: readonly string[]): string {
  const clean = text.replace(FIRE_VERB, (m) => " ".repeat(m.length));
  const res = elements.map((el) => {
    const canon = canonicalElement(el);
    const words = [el.toLowerCase(), ...(canon && ELEMENT_WORDS[canon] ? ELEMENT_WORDS[canon].split("|") : [])];
    return [el, keywordRe(words)] as const;
  });
  const first = (t: string): string | undefined => {
    let best: string | undefined;
    let at = Infinity;
    for (const [el, re] of res) {
      if (canonicalElement(el) === "physical") continue; // physical is the default, never "detected"
      const i = t.search(re);
      if (i >= 0 && i < at) { best = el; at = i; }
    }
    return best;
  };
  const cut = text.search(HEAD_END);
  const head = cut < 0 ? clean : clean.slice(0, cut);
  return first(head) ?? (cut < 0 ? undefined : first(clean.slice(cut))) ?? plainElement(elements);
}

const NAME_MAX = 40;
const titleCase = (s: string) => s.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
/** Title-cased keyless name, cut at a word boundary to <= 40 chars. */
export function keywordName(text: string): string {
  const t = titleCase(text.trim().replace(/[^\p{L}\p{N} '\-]/gu, " ").replace(/\s+/g, " ").trim());
  if (t.length <= NAME_MAX) return t;
  const cut = t.lastIndexOf(" ", NAME_MAX);
  return (cut >= NAME_MAX / 2 ? t.slice(0, cut) : t.slice(0, NAME_MAX)).trim();
}

/** Raw power requests ("a nuke", "instant win", "infinitely strong"): the creativity rules keep them modest. */
const RAW_POWER = /\b(?:nuke|nuclear|instant(?:ly)?\s*(?:win|kill)|one[\s-]?shot|infinite(?:ly)?|unlimited|god[\s-]?mode|overpowered|op|invincible|unbeatable|kills?\s+everything|strongest|most\s+powerful|max(?:imum)?\s+damage|9999+|\d{5,})\b/i;
export const isRawPowerRequest = (text: string): boolean => RAW_POWER.test(text);

/** Specific, imaginative wording raises creativity (rules estimate, 0-1): distinct content words + concrete nouns. */
export function creativityEstimate(text: string): number {
  if (!text.trim()) return 0.2;
  if (isRawPowerRequest(text)) return 0.05;
  const words = (text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []).filter((w) => !STOP.has(w));
  const distinct = new Set(words).size;
  const connectives = (text.match(HEAD_END) ? 1 : 0) + (text.match(/,|\bthat\b|\bwhich\b/gi)?.length ?? 0);
  return Math.min(0.9, 0.2 + distinct * 0.06 + connectives * 0.05);
}
const STOP = new Set(["the", "and", "with", "that", "which", "for", "from", "very", "really", "some", "make", "give", "want", "please", "forge", "create"]);

/** Content words of a text (for themed names: "Ash Golem" -> ["ash", "golem"]). */
export function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []).filter((w) => !STOP.has(w) && w !== "the");
}

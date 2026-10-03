// Moderation hook. Default: keyword filter driven by the manifest safety rating (E / T / M) + safety.blocked.
// Swap in a model-based moderator by implementing Moderator and passing it to createLiveforge({ moderator }).
import type { Manifest } from "@liveforge/manifest";

export interface ModerationVerdict {
  ok: boolean;
  /** Category / matched term when blocked. */
  reason?: string;
  /** Text with blocked terms masked (outputs can be shown masked instead of dropped). */
  cleaned: string;
}

export interface Moderator {
  check(text: string, opts: { direction: "input" | "output"; manifest: Manifest }): ModerationVerdict | Promise<ModerationVerdict>;
}

/** Minimal built-in lists per rating (designers extend with safety.blocked). Matched as whole words, case-insensitive. */
const RATING_TERMS: Record<"E" | "T" | "M", string[]> = {
  E: ["kill yourself", "kys", "suicide", "self harm", "porn", "nude", "naked", "sex", "cocaine", "heroin", "meth", "fuck", "shit", "bitch", "cunt"],
  T: ["kill yourself", "kys", "suicide method", "self harm", "porn", "nude", "cunt"],
  M: ["kill yourself", "kys", "suicide method"],
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class KeywordModerator implements Moderator {
  private cache = new WeakMap<Manifest, RegExp | null>();

  private regexFor(m: Manifest): RegExp | null {
    if (this.cache.has(m)) return this.cache.get(m)!;
    const terms = [...RATING_TERMS[m.safety.rating], ...m.safety.blocked].map((t) => t.trim()).filter(Boolean);
    const re = terms.length ? new RegExp(`\\b(${terms.map(esc).join("|")})\\b`, "gi") : null;
    this.cache.set(m, re);
    return re;
  }

  check(text: string, opts: { direction: "input" | "output"; manifest: Manifest }): ModerationVerdict {
    const re = this.regexFor(opts.manifest);
    if (!re) return { ok: true, cleaned: text };
    re.lastIndex = 0;
    const m = re.exec(text);
    if (!m) return { ok: true, cleaned: text };
    re.lastIndex = 0;
    return { ok: false, reason: `blocked term "${m[1].toLowerCase()}" (rating ${opts.manifest.safety.rating})`, cleaned: text.replace(re, (w) => "*".repeat(w.length)) };
  }
}

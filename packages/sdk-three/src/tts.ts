// Text-to-speech through the browser's speechSynthesis, steered by a persona's VoiceStyle
// (pitch / rate / accent / style words / voiceId). No server TTS needed.
import type { VoiceStyle } from "@liveforge/protocol";

export interface SpeakOptions {
  voice?: VoiceStyle;
  /** Cancel whatever is speaking first. Default false (queue). */
  interrupt?: boolean;
  /** 0-1. Default 1. */
  volume?: number;
  /** BCP-47 fallback language when the voice has no accent hint. Default: the page language or "en-GB". */
  lang?: string;
}

/** True when the browser can speak (speechSynthesis exists). */
export function speechSupported(): boolean {
  return typeof globalThis !== "undefined" && "speechSynthesis" in globalThis && typeof SpeechSynthesisUtterance !== "undefined";
}

const ACCENTS: Record<string, string> = {
  british: "en-GB", english: "en-GB", scottish: "en-GB", welsh: "en-GB", posh: "en-GB", cockney: "en-GB",
  irish: "en-IE", american: "en-US", southern: "en-US", australian: "en-AU", kiwi: "en-NZ", indian: "en-IN",
  "south african": "en-ZA", canadian: "en-CA", french: "fr-FR", german: "de-DE", spanish: "es-ES", italian: "it-IT",
  dutch: "nl-NL", russian: "ru-RU", japanese: "ja-JP", polish: "pl-PL", swedish: "sv-SE", portuguese: "pt-PT",
};

/** Maps an accent hint ("scottish", "en-GB", "fr") to a BCP-47 tag, or undefined. */
export function accentToLang(accent: string | undefined): string | undefined {
  if (!accent) return undefined;
  const a = accent.trim().toLowerCase();
  if (/^[a-z]{2}(-[a-z]{2})?$/i.test(a)) return a.length === 2 ? a : `${a.slice(0, 2)}-${a.slice(3).toUpperCase()}`;
  return ACCENTS[a] ?? Object.entries(ACCENTS).find(([k]) => a.includes(k))?.[1];
}

/** Pitch / rate / volume nudges for style words (applied on top of explicit pitch / rate). */
function styleTweaks(style: string | undefined): { pitch: number; rate: number; volume: number } {
  const s = (style ?? "").toLowerCase();
  let pitch = 1, rate = 1, volume = 1;
  if (/gruff|deep|growl|booming|stern/.test(s)) pitch *= 0.85;
  if (/booming|loud|shout/.test(s)) volume = 1;
  if (/whisper|quiet|soft|hushed/.test(s)) { volume = 0.6; rate *= 0.92; }
  if (/nervous|excited|brisk|quick|fast|chirpy/.test(s)) rate *= 1.1;
  if (/slow|weary|old|ancient|drawl|sleepy/.test(s)) rate *= 0.88;
  if (/squeaky|high|childlike|sing-song/.test(s)) pitch *= 1.15;
  return { pitch, rate, volume };
}

function voices(): SpeechSynthesisVoice[] {
  return speechSupported() ? speechSynthesis.getVoices() : [];
}

const FEMALE = /female|samantha|kate|serena|libby|sonia|victoria|karen|moira|tessa|fiona|zira|hazel|susan|martha/i;

/** Picks the best installed voice for a VoiceStyle (voiceId by name / URI, else language, else default). */
export function pickVoice(style: VoiceStyle | undefined, lang?: string): SpeechSynthesisVoice | undefined {
  const all = voices();
  if (!all.length) return undefined;
  if (style?.voiceId) {
    const id = style.voiceId.toLowerCase();
    const hit = all.find((v) => v.voiceURI.toLowerCase() === id || v.name.toLowerCase() === id) ?? all.find((v) => v.name.toLowerCase().includes(id));
    if (hit) return hit;
  }
  const want = accentToLang(style?.accent) ?? lang;
  if (want) {
    const exact = all.filter((v) => v.lang.toLowerCase() === want.toLowerCase());
    const prefix = all.filter((v) => v.lang.toLowerCase().startsWith(want.slice(0, 2).toLowerCase()));
    const pool = exact.length ? exact : prefix;
    if (pool.length) {
      // Low-pitched styles prefer voices not named as female, high-pitched ones prefer female-named voices.
      const p = style?.pitch ?? 1;
      const pick = p < 0.95 ? pool.find((v) => !FEMALE.test(v.name)) : p > 1.05 ? pool.find((v) => FEMALE.test(v.name)) : undefined;
      return pick ?? pool.find((v) => v.localService) ?? pool[0];
    }
  }
  return all.find((v) => v.default) ?? all[0];
}

/**
 * Speaks `text` with a VoiceStyle. Resolves when the utterance ends (or immediately when TTS is unsupported).
 *
 * ```ts
 * await speak("Sit yourself down, love.", { voice: { pitch: 1, rate: 1, style: "warm", accent: "en-GB" } });
 * ```
 */
export function speak(text: string, opts: SpeakOptions = {}): Promise<void> {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean || !speechSupported()) return Promise.resolve();
  if (opts.interrupt) speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  const lang = opts.lang ?? (typeof document !== "undefined" && document.documentElement.lang) ?? "en-GB";
  const v = pickVoice(opts.voice, lang || "en-GB");
  if (v) {
    u.voice = v;
    u.lang = v.lang;
  } else {
    u.lang = accentToLang(opts.voice?.accent) ?? (lang || "en-GB");
  }
  const tw = styleTweaks(opts.voice?.style);
  u.pitch = Math.min(2, Math.max(0, (opts.voice?.pitch ?? 1) * tw.pitch));
  u.rate = Math.min(4, Math.max(0.3, (opts.voice?.rate ?? 1) * tw.rate));
  u.volume = Math.min(1, Math.max(0, (opts.volume ?? 1) * tw.volume));
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    u.onend = finish;
    u.onerror = finish;
    // Some browsers never fire onend for cancelled utterances: cap by a generous estimate.
    setTimeout(finish, 2000 + (clean.length / Math.max(0.3, u.rate)) * 90);
    speechSynthesis.speak(u);
  });
}

/** Stops all speech. */
export function stopSpeaking(): void {
  if (speechSupported()) speechSynthesis.cancel();
}

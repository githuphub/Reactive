/**
 * Voices: villagers speak their lines with browser TTS in their persona voice (toggle in the Demo panel), and
 * hold-V push-to-talk uses the SDK mic (browser speech recognition, else recorded audio → server STT).
 */
import { Mic, MicError, micSupport, speak, speechSupported } from '@liveforge/three';
import type { LiveforgeService } from './service';

/** Voice settings shared by talk, tools and directives. */
export const voices = {
  /** Villagers speak aloud (browser TTS). */
  enabled: false,
};

const FALLBACK_VOICE: Record<string, { pitch: number; rate: number; style?: string }> = {
  bram: { pitch: 0.9, rate: 0.95, style: 'warm' },
  mara: { pitch: 1.1, rate: 1.1, style: 'sharp' },
  hilde: { pitch: 0.95, rate: 1.0, style: 'brisk' },
  pip: { pitch: 1.25, rate: 1.2, style: 'eager' },
  captain_rowan: { pitch: 0.85, rate: 0.95, style: 'steady' },
  rowan: { pitch: 0.85, rate: 0.95, style: 'steady' },
};

/** Speaks a villager's line aloud if voices are on (never throws, never blocks). */
export function speakAs(lf: LiveforgeService, npc: string, text: string): void {
  if (!voices.enabled || !text || npc === 'iron_golem' || !speechSupported()) return;
  const clean = text.replace(/\*[^*]*\*/g, '').trim();
  if (!clean) return;
  try {
    void speak(clean, { voice: lf.voiceOf(npc) ?? FALLBACK_VOICE[npc] ?? {}, interrupt: false });
  } catch {
    /* TTS is best effort */
  }
}

let mic: Mic | null = null;
let micKey = '';

const FIX = 'Use Chrome or Edge (free, built in), or add OPENAI_API_KEY to the Reactive .env and restart the server (Whisper). Press T to type meanwhile.';

/** Brave exposes speech recognition but blocks Google's speech service, so it always fails there. */
function isBrave(): boolean {
  return !!(navigator as Navigator & { brave?: unknown }).brave;
}

/**
 * Why push-to-talk can't work right now (shown before "Listening…"), or null when there is a path.
 * Browser recognition (Chrome/Edge) needs nothing; otherwise the audio goes to the server's speech-to-text.
 */
export function voiceBlocker(lf: LiveforgeService): string | null {
  const s = micSupport();
  if (s.browser && !isBrave()) return null;
  const who = isBrave() ? 'Brave blocks the browser speech service' : 'This browser has no built-in speech recognition';
  if (!s.record) return `${who} and can't record audio. ${FIX}`;
  if (lf.status === 'off') return `${who}, and Reactive is offline (its server does the speech-to-text here). ${FIX}`;
  if (lf.serverStt === null) return `${who}, and the Reactive server has no speech-to-text configured. ${FIX}`;
  return null;
}

/** Push-to-talk mic (lazy; rebuilt when the connection or STT availability changes). Null when nothing can capture. */
export function getMic(lf: LiveforgeService): Mic | null {
  const s = micSupport();
  if (!s.browser && !s.record) return null;
  const online = lf.status !== 'off';
  const mode = (isBrave() || !s.browser) && online && lf.serverStt ? 'server' : 'auto';
  const key = `${online}|${mode}`;
  if (!mic || key !== micKey) {
    mic = new Mic(online ? lf.client : null, { mode, language: 'en-GB' });
    micKey = key;
  }
  return mic;
}

/** Human explanation of a failed capture. */
export function micFailure(err: unknown): string {
  if (!(err instanceof MicError)) return `Voice failed: ${(err as Error)?.message ?? String(err)}`;
  switch (err.code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return isBrave() ? `Brave blocked speech recognition. ${FIX}` : 'Microphone blocked: allow the mic for localhost (icon in the address bar), then hold V again.';
    case 'network':
      return `The browser's speech service is unreachable or blocked. ${FIX}`;
    case 'audio-capture':
      return 'No microphone found: check that one is plugged in and selected in your OS sound settings.';
    case 'stt':
      return `Server speech-to-text failed: ${err.message}`;
    default:
      return `Speech recognition error (${err.code}). ${FIX}`;
  }
}

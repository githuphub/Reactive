/**
 * Voices: villagers speak their lines with browser TTS in their persona voice (toggle in the Demo panel), and
 * hold-V push-to-talk uses the SDK mic (browser speech recognition, else recorded audio → server STT).
 */
import { Mic, micSupport, speak, speechSupported } from '@liveforge/three';
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

/** Push-to-talk mic (lazy). Null when the browser can't record or recognise speech. */
export function getMic(lf: LiveforgeService): Mic | null {
  const s = micSupport();
  if (!s.browser && !s.record) return null;
  if (!mic) mic = new Mic(lf.status === 'off' ? null : lf.client, { mode: 'auto', language: 'en-GB' });
  return mic;
}

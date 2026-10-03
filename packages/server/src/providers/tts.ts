// Optional server-side TTS adapter (spec: SDK engine TTS is the default; no implementation ships in v1).
import type { VoiceStyle } from "@liveforge/protocol";

export interface TtsInput {
  text: string;
  voice?: VoiceStyle;
  /** Output format wanted by the client. */
  format?: "mp3" | "wav" | "ogg";
  signal?: AbortSignal;
}

export interface TtsResult {
  audio: Uint8Array;
  mimeType: string;
  durationMs?: number;
}

export interface TtsProvider {
  readonly id: string;
  synthesize(input: TtsInput): Promise<TtsResult>;
}

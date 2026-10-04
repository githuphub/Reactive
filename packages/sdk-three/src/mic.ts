// Push-to-talk microphone helper: browser SpeechRecognition when available (instant, free), else MediaRecorder ->
// server STT (POST /v1/stt via the client).
import type { LiveforgeClient } from "@liveforge/sdk";

export type MicMode = "auto" | "browser" | "server";

export interface MicOptions {
  /** "auto" (default): browser recognition when available, else record + server STT. */
  mode?: MicMode;
  /** BCP-47 language, e.g. "en-GB". Default: page language or "en-GB". */
  language?: string;
  /** Stop recording automatically after this many ms. Default 15 000. */
  maxMs?: number;
}

/** Minimal shape of the (non-standard) Web Speech recognition API. */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
  const g = globalThis as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition;
}

/**
 * Why a capture produced no transcript. `code` is the Web Speech error ("not-allowed", "network",
 * "service-not-allowed", "audio-capture", "no-speech" …) or "stt" when server speech-to-text failed.
 */
export class MicError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "MicError";
  }
}

/** What this browser supports. */
export function micSupport(): { browser: boolean; record: boolean } {
  const nav = (globalThis as { navigator?: Navigator }).navigator;
  return {
    browser: !!recognitionCtor(),
    record: !!nav?.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined",
  };
}

/**
 * Push-to-talk microphone. `start()` on key down, `stop()` on key up -> transcript.
 *
 * ```ts
 * const mic = new Mic(lf);
 * addEventListener("keydown", (e) => e.code === "KeyV" && !e.repeat && mic.start());
 * addEventListener("keyup", async (e) => { if (e.code === "KeyV") npc.talk(await mic.stop()); });
 * ```
 */
export class Mic {
  private readonly opts: Required<Pick<MicOptions, "mode" | "maxMs">> & MicOptions;
  private rec: Recognition | null = null;
  private recText = "";
  private recDone: Promise<void> | null = null;
  private recError: string | null = null;
  private media: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private mediaDone: Promise<Blob> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly client: LiveforgeClient | null, opts: MicOptions = {}) {
    this.opts = { mode: "auto", maxMs: 15_000, ...opts };
  }

  /** True while capturing. */
  get listening(): boolean {
    return !!this.rec || !!this.media;
  }

  /** The path `start()` will use, or null when nothing is supported. */
  get method(): "browser" | "server" | null {
    const s = micSupport();
    if (this.opts.mode !== "server" && s.browser) return "browser";
    if (this.opts.mode !== "browser" && s.record && this.client) return "server";
    return null;
  }

  /** Starts capturing (needs a user gesture the first time for mic permission). */
  async start(): Promise<void> {
    if (this.listening) return;
    const method = this.method;
    if (!method) throw new Error("[liveforge] no microphone path: this browser has neither SpeechRecognition nor MediaRecorder (or no client for server STT)");
    const lang = this.opts.language ?? ((typeof document !== "undefined" && document.documentElement.lang) || "en-GB");
    if (method === "browser") {
      const Ctor = recognitionCtor()!;
      const rec = new Ctor();
      rec.lang = lang;
      rec.continuous = true;
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      this.recText = "";
      this.recError = null;
      this.recDone = new Promise<void>((resolve) => {
        rec.onresult = (ev) => {
          let t = "";
          for (let i = 0; i < ev.results.length; i++) t += `${ev.results[i][0]?.transcript ?? ""} `;
          this.recText = t.trim();
        };
        rec.onerror = (ev) => {
          this.recError = ev.error ?? "unknown";
          resolve();
        };
        rec.onend = () => resolve();
      });
      this.rec = rec;
      rec.start();
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported?.(m));
      const media = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
      this.chunks = [];
      this.mediaDone = new Promise<Blob>((resolve) => {
        media.ondataavailable = (e) => {
          if (e.data.size) this.chunks.push(e.data);
        };
        media.onstop = () => resolve(new Blob(this.chunks, { type: media.mimeType || mime || "audio/webm" }));
      });
      this.media = media;
      media.start();
    }
    this.timer = setTimeout(() => void this.stop(), this.opts.maxMs);
  }

  /** Stops capturing and returns the transcript ("" when nothing was heard). */
  async stop(): Promise<string> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.rec) {
      const rec = this.rec;
      this.rec = null;
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
      await Promise.race([this.recDone, new Promise((r) => setTimeout(r, 2500))]);
      if (!this.recText && this.recError && this.recError !== "no-speech" && this.recError !== "aborted") {
        throw new MicError(this.recError, `speech recognition failed: ${this.recError}`);
      }
      return this.recText;
    }
    if (this.media) {
      const media = this.media;
      this.media = null;
      if (media.state !== "inactive") media.stop();
      const blob = await this.mediaDone!;
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;
      if (!blob.size || !this.client) return "";
      try {
        const res = await this.client.stt(blob, { language: (this.opts.language ?? "en").slice(0, 2) });
        return res.text.trim();
      } catch (err) {
        throw new MicError("stt", (err as Error).message);
      }
    }
    return "";
  }

  /** Stops without transcribing. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      this.rec?.abort();
    } catch {
      /* ignore */
    }
    this.rec = null;
    if (this.media && this.media.state !== "inactive") this.media.stop();
    this.media = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

/** Creates a push-to-talk Mic (`start()` / `stop()` -> transcript). Same as `new Mic(client, opts)`. */
export function createMic(client: LiveforgeClient | null, opts: MicOptions = {}): Mic {
  return new Mic(client, opts);
}

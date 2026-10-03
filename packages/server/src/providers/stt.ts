// Speech-to-text adapters: OpenAI Whisper API (fetch + multipart) and local whisper.cpp (spawned binary).
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SttInput {
  audio: Uint8Array;
  /** e.g. "audio/wav", "audio/webm", "audio/ogg". */
  mimeType: string;
  /** ISO-639-1 hint ("en"). */
  language?: string;
  /** Optional prompt (persona names, glossary) to bias recognition. */
  prompt?: string;
  signal?: AbortSignal;
}

export interface SttResult {
  text: string;
  language?: string;
  durationMs?: number;
}

export interface SttProvider {
  readonly id: string;
  transcribe(input: SttInput): Promise<SttResult>;
}

const EXT: Record<string, string> = {
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/webm": "webm", "audio/ogg": "ogg",
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/flac": "flac",
};
export const extFor = (mime: string) => EXT[mime.split(";")[0].trim().toLowerCase()] ?? "wav";

/** OpenAI audio transcription API (whisper-1 by default). */
export class OpenAiWhisperStt implements SttProvider {
  readonly id = "openai";
  constructor(private readonly cfg: { apiKey: string; baseUrl: string; model: string; fetch?: typeof fetch }) {}

  async transcribe(input: SttInput): Promise<SttResult> {
    const started = Date.now();
    const form = new FormData();
    const type = input.mimeType.split(";")[0];
    form.append("file", new Blob([input.audio as Uint8Array<ArrayBuffer>], { type }), `audio.${extFor(input.mimeType)}`);
    form.append("model", this.cfg.model);
    form.append("response_format", "json");
    if (input.language) form.append("language", input.language);
    if (input.prompt) form.append("prompt", input.prompt.slice(0, 800));
    const res = await (this.cfg.fetch ?? fetch)(`${this.cfg.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
      body: form,
      signal: input.signal,
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`OpenAI STT failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    const json = JSON.parse(body) as { text?: string; language?: string };
    return { text: (json.text ?? "").trim(), language: json.language ?? input.language, durationMs: Date.now() - started };
  }
}

/**
 * whisper.cpp CLI (`whisper-cli` / `main`): writes the audio to a temp file, converts non-WAV input to 16 kHz mono
 * WAV with ffmpeg when FFMPEG_BIN is set, runs `<bin> -m <model> -f <file> -nt -np -otxt -of <out>` and reads the
 * .txt it writes. whisper.cpp itself only accepts 16-bit WAV (16 kHz).
 */
export class WhisperCppStt implements SttProvider {
  readonly id = "whispercpp";
  constructor(private readonly cfg: { bin: string; model: string; threads: number; ffmpegBin: string | null; timeoutMs?: number }) {}

  async transcribe(input: SttInput): Promise<SttResult> {
    const started = Date.now();
    const dir = await mkdtemp(join(tmpdir(), "liveforge-stt-"));
    try {
      const ext = extFor(input.mimeType);
      let wav = join(dir, `in.${ext}`);
      await writeFile(wav, input.audio);
      if (ext !== "wav") {
        if (!this.cfg.ffmpegBin) throw new Error(`whisper.cpp needs WAV input; got ${input.mimeType} (set FFMPEG_BIN to convert)`);
        const conv = join(dir, "in16k.wav");
        await run(this.cfg.ffmpegBin, ["-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", conv], this.cfg.timeoutMs ?? 30_000, input.signal);
        wav = conv;
      }
      const outBase = join(dir, "out");
      const args = ["-m", this.cfg.model, "-f", wav, "-t", String(this.cfg.threads), "-nt", "-np", "-otxt", "-of", outBase];
      if (input.language) args.push("-l", input.language);
      if (input.prompt) args.push("--prompt", input.prompt.slice(0, 400));
      const stdout = await run(this.cfg.bin, args, this.cfg.timeoutMs ?? 60_000, input.signal);
      let text = "";
      try {
        text = await readFile(`${outBase}.txt`, "utf8");
      } catch {
        text = stdout;
      }
      return { text: text.replace(/\s+/g, " ").trim(), language: input.language, durationMs: Date.now() - started };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function run(bin: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    const kill = () => p.kill("SIGKILL");
    const timer = setTimeout(() => { kill(); reject(new Error(`${bin} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (code === 0) resolve(out);
      else reject(new Error(`${bin} exited with ${code}: ${err.slice(-300)}`));
    });
  });
}

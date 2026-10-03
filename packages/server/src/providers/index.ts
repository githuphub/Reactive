// Build provider instances from config (only those with keys / binaries configured).
import type { ServerConfig } from "../config.js";
import type { Logger } from "../log.js";
import { ClaudeProvider, DEFAULT_MODELS } from "./claude.js";
import type { LlmProvider } from "./llm.js";
import { Hyper3DProvider, type Mesh3DProvider } from "./mesh3d.js";
import { OpenAiWhisperStt, WhisperCppStt, type SttProvider } from "./stt.js";
import type { TtsProvider } from "./tts.js";

export * from "./llm.js";
export * from "./stt.js";
export * from "./mesh3d.js";
export * from "./tts.js";
export { ClaudeProvider, DEFAULT_MODELS, DEFAULT_PRICES, priceFor } from "./claude.js";

export interface Providers {
  llm: LlmProvider | null;
  stt: SttProvider | null;
  mesh3d: Mesh3DProvider | null;
  tts: TtsProvider | null;
}

export function createProviders(cfg: ServerConfig, log: Logger): Providers {
  let llm: LlmProvider | null = null;
  if (cfg.llm.provider === "claude" && cfg.llm.anthropicApiKey) {
    llm = new ClaudeProvider({
      apiKey: cfg.llm.anthropicApiKey,
      models: { fast: cfg.llm.modelFast ?? DEFAULT_MODELS.fast, rich: cfg.llm.modelRich ?? DEFAULT_MODELS.rich },
      timeoutMs: cfg.llm.timeoutMs,
      structuredMode: cfg.llm.structuredMode,
      effort: cfg.llm.effort,
      refusalFallback: cfg.llm.refusalFallback,
      log: log.child("claude"),
    });
  }
  let stt: SttProvider | null = null;
  if (cfg.stt.provider === "openai" && cfg.stt.openaiApiKey) {
    stt = new OpenAiWhisperStt({ apiKey: cfg.stt.openaiApiKey, baseUrl: cfg.stt.openaiBaseUrl, model: cfg.stt.openaiModel });
  } else if (cfg.stt.provider === "whispercpp" && cfg.stt.whisperCppBin && cfg.stt.whisperCppModel) {
    stt = new WhisperCppStt({ bin: cfg.stt.whisperCppBin, model: cfg.stt.whisperCppModel, threads: cfg.stt.whisperCppThreads, ffmpegBin: cfg.stt.ffmpegBin });
  }
  const mesh3d = cfg.mesh3d.provider === "hyper3d" && cfg.mesh3d.hyper3dApiKey
    ? new Hyper3DProvider({ apiKey: cfg.mesh3d.hyper3dApiKey, baseUrl: cfg.mesh3d.hyper3dBaseUrl })
    : null;
  log.info("providers", { llm: llm?.id ?? "none (rules only)", stt: stt?.id ?? "none", mesh3d: mesh3d?.id ?? "none", tts: "none (SDK engine TTS)" });
  return { llm, stt, mesh3d, tts: null };
}

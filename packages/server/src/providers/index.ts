// Build provider instances from config (only those with keys / binaries configured).
import type { ServerConfig } from "../config.js";
import type { Logger } from "../log.js";
import { ClaudeProvider, DEFAULT_MODELS } from "./claude.js";
import { cassettes } from "./cassette.js";
import type { LlmProvider } from "./llm.js";
import { Hyper3DProvider, type Mesh3DProvider } from "./mesh3d.js";
import { OpenAiWhisperStt, WhisperCppStt, type SttProvider } from "./stt.js";
import type { TtsProvider } from "./tts.js";

export * from "./llm.js";
export * from "./stt.js";
export * from "./mesh3d.js";
export * from "./tts.js";
export { ClaudeProvider, DEFAULT_MODELS, DEFAULT_PRICES, priceFor } from "./claude.js";
export * from "./cassette.js";

export interface Providers {
  llm: LlmProvider | null;
  stt: SttProvider | null;
  mesh3d: Mesh3DProvider | null;
  tts: TtsProvider | null;
}

export function createProviders(cfg: ServerConfig, log: Logger): Providers {
  let llm: LlmProvider | null = null;
  // K7 cassettes: replay mode builds the provider even without a key (answers come from ./cassettes).
  const tapes = cassettes();
  tapes.attachLog(log.child("cassettes"));
  tapes.liveAvailable = !!cfg.llm.anthropicApiKey;
  if (tapes.mode === "record" && !tapes.liveAvailable) log.warn("LIVEFORGE_PROVIDER_MODE=record needs ANTHROPIC_API_KEY: nothing will be recorded");
  if (cfg.llm.provider === "claude" && (cfg.llm.anthropicApiKey || tapes.mode === "replay")) {
    llm = new ClaudeProvider({
      apiKey: cfg.llm.anthropicApiKey ?? "replay-only-no-key",
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
  if (llm) log.info(`llm: ${llm.id} (${tapes.describe()})`);
  log.info("providers", { llm: llm?.id ?? "none (rules only)", stt: stt?.id ?? "none", mesh3d: mesh3d?.id ?? "none", tts: "none (SDK engine TTS)" });
  return { llm, stt, mesh3d, tts: null };
}

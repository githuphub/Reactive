// Server configuration from environment variables (see .env.example). Provider keys live ONLY here.
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { LogLevel } from "./log.js";

export interface ServerConfig {
  port: number;
  host: string;
  /** SQLite file (":memory:" allowed). */
  dbPath: string;
  /** Generated assets (GLBs from Hyper3D) are stored here and served at /v1/assets/:file. */
  dataDir: string;
  /** Manifest files to load (one game each). */
  manifests: string[];
  /** gameId -> publishable SDK keys. */
  sdkKeys: Record<string, string[]>;
  /** Admin key (dashboard / admin routes). Covers every game. */
  adminKey: string | null;
  /** Dev mode: accept `pk_dev_<gameId>` SDK keys and `dev-admin` as admin key when none are configured. */
  dev: boolean;
  corsOrigins: string[];
  /** Requests per minute per SDK key. */
  rateLimitPerMin: number;
  logLevel: LogLevel;
  llm: {
    provider: "claude" | "none";
    anthropicApiKey: string | null;
    /** Tier overrides (else manifest models.fast / models.rich). */
    modelFast: string | null;
    modelRich: string | null;
    timeoutMs: number;
    structuredMode: "output_config" | "strict_tool";
    /** output_config.effort for models that support it (not Haiku). */
    effort: "low" | "medium" | "high";
    /** Server-side refusal fallbacks ("default" mode) on models that support them. */
    refusalFallback: boolean;
    /** $ per million tokens [input, output] by model id (merged over defaults). */
    prices: Record<string, [number, number]>;
  };
  stt: {
    provider: "openai" | "whispercpp" | "none";
    openaiApiKey: string | null;
    openaiBaseUrl: string;
    openaiModel: string;
    whisperCppBin: string | null;
    whisperCppModel: string | null;
    whisperCppThreads: number;
    ffmpegBin: string | null;
    maxBytes: number;
  };
  mesh3d: {
    provider: "hyper3d" | "none";
    hyper3dApiKey: string | null;
    hyper3dBaseUrl: string;
    pollMs: number;
  };
  /** Projection checkpoint flush interval. */
  flushMs: number;
  /** A world is "active" (ticks run) if it saw an event within this window. */
  activeWorldMs: number;
}

const str = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);
const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
};
const bool = (v: string | undefined, d: boolean): boolean => (v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(v));

/** "counterforge=pk_a|pk_b, godot-village=pk_c" -> { counterforge: [pk_a, pk_b], ... } */
function parseKeys(v: string | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of (v ?? "").split(/[,;\s]+/).filter(Boolean)) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const game = part.slice(0, i);
    (out[game] ??= []).push(...part.slice(i + 1).split("|").filter(Boolean));
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dev = bool(env.LIVEFORGE_DEV, env.NODE_ENV !== "production");
  // Default: ./liveforge.yaml, else (dev convenience) every examples/*.liveforge.yaml.
  let defaultManifests = "liveforge.yaml";
  if (!env.LIVEFORGE_MANIFESTS && !existsSync("liveforge.yaml") && existsSync("examples")) {
    const ex = readdirSync("examples").filter((f) => f.endsWith(".liveforge.yaml")).map((f) => `examples/${f}`);
    if (ex.length) defaultManifests = ex.join(",");
  }
  const manifests = (env.LIVEFORGE_MANIFESTS ?? defaultManifests)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => resolve(p));
  let prices: Record<string, [number, number]> = {};
  if (env.LIVEFORGE_PRICES) {
    try {
      prices = JSON.parse(env.LIVEFORGE_PRICES);
    } catch {
      /* ignored; logged at startup */
    }
  }
  const sttProvider = (str(env.LIVEFORGE_STT) ?? (str(env.OPENAI_API_KEY) ? "openai" : str(env.WHISPER_CPP_BIN) ? "whispercpp" : "none")) as ServerConfig["stt"]["provider"];
  return {
    port: num(env.PORT, 8787),
    host: env.HOST ?? "0.0.0.0",
    dbPath: env.LIVEFORGE_DB ?? resolve("data/liveforge.sqlite"),
    dataDir: resolve(env.LIVEFORGE_DATA_DIR ?? "data"),
    manifests,
    sdkKeys: parseKeys(env.LIVEFORGE_SDK_KEYS),
    adminKey: str(env.LIVEFORGE_ADMIN_KEY),
    dev,
    corsOrigins: (env.LIVEFORGE_CORS_ORIGINS ?? "*").split(",").map((s) => s.trim()).filter(Boolean),
    rateLimitPerMin: num(env.LIVEFORGE_RATE_LIMIT_PER_MIN, 600),
    logLevel: (env.LIVEFORGE_LOG_LEVEL as LogLevel) ?? "info",
    llm: {
      provider: env.LIVEFORGE_LLM_PROVIDER === "none" ? "none" : "claude",
      anthropicApiKey: str(env.ANTHROPIC_API_KEY),
      modelFast: str(env.LIVEFORGE_MODEL_FAST),
      modelRich: str(env.LIVEFORGE_MODEL_RICH),
      timeoutMs: num(env.LIVEFORGE_LLM_TIMEOUT_MS, 8000),
      structuredMode: env.LIVEFORGE_LLM_STRUCTURED_MODE === "strict_tool" ? "strict_tool" : "output_config",
      effort: (["low", "medium", "high"].includes(env.LIVEFORGE_LLM_EFFORT ?? "") ? env.LIVEFORGE_LLM_EFFORT : "low") as "low",
      refusalFallback: bool(env.LIVEFORGE_REFUSAL_FALLBACK, true),
      prices,
    },
    stt: {
      provider: ["openai", "whispercpp", "none"].includes(sttProvider) ? sttProvider : "none",
      openaiApiKey: str(env.OPENAI_API_KEY),
      openaiBaseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      openaiModel: env.OPENAI_STT_MODEL ?? "whisper-1",
      whisperCppBin: str(env.WHISPER_CPP_BIN),
      whisperCppModel: str(env.WHISPER_CPP_MODEL),
      whisperCppThreads: num(env.WHISPER_CPP_THREADS, 4),
      ffmpegBin: str(env.FFMPEG_BIN),
      maxBytes: num(env.LIVEFORGE_STT_MAX_BYTES, 10 * 1024 * 1024),
    },
    mesh3d: {
      provider: str(env.HYPER3D_API_KEY) ? "hyper3d" : "none",
      hyper3dApiKey: str(env.HYPER3D_API_KEY),
      hyper3dBaseUrl: env.HYPER3D_BASE_URL ?? "https://api.hyper3d.com/api/v2",
      pollMs: num(env.HYPER3D_POLL_MS, 5000),
    },
    flushMs: num(env.LIVEFORGE_FLUSH_MS, 2000),
    activeWorldMs: num(env.LIVEFORGE_ACTIVE_WORLD_MS, 30 * 60_000),
  };
}

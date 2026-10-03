// LLM adapter interface. The Claude implementation is in claude.ts; any provider with structured JSON output can
// implement this. Modules never call a provider directly: they use ctx.llm (budget-, cache- and metrics-aware).

export type LlmTier = "fast" | "rich";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmCallOptions {
  /** Model tier (mapped to a model id by manifest models.* / env). Default "fast". */
  tier?: LlmTier;
  /** Explicit model id (overrides the tier mapping). */
  model?: string;
  /** Default 500 for json, 600 for stream. */
  maxTokens?: number;
  /** Hard timeout; the request is aborted. Default from LIVEFORGE_LLM_TIMEOUT_MS (8000). */
  timeoutMs?: number;
  /** External cancellation. */
  signal?: AbortSignal;
  /**
   * json() only: stream one top-level string field of the structured answer sentence by sentence while the
   * JSON is generated (npc.reply streams `text` this way). Put that field FIRST in the schema's properties.
   */
  stream?: { field: string; onSentence: (sentence: string) => void };
}

export interface LlmJsonResult<T = unknown> {
  /** Parsed JSON, UNTRUSTED: validate / clamp before use. */
  value: T;
  usage: LlmUsage;
  model: string;
  ms: number;
}

export interface LlmStreamOptions extends Omit<LlmCallOptions, "stream"> {
  /** Called for each complete sentence as text streams in. */
  onSentence?: (sentence: string) => void;
}

export interface LlmTextResult {
  text: string;
  usage: LlmUsage;
  model: string;
  ms: number;
}

export interface LlmProvider {
  readonly id: string;
  /** Resolve the model id for a tier (after env / manifest mapping). */
  modelFor(tier: LlmTier, override?: string): string;
  /**
   * Structured output: `schema` is a JSON Schema in the Anthropic structured-output subset (every object
   * `additionalProperties: false`, every property `required`, no min/max/pattern). Throws TimeoutError,
   * TruncatedError (max_tokens / refusal), or provider errors. Never retries (maxRetries 0): callers fall back.
   */
  json<T = unknown>(schema: object, system: string, user: string, opts?: LlmCallOptions & { models?: TierModels }): Promise<LlmJsonResult<T>>;
  /** Plain text, streamed; onSentence receives sentence chunks for TTS. */
  stream(system: string, user: string, opts?: LlmStreamOptions & { models?: TierModels }): Promise<LlmTextResult>;
}

/** Tier -> model mapping (manifest models.fast / models.rich, overridden by env). */
export interface TierModels {
  fast: string;
  rich: string;
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`LLM call timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/** The model stopped early (max_tokens / refusal): a retry with the same prompt would do the same. */
export class TruncatedError extends Error {
  constructor(public readonly reason: string) {
    super(`LLM answer incomplete (stop_reason ${reason})`);
    this.name = "TruncatedError";
  }
}

// ---------------------------------------------------------------- sentence chunking

/**
 * Splits streaming text into sentences. push() returns completed sentences; flush() returns the remainder.
 * A sentence ends at . ! ? … (optionally followed by closing quotes/brackets) + whitespace, or a newline.
 */
export class SentenceSplitter {
  private buf = "";
  constructor(private readonly minChars = 12) {}
  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    const re = /([.!?…]+["'”’)\]]*)(\s+)|\n+/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.buf))) {
      const end = m.index + (m[1]?.length ?? 0);
      const candidate = this.buf.slice(last, end).trim();
      if (candidate.length >= this.minChars || m[0].startsWith("\n")) {
        if (candidate) out.push(candidate);
        last = m.index + m[0].length;
      }
    }
    this.buf = this.buf.slice(last);
    return out;
  }
  flush(): string | null {
    const rest = this.buf.trim();
    this.buf = "";
    return rest || null;
  }
}

/**
 * Incrementally extracts the value of one top-level string field from a JSON object being streamed
 * (`{"text":"Hello there. How are` ...). Feed raw JSON deltas; returns newly decoded characters of that field.
 */
export class JsonFieldStreamer {
  private raw = "";
  private pos = 0;
  private state: "seek" | "in" | "done" = "seek";
  private escape = false;
  private unicode = "";
  constructor(private readonly field: string) {}
  push(delta: string): string {
    if (this.state === "done") return "";
    this.raw += delta;
    let out = "";
    if (this.state === "seek") {
      const re = new RegExp(`"${this.field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:\\s*"`);
      const m = re.exec(this.raw);
      if (!m) return "";
      this.pos = m.index + m[0].length;
      this.state = "in";
    }
    while (this.pos < this.raw.length) {
      const c = this.raw[this.pos++];
      if (this.unicode) {
        this.unicode += c;
        if (this.unicode.length === 5) {
          out += String.fromCharCode(parseInt(this.unicode.slice(1), 16));
          this.unicode = "";
        }
        continue;
      }
      if (this.escape) {
        this.escape = false;
        if (c === "u") { this.unicode = "u"; continue; }
        out += ({ n: "\n", t: "\t", r: "", b: "", f: "", '"': '"', "\\": "\\", "/": "/" } as Record<string, string>)[c] ?? c;
        continue;
      }
      if (c === "\\") { this.escape = true; continue; }
      if (c === '"') { this.state = "done"; break; }
      out += c;
    }
    return out;
  }
}

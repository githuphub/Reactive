// Claude implementation of LlmProvider (ported from Counterforge packages/pipeline/src/llm.ts: structured outputs
// via output_config or a strict `emit` tool, hard timeout + abort, maxRetries 0, truncation guard) plus
// sentence-chunk streaming. No live calls happen unless ANTHROPIC_API_KEY is configured and a module asks.
import Anthropic from "@anthropic-ai/sdk";
import {
  JsonFieldStreamer, SentenceSplitter, TimeoutError, TruncatedError,
  type LlmCallOptions, type LlmJsonResult, type LlmProvider, type LlmStreamOptions, type LlmTextResult, type LlmTier,
  type TierModels,
} from "./llm.js";
import type { Logger } from "../log.js";

export const DEFAULT_MODELS: TierModels = { fast: "claude-haiku-4-5", rich: "claude-sonnet-5-5" };
export const DEFAULT_MAX_TOKENS = 500;

/** $ per million tokens [input, output] (Anthropic first-party list prices; override with LIVEFORGE_PRICES). */
export const DEFAULT_PRICES: Record<string, [number, number]> = {
  "claude-haiku-4-5": [1, 5],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
};

export interface ClaudeOptions {
  apiKey: string;
  models: TierModels;
  timeoutMs: number;
  structuredMode: "output_config" | "strict_tool";
  effort: "low" | "medium" | "high";
  refusalFallback: boolean;
  log: Logger;
}

/** Per-model request knobs (thinking / effort / fallbacks differ by model family). */
function modelTraits(model: string) {
  const haiku = /haiku/.test(model);
  const sonnet55 = /sonnet-5-5/.test(model);
  const fallbackCapable = /(sonnet-5-5|opus-5|fable-5)/.test(model);
  return {
    effort: !haiku && /(sonnet-5|opus-5|opus-4-[5-8]|fable)/.test(model),
    // Sonnet 5.5 turns thinking off with "between_tools" (effort <= high); short game answers don't need it.
    thinking: sonnet55 ? { type: "between_tools" } : undefined,
    // Opus 5.5 always thinks: leave room for it.
    minTokens: /opus-5-5|fable/.test(model) ? 2000 : 0,
    fallback: fallbackCapable,
  };
}

export function priceFor(model: string, prices: Record<string, [number, number]>): [number, number] {
  return prices[model] ?? DEFAULT_PRICES[model] ?? [3, 15];
}

type AnyMessage = {
  content: Array<{ type: string; text?: string; input?: unknown }>;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
};

export class ClaudeProvider implements LlmProvider {
  readonly id = "claude";
  private readonly client: Anthropic;
  private fallbackOk: boolean;

  constructor(private readonly opts: ClaudeOptions) {
    this.client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 0 });
    this.fallbackOk = opts.refusalFallback;
  }

  modelFor(tier: LlmTier, override?: string, models?: TierModels): string {
    if (override) return override;
    const m = models ?? this.opts.models;
    return tier === "rich" ? m.rich : m.fast;
  }

  private buildParams(model: string, system: string, user: string, schema: object | null, maxTokens: number, mode: "output_config" | "strict_tool") {
    const t = modelTraits(model);
    const params: Record<string, unknown> = {
      model,
      max_tokens: Math.max(maxTokens, t.minTokens),
      messages: [{ role: "user", content: user }],
    };
    if (t.thinking) params.thinking = t.thinking;
    const outputConfig: Record<string, unknown> = {};
    if (t.effort) outputConfig.effort = this.opts.effort;
    if (schema && mode === "strict_tool") {
      params.system = `${system}\n\nCall the \`emit\` tool exactly once with your answer.`;
      params.tools = [{ name: "emit", description: "Emit the final structured answer.", input_schema: schema, strict: true }];
      params.tool_choice = { type: "auto" };
    } else {
      params.system = system;
      if (schema) outputConfig.format = { type: "json_schema", schema };
    }
    if (Object.keys(outputConfig).length) params.output_config = outputConfig;
    const useFallback = this.fallbackOk && t.fallback;
    if (useFallback) {
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    return { params, useFallback };
  }

  /** Runs a request with a hard timeout; disables refusal fallbacks for the process if the API rejects them. */
  private async run<T>(model: string, build: (useFallbackAllowed: boolean) => { exec: (signal: AbortSignal) => Promise<T>; useFallback: boolean }, timeoutMs: number, external?: AbortSignal): Promise<T> {
    const attempt = async (allowFallback: boolean): Promise<T> => {
      const { exec, useFallback } = build(allowFallback);
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      external?.addEventListener("abort", onAbort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new TimeoutError(timeoutMs));
          ac.abort();
        }, timeoutMs);
      });
      const request = exec(ac.signal);
      try {
        return await Promise.race([request, timeout]);
      } catch (e) {
        if (useFallback && e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) {
          this.fallbackOk = false;
          this.opts.log.warn("refusal fallbacks rejected by the API; disabled for this process", { model });
          return attempt(false);
        }
        throw e;
      } finally {
        clearTimeout(timer);
        external?.removeEventListener("abort", onAbort);
        // a late rejection from the abandoned request must not become an unhandled rejection
        request.catch(() => {});
      }
    };
    return attempt(true);
  }

  async json<T = unknown>(schema: object, system: string, user: string, opts: LlmCallOptions & { models?: TierModels } = {}): Promise<LlmJsonResult<T>> {
    const model = this.modelFor(opts.tier ?? "fast", opts.model, opts.models);
    const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs;
    const mode = this.opts.structuredMode;
    const started = Date.now();
    const msg = await this.run<AnyMessage>(model, (allowFallback) => {
      const { params, useFallback } = this.buildParams(model, system, user, schema, opts.maxTokens ?? DEFAULT_MAX_TOKENS, mode);
      if (!allowFallback) { delete params.betas; delete params.fallbacks; }
      const fb = allowFallback && useFallback;
      const api = (fb ? this.client.beta.messages : this.client.messages) as unknown as {
        create(p: unknown, o: { signal: AbortSignal }): Promise<AnyMessage>;
        stream(p: unknown, o: { signal: AbortSignal }): AsyncIterable<{ type: string; delta?: { type: string; text?: string; partial_json?: string } }> & { finalMessage(): Promise<AnyMessage> };
      };
      if (!opts.stream) return { useFallback: fb, exec: (signal) => api.create(params, { signal }) };
      return {
        useFallback: fb,
        exec: async (signal) => {
          const s = api.stream(params, { signal });
          const field = new JsonFieldStreamer(opts.stream!.field);
          const split = new SentenceSplitter();
          for await (const ev of s) {
            if (ev.type !== "content_block_delta" || !ev.delta) continue;
            const raw = ev.delta.type === "text_delta" ? ev.delta.text : ev.delta.type === "input_json_delta" ? ev.delta.partial_json : undefined;
            if (!raw) continue;
            for (const sentence of split.push(field.push(raw))) opts.stream!.onSentence(sentence);
          }
          const rest = split.flush();
          if (rest) opts.stream!.onSentence(rest);
          return s.finalMessage();
        },
      };
    }, timeoutMs, opts.signal);

    if (msg.stop_reason === "max_tokens" || msg.stop_reason === "refusal") throw new TruncatedError(msg.stop_reason);
    let value: unknown;
    if (mode === "strict_tool") {
      const block = msg.content.find((b) => b.type === "tool_use");
      if (!block) throw new Error("no tool_use block in response");
      value = block.input;
    } else {
      const block = msg.content.find((b) => b.type === "text");
      if (!block || typeof block.text !== "string") throw new Error("no text block in response");
      value = JSON.parse(block.text);
    }
    return {
      value: value as T,
      usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
      model: msg.model ?? model,
      ms: Date.now() - started,
    };
  }

  async stream(system: string, user: string, opts: LlmStreamOptions & { models?: TierModels } = {}): Promise<LlmTextResult> {
    const model = this.modelFor(opts.tier ?? "fast", opts.model, opts.models);
    const timeoutMs = opts.timeoutMs ?? this.opts.timeoutMs;
    const started = Date.now();
    let text = "";
    const msg = await this.run<AnyMessage>(model, (allowFallback) => {
      const { params, useFallback } = this.buildParams(model, system, user, null, opts.maxTokens ?? 600, "output_config");
      if (!allowFallback) { delete params.betas; delete params.fallbacks; }
      const fb = allowFallback && useFallback;
      const api = (fb ? this.client.beta.messages : this.client.messages) as unknown as {
        stream(p: unknown, o: { signal: AbortSignal }): AsyncIterable<{ type: string; delta?: { type: string; text?: string } }> & { finalMessage(): Promise<AnyMessage> };
      };
      return {
        useFallback: fb,
        exec: async (signal) => {
          text = "";
          const s = api.stream(params, { signal });
          const split = new SentenceSplitter();
          for await (const ev of s) {
            if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
              text += ev.delta.text;
              if (opts.onSentence) for (const sentence of split.push(ev.delta.text)) opts.onSentence(sentence);
            }
          }
          const rest = split.flush();
          if (rest && opts.onSentence) opts.onSentence(rest);
          return s.finalMessage();
        },
      };
    }, timeoutMs, opts.signal);
    if (msg.stop_reason === "refusal") throw new TruncatedError("refusal");
    return {
      text: text.trim(),
      usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
      model: msg.model ?? model,
      ms: Date.now() - started,
    };
  }
}

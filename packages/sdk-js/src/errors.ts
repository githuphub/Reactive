// Errors thrown / reported by the SDK. Server errors keep the server's `code`; transport problems get SDK codes.
import type { ErrorCode } from "@liveforge/protocol";

/**
 * Error codes: every server `ErrorCode`, plus SDK-side ones:
 * - `network`: the server could not be reached (offline, DNS, CORS, connection reset).
 * - `offline`: the client runs in `offline` mode and no local answer exists.
 * - `no_fallback`: the server failed and no cache / pack / fallback answer exists.
 * - `closed`: the client was closed.
 * - `invalid_input`: a bad argument (bad signal type, missing player ...), caught before any request.
 */
export type LiveforgeErrorCode = ErrorCode | "network" | "offline" | "no_fallback" | "closed" | "invalid_input";

const RETRYABLE: ReadonlySet<string> = new Set(["network", "timeout", "rate_limited", "provider_unavailable", "internal"]);

/** Every error the SDK throws or passes to `onError`. */
export class LiveforgeError extends Error {
  /** Machine-readable code (server ErrorCode or an SDK code). */
  readonly code: LiveforgeErrorCode;
  /** HTTP status, when the error came from a response. */
  readonly status?: number;
  /** Server-provided details (e.g. validation issues). */
  readonly details?: unknown;

  constructor(code: LiveforgeErrorCode, message: string, opts: { status?: number; details?: unknown; cause?: unknown } = {}) {
    super(`[liveforge] ${message}`, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "LiveforgeError";
    this.code = code;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.details !== undefined) this.details = opts.details;
  }

  /** True when retrying later may succeed (network trouble, timeouts, rate limits, 5xx). */
  get retryable(): boolean {
    return RETRYABLE.has(this.code) || (this.status !== undefined && this.status >= 500);
  }
}

/** Narrowing helper. */
export const isLiveforgeError = (e: unknown): e is LiveforgeError => e instanceof LiveforgeError;

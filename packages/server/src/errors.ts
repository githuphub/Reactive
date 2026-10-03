import type { ErrorCode } from "@liveforge/protocol";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, rate_limited: 429, budget_exceeded: 429,
  moderated: 422, invalid_manifest: 422, unknown_kind: 404, module_disabled: 409, provider_unavailable: 503,
  provider_error: 502, timeout: 504, internal: 500,
};

/** Throw anywhere in a handler; the HTTP layer turns it into {error:{code,message,details}} with the right status. */
export class LfError extends Error {
  readonly status: number;
  constructor(public readonly code: ErrorCode, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "LfError";
    this.status = STATUS[code];
  }
}

export class BudgetExceededError extends LfError {
  constructor(message: string, details?: unknown) {
    super("budget_exceeded", message, details);
    this.name = "BudgetExceededError";
  }
}

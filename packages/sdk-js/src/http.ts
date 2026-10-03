// HTTP transport: JSON requests with auth headers, timeouts and Liveforge error mapping.
import { HEADERS, type ErrorCode } from "@liveforge/protocol";
import { LiveforgeError } from "./errors.js";
import { isPlainObject, joinUrl, withQuery } from "./util.js";

export type FetchLike = typeof fetch;

export interface HttpRequest {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON body (serialised) ... */
  json?: unknown;
  /** ... or a raw body (audio upload). */
  body?: BodyInit;
  contentType?: string;
  timeoutMs?: number;
  /** Survives page unload (signal flush on pagehide). Body must be < 64 KB. */
  keepalive?: boolean;
  signal?: AbortSignal;
}

export interface HttpResponse<T> {
  status: number;
  /** Parsed JSON body (undefined for 204 / empty bodies). */
  data: T | undefined;
}

const SERVER_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "bad_request", "unauthorized", "forbidden", "not_found", "rate_limited", "budget_exceeded", "moderated",
  "invalid_manifest", "unknown_kind", "module_disabled", "provider_unavailable", "provider_error", "timeout", "internal",
]);

/** Thin fetch wrapper used by the client. */
export class Http {
  constructor(
    readonly baseUrl: string,
    private readonly key: string,
    private readonly fetchImpl: FetchLike,
    private readonly defaultTimeoutMs: number,
  ) {}

  /**
   * Headers every request carries (exposed for asset loaders such as GLTFLoader.setRequestHeader). Only the key:
   * the server's CORS policy allows Content-Type, Authorization and the Liveforge key / game headers.
   */
  authHeaders(): Record<string, string> {
    return { [HEADERS.key]: this.key };
  }

  /** Absolute URL for a server path. */
  url(path: string, query?: HttpRequest["query"]): string {
    return withQuery(/^https?:\/\//.test(path) ? path : joinUrl(this.baseUrl, path), query ?? {});
  }

  async request<T>(req: HttpRequest): Promise<HttpResponse<T>> {
    const ctrl = new AbortController();
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs) : null;
    const onAbort = () => ctrl.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    const headers: Record<string, string> = { ...this.authHeaders(), accept: "application/json" };
    let body: BodyInit | undefined;
    if (req.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(req.json);
    } else if (req.body !== undefined) {
      if (req.contentType) headers["content-type"] = req.contentType;
      body = req.body;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(req.path, req.query), {
        method: req.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        ...(req.keepalive ? { keepalive: true } : {}),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (timedOut) throw new LiveforgeError("timeout", `${req.method} ${req.path} timed out after ${timeoutMs} ms`, { cause: err });
      throw new LiveforgeError("network", `cannot reach the Liveforge server at ${this.baseUrl} (${req.method} ${req.path})`, { cause: err });
    } finally {
      if (timer) clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    }
    const text = res.status === 204 ? "" : await res.text().catch(() => "");
    let data: unknown;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (!res.ok) {
      const e = isPlainObject(data) && isPlainObject(data.error) ? data.error : null;
      const code = e && typeof e.code === "string" && SERVER_CODES.has(e.code) ? (e.code as ErrorCode) : statusCode(res.status);
      const msg = e && typeof e.message === "string" ? e.message : `${req.method} ${req.path} failed with HTTP ${res.status}`;
      throw new LiveforgeError(code, msg, { status: res.status, details: e?.details });
    }
    return { status: res.status, data: data as T | undefined };
  }
}

function statusCode(status: number): ErrorCode {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 504) return "timeout";
  if (status === 503) return "provider_unavailable";
  return "internal";
}

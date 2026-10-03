// Small runtime helpers shared by the client modules.

/** JSON with sorted object keys and `undefined` dropped: equal values give equal strings (cache keys). */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Random wire-safe id (`[a-z0-9_]`, <= 64 chars), e.g. `a_lq3k2x9f0c1b2d3e`. */
export function randomId(prefix: string): string {
  let r = "";
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === "function") {
    const buf = new Uint8Array(12);
    c.getRandomValues(buf);
    for (const b of buf) r += ALPHABET[b % ALPHABET.length];
  } else {
    for (let i = 0; i < 12; i++) r += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `${prefix}_${Date.now().toString(36)}${r}`.slice(0, 64);
}

/** Exponential backoff with jitter (ms). attempt 0 -> ~base. */
export function backoffMs(attempt: number, base = 500, max = 15_000): number {
  const exp = Math.min(max, base * 2 ** Math.min(attempt, 10));
  return Math.round(exp * (0.75 + Math.random() * 0.5));
}

/** Promise that resolves after `ms`. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Joins a base URL and a path without doubling slashes. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Appends query params (skips undefined / null). */
export function withQuery(url: string, query: Record<string, string | number | boolean | undefined | null>): string {
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  if (!parts.length) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${parts.join("&")}`;
}

/** The subset of the Web Storage API the cache uses (pass your own for React Native / tests / Electron). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `globalThis.localStorage` when it exists and is writable, else null (SSR, Node, private mode). */
export function defaultStorage(): StorageLike | null {
  try {
    const s = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (!s) return null;
    const probe = "__liveforge_probe__";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Same rules as protocol `Id`. */
export const ID_RE = /^[A-Za-z0-9_\-.:]{1,64}$/;
/** Same rules as protocol `SignalType`. */
export const SIGNAL_TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

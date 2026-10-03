// Tiny structured logger (stdout JSON-ish lines). Modules get a child logger tagged with their id.
export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(tag: string): Logger;
}

export function createLogger(level: LogLevel = "info", tag = "liveforge"): Logger {
  const min = ORDER[level] ?? 20;
  const out = (lvl: LogLevel, msg: string, data?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${tag}] ${msg}${data ? " " + safeJson(data) : ""}`;
    (lvl === "error" || lvl === "warn" ? console.error : console.log)(line);
  };
  return {
    debug: (m, d) => out("debug", m, d),
    info: (m, d) => out("info", m, d),
    warn: (m, d) => out("warn", m, d),
    error: (m, d) => out("error", m, d),
    child: (t) => createLogger(level, `${tag}:${t}`),
  };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (x instanceof Error ? { name: x.name, message: x.message } : x));
  } catch {
    return "[unserialisable]";
  }
}

// Per-module ask / LLM metrics (ask_log table) for the dashboard's cost / latency / cache meters.
import type { ModuleStats } from "@liveforge/protocol";
import type { Db } from "../store/db.js";

export interface AskLogRow {
  id: string;
  game: string;
  world: string | null;
  player: string | null;
  kind: string;
  module: string;
  /** instant | upgrade | llm (a ScopedLlm call outside asks) */
  stage: string;
  source: string;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
  usd?: number;
  error?: string | null;
}

export class Metrics {
  private readonly ins;
  readonly startedAt = Date.now();

  constructor(private readonly db: Db) {
    this.ins = db.prepare(
      "INSERT INTO ask_log (id, game, world, player, kind, module, stage, source, ms, input_tokens, output_tokens, usd, error, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
  }

  log(r: AskLogRow): void {
    this.ins.run(r.id, r.game, r.world, r.player, r.kind, r.module, r.stage, r.source, Math.round(r.ms), r.inputTokens ?? 0, r.outputTokens ?? 0, r.usd ?? 0, r.error ?? null, Date.now());
  }

  /** Per-module stats since `since` (default: last 24 h). */
  stats(game: string, since = Date.now() - 86_400_000): Record<string, ModuleStats> {
    const rows = this.db.prepare("SELECT module, stage, source, ms, input_tokens, output_tokens, usd, error FROM ask_log WHERE game = ? AND ts >= ?").all(game, since) as {
      module: string; stage: string; source: string; ms: number; input_tokens: number; output_tokens: number; usd: number; error: string | null;
    }[];
    const by = new Map<string, typeof rows>();
    for (const r of rows) (by.get(r.module) ?? by.set(r.module, []).get(r.module)!).push(r);
    const pct = (xs: number[], p: number) => {
      if (!xs.length) return 0;
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
    };
    const out: Record<string, ModuleStats> = {};
    for (const [m, rs] of by) {
      const inst = rs.filter((r) => r.stage === "instant");
      const up = rs.filter((r) => r.stage === "upgrade");
      out[m] = {
        asks: inst.length,
        upgrades: up.filter((r) => !r.error).length,
        cacheHits: inst.filter((r) => r.source === "cache").length,
        errors: rs.filter((r) => r.error).length,
        instantMs: { p50: pct(inst.map((r) => r.ms), 50), p95: pct(inst.map((r) => r.ms), 95) },
        upgradeMs: { p50: pct(up.map((r) => r.ms), 50), p95: pct(up.map((r) => r.ms), 95) },
        inputTokens: rs.reduce((s, r) => s + r.input_tokens, 0),
        outputTokens: rs.reduce((s, r) => s + r.output_tokens, 0),
        usd: Math.round(rs.reduce((s, r) => s + r.usd, 0) * 1e6) / 1e6,
      };
    }
    return out;
  }
}

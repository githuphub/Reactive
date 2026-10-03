// Budgets: per-game and per-player tokens/min (sliding window, in memory) and $/day (persisted in `usage`).
// Limits come from manifest `budgets`. Checked before every LLM call by ScopedLlm; charged after.
import type { Manifest } from "@liveforge/manifest";
import type { Db } from "../store/db.js";

const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export class BudgetTracker {
  /** "game|scope" -> [ts, tokens][] for the last minute. */
  private readonly windows = new Map<string, [number, number][]>();
  private readonly addUsage;
  private readonly getUsage;

  constructor(private readonly db: Db) {
    this.addUsage = db.prepare(
      "INSERT INTO usage (game, scope, day, usd, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(game, scope, day) DO UPDATE SET usd = usd + excluded.usd, input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens",
    );
    this.getUsage = db.prepare("SELECT usd FROM usage WHERE game = ? AND scope = ? AND day = ?");
  }

  private tokensLastMin(game: string, scope: string): number {
    const k = `${game}|${scope}`;
    const w = this.windows.get(k);
    if (!w) return 0;
    const cutoff = Date.now() - 60_000;
    while (w.length && w[0][0] < cutoff) w.shift();
    return w.reduce((s, [, t]) => s + t, 0);
  }

  usdToday(game: string, scope: string): number {
    return (this.getUsage.get(game, scope, day()) as { usd: number } | undefined)?.usd ?? 0;
  }

  check(game: string, manifest: Manifest, player?: string | null): { ok: true } | { ok: false; reason: string } {
    const b = manifest.budgets;
    if (this.tokensLastMin(game, "game") >= b.game.tokensPerMin) return { ok: false, reason: `game over ${b.game.tokensPerMin} tokens/min` };
    if (this.usdToday(game, "game") >= b.game.usdPerDay) return { ok: false, reason: `game over $${b.game.usdPerDay}/day` };
    if (player) {
      const s = `player:${player}`;
      if (this.tokensLastMin(game, s) >= b.player.tokensPerMin) return { ok: false, reason: `player over ${b.player.tokensPerMin} tokens/min` };
      if (this.usdToday(game, s) >= b.player.usdPerDay) return { ok: false, reason: `player over $${b.player.usdPerDay}/day` };
    }
    return { ok: true };
  }

  charge(game: string, player: string | null | undefined, usage: { inputTokens: number; outputTokens: number; usd: number }): void {
    const tokens = usage.inputTokens + usage.outputTokens;
    const now = Date.now();
    const scopes = ["game", ...(player ? [`player:${player}`] : [])];
    for (const s of scopes) {
      const k = `${game}|${s}`;
      const w = this.windows.get(k) ?? [];
      w.push([now, tokens]);
      this.windows.set(k, w);
      this.addUsage.run(game, s, day(now), usage.usd, usage.inputTokens, usage.outputTokens);
    }
  }

  snapshot(game: string, manifest: Manifest) {
    return {
      tokensLastMin: this.tokensLastMin(game, "game"),
      tokensPerMin: manifest.budgets.game.tokensPerMin,
      usdToday: this.usdToday(game, "game"),
      usdPerDay: manifest.budgets.game.usdPerDay,
    };
  }
}

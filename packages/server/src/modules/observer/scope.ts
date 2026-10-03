// Re-scope a world-level context (ticks) to one player: emit / record default to that player.
import type { ScopedContext } from "../../module.js";

export function forPlayer<C extends ScopedContext>(ctx: C, player: string): C {
  return {
    ...ctx,
    player,
    record: (type: string, data: Record<string, unknown>, scope?: { world?: string; player?: string | null }) =>
      ctx.record(type, data, { world: scope?.world ?? ctx.world, player: scope && "player" in scope ? scope.player : player }),
    emit: (draft: Parameters<ScopedContext["emit"]>[0], scope?: { world?: string; player?: string | null }) =>
      ctx.emit(draft, { world: scope?.world ?? ctx.world, player: scope && "player" in scope ? scope.player : player }),
  };
}

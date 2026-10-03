// TODO(merge): K6 adds `BrainEntry` to @liveforge/protocol and `ctx.brain(entry)` to the module context (pushed to
// the world as WS {t:"brain", entry}). Until that lands this shim calls ctx.brain when it exists and no-ops
// otherwise. The dashboard also derives Brain entries from the lf.factions.* events, so nothing is lost meanwhile.
import { randomUUID } from "node:crypto";

/** Local mirror of the spec §4 BrainEntry (K6 owns the real one). */
export interface BrainEntryDraft {
  source: "agents" | "builder" | "factions" | "director" | "reactions" | "forge" | "persona";
  actor: string;
  kind: "goal" | "thought" | "tool_call" | "tool_result" | "plan" | "decision" | "line";
  text: string;
  data?: Record<string, unknown>;
  model?: "sonnet" | "haiku" | "rules" | "cache" | "replay";
  ms?: number;
}

/** Push a Brain entry through ctx.brain when the core has it (K6); silently skipped otherwise. */
export function brain(ctx: object, entry: BrainEntryDraft): void {
  const fn = (ctx as { brain?: (e: unknown) => unknown }).brain;
  if (typeof fn !== "function") return;
  try {
    fn.call(ctx, { id: randomUUID(), ts: Date.now(), ...entry, text: entry.text.slice(0, 500) });
  } catch {
    /* the Brain feed is best-effort */
  }
}

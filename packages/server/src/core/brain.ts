// Brain feed core (K6): per-world ring buffers behind GET /v1/brain, entry hygiene, and the small hooks that turn
// existing module events (Director decisions, reaction rules, Reaction Library lines) into Brain entries without
// touching those modules. Modules push their own entries with ctx.brain(entry).
import { BRAIN_KINDS, BRAIN_MODELS, brainModel, type BrainDraft, type BrainEntry, type BrainPage, type StoredEvent } from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";

const clip = (v: unknown, n: number): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v)).replace(/\s+/g, " ").trim().slice(0, n);

/** Ring buffer of Brain entries per (game, world). Ids are increasing across restarts ("brn_<n>"). */
export class BrainBuffer {
  private seq = Date.now() * 10;
  private readonly worlds = new Map<string, { n: number; entry: BrainEntry }[]>();
  constructor(private readonly size = 300) {}

  /** Cleans a draft into an entry and stores it. Returns null for drafts without text and data. */
  push(game: string, world: string, d: BrainDraft): BrainEntry | null {
    const text = clip(d.text, 1000);
    if (!text && d.data === undefined) return null;
    const n = ++this.seq;
    const entry: BrainEntry = {
      id: `brn_${n}`,
      ts: typeof d.ts === "number" && Number.isFinite(d.ts) ? Math.round(d.ts) : Date.now(),
      source: clip(d.source, 32) || "game",
      actor: clip(d.actor, 64),
      kind: (BRAIN_KINDS as readonly string[]).includes(d.kind) ? d.kind : "thought",
      text,
      world,
      ...(d.data !== undefined ? { data: d.data } : {}),
      ...(d.model && (BRAIN_MODELS as readonly string[]).includes(d.model) ? { model: d.model } : {}),
      ...(typeof d.ms === "number" && Number.isFinite(d.ms) ? { ms: Math.round(d.ms) } : {}),
      ...(d.ref ? { ref: clip(d.ref, 64) } : {}),
    };
    const key = `${game}|${world}`;
    let list = this.worlds.get(key);
    if (!list) this.worlds.set(key, (list = []));
    list.push({ n, entry });
    if (list.length > this.size) list.splice(0, list.length - this.size);
    return entry;
  }

  /** Entries after `after` (an entry id), oldest first, at most `limit` (the newest ones). */
  page(game: string, world: string, after: string | null, limit = 300): BrainPage {
    const list = this.worlds.get(`${game}|${world}`) ?? [];
    const from = after ? Number(after.replace(/^brn_/, "")) : NaN;
    const hits = Number.isFinite(from) ? list.filter((x) => x.n > from) : list;
    const entries = hits.slice(-limit).map((x) => x.entry);
    return { entries, last: entries.length ? entries[entries.length - 1].id : after };
  }
}

/** Badge for an AI decision made at a task's tier (manifest models.overrides, default fast). */
function tierBadge(m: Manifest, task: string, fallbackTier: "fast" | "rich" = "fast"): BrainEntry["model"] {
  const tier = m.models.overrides[task] ?? fallbackTier;
  return brainModel(tier === "rich" ? m.models.rich : m.models.fast);
}

/**
 * Existing module events -> Brain entries (small additive hooks; no module code changes):
 * - lf.director.decision        -> director "decision" (summary + why)
 * - lf.world.reaction           -> reactions "decision" (a manifest reaction rule fired)
 * - lf.directive with a Reaction Library `reaction` (npc.bark lines, custom.reaction effects) -> reactions "line"
 */
export function brainFromEvent(ev: StoredEvent, m: Manifest): BrainDraft | null {
  const d = ev.data as Record<string, unknown>;
  switch (ev.type) {
    case "lf.director.decision": {
      const dec = (d.decision ?? {}) as { kind?: string; summary?: string; why?: string; source?: string; data?: unknown };
      if (dec.kind === "faction_posture" || dec.kind === "raid_plan") return null; // K7 factions pushes its own Brain entries
      const model = dec.source === "ai" ? tierBadge(m, `director.${dec.kind ?? "pacing"}`) : brainModel(null, dec.source ?? "rules");
      return { source: "director", actor: "director", kind: "decision", text: `${clip(dec.summary, 200)}${dec.why ? ` (${clip(dec.why, 300)})` : ""}`, data: { kind: dec.kind, ...(dec.data !== undefined ? { data: dec.data } : {}) }, model, ts: ev.ts };
    }
    case "lf.world.reaction":
      return { source: "reactions", actor: clip(d.rule, 64), kind: "decision", text: `rule "${clip(d.rule, 48)}" fired: ${clip(d.kind, 40)} -> ${clip(d.target, 60)}${d.why ? ` (${clip(d.why, 200)})` : ""}`, model: "rules", ts: ev.ts };
    case "lf.directive": {
      const args = (d.args ?? {}) as Record<string, unknown>;
      const reaction = (args.reaction ?? (d.kind === "custom.reaction" ? args : null)) as { recipe?: string; facets?: string[]; sentence?: string } | null;
      if (!reaction?.recipe) return null;
      const npc = clip(args.npc ?? String(d.target ?? "").replace(/^npc:/, ""), 64);
      const line = clip(args.text ?? args.line ?? (args.payload as { effect?: string } | undefined)?.effect, 300);
      return { source: "reactions", actor: npc || clip(reaction.recipe, 64), kind: "line", text: `${reaction.recipe}: ${line || clip(d.why, 200)}`, data: { recipe: reaction.recipe, facets: reaction.facets ?? [], directive: d.kind }, model: "rules", ts: ev.ts };
    }
    default:
      return null;
  }
}

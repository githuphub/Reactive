// Projection "observer.player_model" (player scope). Folds player signals into decayed counters -> built-in trait
// scores with evidence, cheap stats, and folds the Observer's own recorded facts (lf.observer.moment / .profile /
// .trait) so moments, the LLM profile and designer traits survive a rebuild from the log.
import { Moment, type PlayerModel, type TraitScore } from "@liveforge/protocol";
import { moduleOptions, type Manifest } from "@liveforge/manifest";
import type { Projection } from "../../module.js";
import { BUILTIN_TRAITS, bump, emptyAcc, observerOptions, scoreBuiltins, updateForEvent, type ObserverAcc } from "./traits.js";

export const PLAYER_MODEL = "observer.player_model";

/** Internal events this module records. */
export const OBS_EVENTS = {
  moment: "lf.observer.moment",
  profile: "lf.observer.profile",
  trait: "lf.observer.trait",
} as const;

export type ModelState = Omit<PlayerModel, "acc"> & { acc: ObserverAcc };

const MAX_EVIDENCE = 5;
const MAX_MOMENTS = 50;

/** Personas set per manifest (cached; manifests are replaced, never mutated). */
const personaSets = new WeakMap<Manifest, ReadonlySet<string>>();
const personasOf = (m: Manifest) => {
  let s = personaSets.get(m);
  if (!s) personaSets.set(m, (s = new Set(m.personas.map((p) => p.id))));
  return s;
};

function pushEvidence(ts: TraitScore, line: string): void {
  if (ts.evidence[0] === line) return;
  ts.evidence.unshift(line);
  if (ts.evidence.length > MAX_EVIDENCE) ts.evidence.length = MAX_EVIDENCE;
}

export const playerModelProjection: Projection<ModelState> = {
  name: PLAYER_MODEL,
  scope: "player",
  version: 1,
  types: ["*"],
  init(key) {
    return { player: key.player ?? "", traits: {}, moments: [], profile: null, stats: {}, eventCount: 0, acc: emptyAcc() };
  },
  apply(state, ev, env) {
    if (!state.acc) state.acc = emptyAcc();
    const t = Math.max(state.acc.t, ev.ts);

    // ---- the Observer's own facts
    if (ev.type.startsWith("lf.")) {
      if (ev.type === OBS_EVENTS.moment) {
        const parsed = Moment.safeParse((ev.data as { moment?: unknown }).moment);
        if (!parsed.success) return;
        if (state.moments.some((m) => m.id === parsed.data.id)) return;
        state.moments.unshift(parsed.data);
        if (state.moments.length > MAX_MOMENTS) state.moments.length = MAX_MOMENTS;
        state.stats.moments = Number(state.stats.moments ?? 0) + 1;
        bump(state.acc, "moment", t, parsed.data.salience);
        return;
      }
      if (ev.type === OBS_EVENTS.profile) {
        const d = ev.data as { text?: unknown; eventCount?: unknown };
        if (typeof d.text !== "string" || !d.text.trim()) return;
        state.profile = { text: d.text.slice(0, 800), updatedAt: ev.ts, eventCount: typeof d.eventCount === "number" ? Math.trunc(d.eventCount) : state.eventCount };
        return;
      }
      if (ev.type === OBS_EVENTS.trait) {
        const d = ev.data as { trait?: unknown; score?: unknown; evidence?: unknown };
        if (typeof d.trait !== "string" || typeof d.score !== "number") return;
        const prev = state.traits[d.trait];
        const ts: TraitScore = { score: Math.min(1, Math.max(0, d.score)), evidence: prev?.evidence ?? [], updatedAt: ev.ts, designer: true };
        if (Array.isArray(d.evidence)) for (const line of [...d.evidence].reverse()) if (typeof line === "string") pushEvidence(ts, line.slice(0, 160));
        state.traits[d.trait] = ts;
        return;
      }
      return;
    }

    // ---- a player signal
    const options = observerOptions(moduleOptions(env.manifest, "observer"));
    state.eventCount += 1;
    state.lastSeen = ev.ts;
    const line = updateForEvent(state.acc, state.stats, ev, { options, personas: personasOf(env.manifest) });
    const scores = scoreBuiltins(state.acc, state.stats, options, t);
    for (const [name, score] of Object.entries(scores)) {
      const prev = state.traits[name];
      if (!prev) {
        if (score <= 0) continue;
        const ts: TraitScore = { score, evidence: [], updatedAt: ev.ts };
        if (line && score >= 0.05) pushEvidence(ts, line);
        state.traits[name] = ts;
        continue;
      }
      if (Math.abs(prev.score - score) < 0.001) continue;
      // Only the traits this event pushed up get its evidence line.
      if (line && score - prev.score >= 0.02 && score >= 0.1) pushEvidence(prev, line);
      prev.score = score;
      prev.updatedAt = ev.ts;
      if (BUILTIN_TRAITS[name]?.kind === "state" && score === 0) prev.evidence = [];
    }
  },
};

/** Read a player's model state (always returns a valid object). */
export function readModel(get: (name: string, scope: { world: string; player?: string | null }) => unknown, world: string, player: string): ModelState {
  try {
    const s = get(PLAYER_MODEL, { world, player }) as ModelState | undefined;
    if (s && typeof s === "object") return s;
  } catch {
    /* projection unavailable (module disabled) */
  }
  return playerModelProjection.init({ game: "", world, player }, undefined as unknown as Manifest) as ModelState;
}


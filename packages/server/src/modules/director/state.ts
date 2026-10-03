// Projection "director.state" (world scope, DirectorState): aggression + difficulty mode, the tension curve, each
// boss's invented-move rotation and the decision timeline (every entry carries a `why`). Folded from
// lf.director.decision / lf.director.boss / lf.director.tension / lf.director.difficulty. Deterministic.
import { DirectorDecision as DecisionSchema, MoveSpec, type DirectorDecision, type DirectorState } from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";
import type { Projection, ScopedContext } from "../../module.js";

export const TIMELINE_MAX = 200;
export const TENSION_MAX = 200;

/** Initial aggression: the middle of the designer's bounds. */
export const defaultAggression = (m: Manifest) => {
  const d = m.clamps.difficulty;
  return Math.round(((d.aggressionMin + d.aggressionMax) / 2) * 100) / 100;
};

export const directorStateProjection: Projection<DirectorState> = {
  name: "director.state",
  scope: "world",
  version: 1,
  types: ["lf.director.*"],
  init: (_key, manifest) => ({
    aggression: defaultAggression(manifest),
    difficultyMode: manifest.clamps.difficulty.mode,
    tension: [],
    bosses: {},
    timeline: [],
  }),
  apply(state, ev) {
    const d = ev.data;
    switch (ev.type) {
      case "lf.director.decision": {
        const r = DecisionSchema.safeParse(d.decision);
        if (r.success) {
          state.timeline.push(r.data);
          if (state.timeline.length > TIMELINE_MAX) state.timeline.splice(0, state.timeline.length - TIMELINE_MAX);
        }
        break;
      }
      case "lf.director.boss": {
        if (typeof d.boss !== "string") break;
        const invented = (Array.isArray(d.invented) ? d.invented : []).map((m) => MoveSpec.safeParse(m)).filter((r) => r.success).map((r) => r.data!);
        state.bosses[d.boss] = {
          phase: typeof d.phase === "number" ? Math.round(d.phase) : (state.bosses[d.boss]?.phase ?? 1),
          invented,
          attune: typeof d.attune === "string" ? d.attune : null,
        };
        break;
      }
      case "lf.director.tension": {
        if (typeof d.value !== "number" || !Number.isFinite(d.value)) break;
        state.tension.push({ ts: ev.ts, value: Math.min(1, Math.max(0, d.value)) });
        if (state.tension.length > TENSION_MAX) state.tension.splice(0, state.tension.length - TENSION_MAX);
        break;
      }
      case "lf.director.difficulty": {
        if (typeof d.aggression === "number" && Number.isFinite(d.aggression)) state.aggression = Math.min(1, Math.max(0, d.aggression));
        if (d.mode === "hidden" || d.mode === "assist" || d.mode === "off") state.difficultyMode = d.mode;
        break;
      }
    }
    return state;
  },
};

/** Current Director state of the context's world. */
export function directorState(ctx: ScopedContext): DirectorState {
  return ctx.projections.get("director.state", { world: ctx.world });
}

/** Record a decision on the timeline (the dashboard shows `why`). */
export function recordDecision(ctx: ScopedContext, d: Omit<DirectorDecision, "ts">): void {
  const decision: DirectorDecision = { ...d, ts: ctx.now(), summary: d.summary.slice(0, 200), why: d.why.slice(0, 300) };
  ctx.record("lf.director.decision", { decision });
}

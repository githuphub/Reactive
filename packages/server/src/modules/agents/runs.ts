// Projection "agents.runs" (world scope): the last 20 runs with their steps (folded from lf.agents.run / step).
import type { AgentRun, AgentRuns, AgentStep } from "@liveforge/protocol";
import type { Projection } from "../../module.js";

const MAX_RUNS = 20;
const MAX_STEPS = 60;

export const runsProjection: Projection<AgentRuns> = {
  name: "agents.runs",
  scope: "world",
  version: 1,
  types: ["lf.agents.run", "lf.agents.step"],
  init: () => ({ runs: [] }),
  apply(state, ev) {
    const d = ev.data as Record<string, unknown>;
    const runId = String(d.runId ?? "");
    if (!runId) return;
    let run = state.runs.find((r) => r.runId === runId);
    if (ev.type === "lf.agents.run") {
      const st = (["running", "done", "failed", "interrupted"] as const).find((s) => s === d.state) ?? "running";
      if (!run) {
        run = {
          runId,
          npc: String(d.npc ?? ""),
          goal: String(d.goal ?? ""),
          state: st,
          source: d.source === "ai" ? "ai" : "rules",
          player: typeof d.player === "string" ? d.player : ev.player,
          startedAt: ev.ts,
          plan: Array.isArray(d.plan) ? d.plan.map(String).slice(0, 20) : [],
          steps: [],
        } satisfies AgentRun;
        state.runs.push(run);
        if (state.runs.length > MAX_RUNS) state.runs.splice(0, state.runs.length - MAX_RUNS);
      } else {
        run.state = st;
        if (d.source === "ai" || d.source === "rules") run.source = d.source;
      }
      if (typeof d.summary === "string") run.summary = d.summary;
      if (st !== "running") run.endedAt = ev.ts;
      return;
    }
    if (!run) return;
    const step: AgentStep = { i: Number(d.i ?? run.steps.length), kind: (d.kind as AgentStep["kind"]) ?? "thought", ts: ev.ts };
    for (const k of ["tool", "callId", "text", "model"] as const) if (typeof d[k] === "string") step[k] = d[k] as string;
    if (d.input !== undefined) step.input = d.input;
    if (d.output !== undefined) step.output = d.output;
    if (typeof d.ok === "boolean") step.ok = d.ok;
    if (typeof d.ms === "number") step.ms = d.ms;
    run.steps.push(step);
    if (run.steps.length > MAX_STEPS) run.steps.splice(0, run.steps.length - MAX_STEPS);
  },
};

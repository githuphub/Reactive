// Agents: live NPC agent loops (K6 agents module). Each run shows its goal, plan and every step - thought, tool
// call with input, tool result - with the model badge and latency. Reads the agents.runs projection; when that is
// empty (an older server, demo data) it rebuilds runs from Brain entries (source "agents").
import { app, bus, live, throttle } from "../app";
import type { AgentRun, AgentStep } from "../api/brain";
import { clock, h, jsonView, render, timeAgo } from "../ui/dom";
import { card, empty, errorBox, pill, useLive, type PanelDef } from "./panel";
import { compact, modelPill } from "./k7-ui";

const STATE_COLORS: Record<string, string> = { running: "#3987e5", active: "#3987e5", done: "#3fa34d", ok: "#3fa34d", failed: "#e66767", error: "#e66767", interrupted: "#c98500", stopped: "#8a93a6" };
const KIND_COLORS: Record<string, string> = { thought: "#9085e9", tool_call: "#ff7a2f", tool_result: "#199e70", goal: "#c98500", plan: "#c98500" };

/** Runs rebuilt from Brain entries when the projection is not available (pre-K6 server, demo). */
function runsFromBrain(): AgentRun[] {
  const runs = new Map<string, AgentRun>();
  for (const b of live.brain) {
    if (b.source !== "agents") continue;
    const d = (b.data ?? {}) as Record<string, unknown>;
    const id = String(d.runId ?? `${b.actor}`);
    let r = runs.get(id);
    if (!r) runs.set(id, (r = { runId: id, npc: String(d.npc ?? b.actor), goal: "", state: "running", startedAt: b.ts, steps: [] }));
    r.updatedAt = b.ts;
    if (b.kind === "goal") {
      r.goal = String(d.goal ?? b.text);
      if (typeof d.state === "string") r.state = d.state;
      continue;
    }
    r.steps.push({ i: r.steps.length, kind: b.kind, tool: d.tool as string | undefined, input: d.input, output: d.output, text: b.kind === "thought" ? b.text : (d.text as string | undefined), model: b.model, ms: b.ms, ts: b.ts });
  }
  return [...runs.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function stepRow(s: AgentStep, i: number): HTMLElement {
  const kind = s.kind ?? (s.tool ? "tool_call" : "thought");
  const color = KIND_COLORS[kind] ?? "#8a93a6";
  return h("li", { class: "agent-step" },
    h("div", { class: "agent-step-dot", style: { background: color } }),
    h("div", { class: "agent-step-body" },
      h("div", { class: "dir-top" },
        h("b", null, `#${s.i ?? i}`),
        pill(kind.replace("_", " "), color),
        s.tool ? h("code", { class: "dir-target" }, s.tool) : null,
        s.ok === false ? pill("failed", "#e66767") : null,
        h("span", { class: "dir-time" }, s.ts ? clock(s.ts) : ""),
        modelPill(s.model ?? "rules", s.ms)),
      s.text ? h("div", { class: "agent-thought" }, s.text) : null,
      s.input !== undefined ? h("div", { class: "agent-io" }, h("span", { class: "why-tag" }, "input"), h("code", null, compact(s.input, 400))) : null,
      s.output !== undefined ? h("div", { class: "agent-io" }, h("span", { class: "why-tag" }, "output"), h("code", null, compact(s.output, 400))) : null));
}

export const agentsPanel: PanelDef = {
  id: "agents",
  title: "Agents",
  icon: "npcs",
  subtitle: "NPC agent loops: goal, plan, and every thought, tool call and result, with model and latency.",
  mount(root) {
    const listEl = h("div", { class: "side-list" });
    const detail = h("div", { class: "detail" });
    render(root, h("div", { class: "split" }, card("Runs", { class: "side" }, listEl), detail));
    let selected: string | null = null;
    let runs: AgentRun[] = [];

    const draw = () => {
      if (!runs.length) {
        render(listEl, empty("No agent runs yet", "They appear when the game calls lf.agents.goal(npc, goal)."));
        render(detail, card("Agent loop", null, empty("Waiting for an agent", "Try the Livecraft demo: \"Build me a house\" at Bram's plot.")));
        return;
      }
      if (!selected || !runs.some((r) => r.runId === selected)) selected = runs[0].runId;
      render(listEl, ...runs.map((r) => h("button", { class: `side-item ${r.runId === selected ? "on" : ""}`, onclick: () => { selected = r.runId; draw(); } },
        h("div", { class: "side-title" }, r.npc),
        h("div", { class: "side-sub" }, r.goal || "(goal)"),
        h("div", { class: "side-tag" }, `${r.state ?? "running"} · ${r.steps.length} steps · ${timeAgo(r.updatedAt ?? r.startedAt)}`))));
      const r = runs.find((x) => x.runId === selected)!;
      const tools = r.steps.filter((s) => s.tool).length;
      const ms = r.steps.reduce((n, s) => n + (s.ms ?? 0), 0);
      render(detail,
        card(r.goal || "Agent run", { hint: `${r.npc} · run ${r.runId}`, actions: [pill(r.state ?? "running", STATE_COLORS[r.state ?? "running"] ?? "#8a93a6", { solid: true })] },
          h("div", { class: "stat-chips" },
            h("span", { class: "stat-chip" }, `${r.steps.length} steps`),
            h("span", { class: "stat-chip" }, `${tools} tool calls`),
            h("span", { class: "stat-chip" }, `${(ms / 1000).toFixed(1)}s model time`),
            r.startedAt ? h("span", { class: "stat-chip" }, `started ${clock(r.startedAt)}`) : null),
          r.plan?.length ? h("ol", { class: "agent-plan" }, ...r.plan.map((p) => h("li", null, p))) : null,
          r.summary ? h("div", { class: "dir-why" }, h("span", { class: "why-tag" }, "summary"), r.summary) : null),
        card("Steps", { hint: "oldest first" }, r.steps.length ? h("ol", { class: "agent-steps" }, ...r.steps.map(stepRow)) : empty("No steps yet")),
        card("Raw", { hint: "projection agents.runs" }, jsonView(r)));
    };

    const stop = useLive(async () => {
      const s = app();
      try {
        const fromServer = s.source.agentRuns ? await s.source.agentRuns(s.world) : [];
        runs = fromServer.length ? fromServer : runsFromBrain();
      } catch (e) {
        runs = runsFromBrain();
        if (!runs.length) {
          render(detail, errorBox(e));
          return;
        }
      }
      draw();
    }, { interval: 3000, throttleMs: 700 });
    const offBrain = bus.on("brain", throttle(() => stop.refresh(), 600));
    return () => {
      stop();
      offBrain();
    };
  },
};

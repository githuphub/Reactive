// Module "agents" - OWNER: K6. Only edit files inside packages/server/src/modules/agents/.
// Server-run, tool-calling NPC agents (Livecraft spec §1.1).
//
// Flow: the game registers tools (POST /v1/m/agents/register or manifest agents.tools), asks `agent.goal {npc, goal}`
// -> instant {runId, accepted, plan} (final, no upgrade) and the run starts in the background:
//  - AI (LLM with native tool use, rich tier): system = persona + lore + safety; user = goal stack + world context.
//    Each tool_use -> directive agent.tool_call {agent, runId, callId, tool, input} (target npc:<id>) -> wait for
//    agent.tool_result (signal or POST /v1/m/agents/result; 30 s timeout, agent.tool_progress extends it) -> fed
//    back as tool_result. Text blocks become "thought" Brain entries. Stops on end_turn, maxSteps (12), interrupt
//    (agent.interrupt signal or route; a new goal for the same NPC) or an exhausted budget.
//  - Rules (no LLM, or an error mid-run): planAgentGoal() keyword templates (build, fetch, follow, guard, trade,
//    go_to, say) call the same tool_call directives one by one, so the game code path is identical.
// Events lf.agents.run / lf.agents.step fold into projection agents.runs (world). Every step goes to the Brain feed.
import { AgentToolSpec, planAgentGoal } from "@liveforge/protocol";
import { personaById } from "@liveforge/manifest";
import { defineModule, type AskHandler, type ModuleContext } from "../../module.js";
import { managerFor } from "./runner.js";
import { pushGoal, toolsFor } from "./registry.js";
import { runsProjection } from "./runs.js";
import { agentRoutes } from "./routes.js";

const contexts = new Map<string, ModuleContext>();

const goal: AskHandler<"agent.goal"> = {
  instant(ctx, p) {
    const m = ctx.manifest;
    if (m.personas.length && !personaById(m, p.npc)) ctx.log.debug("agent.goal for an NPC without a persona", { npc: p.npc });
    const tools = toolsFor(ctx, p.npc);
    const plan = planAgentGoal(p.goal, { tools: tools.length ? tools : undefined });
    const useAi = !!ctx.llm?.supportsTools && tools.length > 0 && ctx.budgets.check(ctx.player).ok;
    pushGoal(ctx, ctx.world, p.npc, p.goal);
    const run = managerFor(ctx.game).start(ctx, p, tools, plan, useAi);
    return {
      result: { runId: run.runId, accepted: true, plan: plan.steps.map((s) => s.label) },
      why: useAi ? `AI agent loop started for ${p.npc} (${tools.length} tools; rules plan shown)` : `rules plan "${plan.template}" started for ${p.npc}${tools.length ? "" : " (no tools registered)"}`,
      source: "rules",
      final: true,
    };
  },
};

export default defineModule({
  id: "agents",
  description: "Server-run, tool-calling NPC agents (native tool use) with a scripted rules fallback.",
  projections: [runsProjection],
  signalHandlers: [
    {
      types: ["agent.tool_result"],
      handle(ctx, ev) {
        const d = ev.data;
        managerFor(ctx.game).resolve(String(d.runId ?? ""), String(d.callId ?? ""), d.ok !== false, d.output);
      },
    },
    {
      types: ["agent.tool_progress"],
      handle(ctx, ev) {
        const d = ev.data;
        managerFor(ctx.game).progress(String(d.runId ?? ""), String(d.callId ?? ""), typeof d.text === "string" ? d.text : undefined);
      },
    },
    {
      types: ["agent.interrupt"],
      handle(ctx, ev) {
        const d = ev.data;
        const reason = typeof d.reason === "string" && d.reason ? d.reason.slice(0, 200) : "interrupted by the game";
        managerFor(ctx.game).interruptWhere({ world: ev.world, npc: typeof d.npc === "string" ? d.npc : undefined, runId: typeof d.runId === "string" ? d.runId : undefined }, reason);
      },
    },
  ],
  asks: { "agent.goal": goal },
  routes: agentRoutes(contexts),
  init(ctx) {
    contexts.set(ctx.game, ctx);
    for (const t of ctx.manifest.agents.tools) {
      if (!AgentToolSpec.safeParse(t).success) ctx.log.warn("manifest agents.tools entry is invalid", { tool: t.name });
    }
  },
});

export { RunManager, managerFor } from "./runner.js";
export { registerTools, toolsFor, setContext, contextFor } from "./registry.js";
export { runsProjection } from "./runs.js";

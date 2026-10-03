// HTTP routes for the agents module. Public (SDK key) at /v1/m/agents/*:
//   POST register  {npc, tools: [{name, description, schema}]}  register the game's tools ("*" = every NPC)
//   POST result    {runId, callId, ok, output?}                  answer an agent.tool_call
//   POST progress  {runId, callId, text?}                        a long tool is still working (extends the timeout)
//   POST interrupt {world, npc? | runId?, reason?}               stop a run
//   POST context   {world, npc | "*", text}                      the game's latest situation text (empty clears)
//   GET  runs?world=                                             the agents.runs projection (last 20 runs)
//   GET  tools?npc=                                              the tools an NPC can use
import { Hono, type Context } from "hono";
import type { AgentRuns } from "@liveforge/protocol";
import type { LfEnv, ModuleContext, ModuleRoutes } from "../../module.js";
import { managerFor } from "./runner.js";
import { registerTools, setContext, toolsFor } from "./registry.js";

type C = Context<LfEnv>;
const err = (c: C, status: 400 | 409, code: string, message: string) => c.json({ error: { code, message } }, status);
const str = (v: unknown, max = 64): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const body = async (c: C): Promise<Record<string, unknown>> => {
  const b = await c.req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
};

export function agentRoutes(contexts: Map<string, ModuleContext>): ModuleRoutes {
  const pub = new Hono<LfEnv>();
  const ctxOf = (c: C) => contexts.get(c.get("game")) ?? null;

  pub.post("/register", async (c) => {
    const ctx = ctxOf(c);
    if (!ctx) return err(c, 409, "module_disabled", "agents module not initialised for this game");
    const b = await body(c);
    const npc = str(b.npc) || "*";
    if (!Array.isArray(b.tools)) return err(c, 400, "bad_request", "body needs {npc, tools: [{name, description, schema}]}");
    return c.json(registerTools(ctx, npc, b.tools));
  });

  pub.post("/result", async (c) => {
    const b = await body(c);
    const runId = str(b.runId);
    const callId = str(b.callId);
    if (!runId || !callId) return err(c, 400, "bad_request", "body needs {runId, callId, ok, output?}");
    return c.json({ accepted: managerFor(c.get("game")).resolve(runId, callId, b.ok !== false, b.output) });
  });

  pub.post("/progress", async (c) => {
    const b = await body(c);
    const runId = str(b.runId);
    const callId = str(b.callId);
    if (!runId || !callId) return err(c, 400, "bad_request", "body needs {runId, callId, text?}");
    return c.json({ accepted: managerFor(c.get("game")).progress(runId, callId, str(b.text, 300) || undefined) });
  });

  pub.post("/interrupt", async (c) => {
    const b = await body(c);
    const runId = str(b.runId);
    const npc = str(b.npc);
    const world = str(b.world);
    if (!runId && !(npc && world)) return err(c, 400, "bad_request", "body needs {runId} or {world, npc}");
    const ids = managerFor(c.get("game")).interruptWhere({ runId: runId || undefined, npc: npc || undefined, world: world || undefined }, str(b.reason, 200) || "interrupted by the game");
    return c.json({ interrupted: ids });
  });

  pub.post("/context", async (c) => {
    const ctx = ctxOf(c);
    if (!ctx) return err(c, 409, "module_disabled", "agents module not initialised for this game");
    const b = await body(c);
    const world = str(b.world);
    const npc = str(b.npc) || "*";
    if (!world || typeof b.text !== "string") return err(c, 400, "bad_request", "body needs {world, npc, text}");
    setContext(ctx, world, npc, b.text);
    return c.json({ ok: true });
  });

  pub.get("/runs", (c) => {
    const ctx = ctxOf(c);
    if (!ctx) return err(c, 409, "module_disabled", "agents module not initialised for this game");
    const world = c.req.query("world");
    if (!world) return err(c, 400, "bad_request", "?world= is required");
    return c.json(ctx.projections.get<AgentRuns>("agents.runs", { world }));
  });

  pub.get("/tools", (c) => {
    const ctx = ctxOf(c);
    if (!ctx) return err(c, 409, "module_disabled", "agents module not initialised for this game");
    const npc = c.req.query("npc") ?? "*";
    return c.json({ npc, tools: toolsFor(ctx, npc) });
  });

  return { public: pub };
}

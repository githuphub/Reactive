// The agent loop. One active run per (world, npc); a new goal interrupts the old run. Each tool call is pushed to
// the game as an `agent.tool_call` directive (target npc:<id>) and the run waits for `agent.tool_result` (signal or
// route) with a timeout that `agent.tool_progress` extends. AI runs use ctx.llm.tools (native tool use, rich tier);
// without an LLM, or on an error mid-run, the scripted rules plan drives the very same directives.
import { randomUUID } from "node:crypto";
import { brainModel, planAgentGoal, type AgentPlan, type AgentRunState, type AgentToolSpec, type BrainModel } from "@liveforge/protocol";
import type { ScopedContext } from "../../module.js";
import { BudgetExceededError } from "../../errors.js";
import type { LlmContentBlock, LlmMessage } from "../../providers/index.js";
import { agentSystem, agentUser } from "./prompt.js";
import { agentLimits, contextFor, goalStack, popGoal, toLlmTools } from "./registry.js";

export interface ToolOutcome {
  ok: boolean;
  output: unknown;
  timedOut?: boolean;
  interrupted?: boolean;
}

interface PendingCall {
  tool: string;
  timeoutMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  lastProgressBrain: number;
  arm(): void;
  settle(o: ToolOutcome): void;
}

export interface ActiveRun {
  runId: string;
  npc: string;
  world: string;
  player: string | null;
  goal: string;
  goalContext?: string;
  maxSteps: number;
  ctx: ScopedContext;
  abort: AbortController;
  stopReason: string | null;
  pending: Map<string, PendingCall>;
  step: number;
  tools: AgentToolSpec[];
  plan: AgentPlan;
}

const shortId = (p: string) => `${p}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const short = (v: unknown, n: number): string => {
  const s = typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
/** Keeps event payloads small: large values become a truncated JSON string. */
const capValue = (v: unknown, n = 2000): unknown => {
  if (v === undefined || v === null || typeof v === "number" || typeof v === "boolean") return v;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n - 1)}…` : v;
};

/** Per-game run bookkeeping (in memory; runs do not survive a restart). */
export class RunManager {
  readonly runs = new Map<string, ActiveRun>();
  private readonly byNpc = new Map<string, string>();

  activeFor(world: string, npc: string): ActiveRun | undefined {
    const id = this.byNpc.get(`${world}|${npc}`);
    return id ? this.runs.get(id) : undefined;
  }

  /** Starts a run in the background. The caller already recorded nothing; this records the run start. */
  start(ctx: ScopedContext, p: { npc: string; goal: string; context?: string; maxSteps?: number }, tools: AgentToolSpec[], plan: AgentPlan, useAi: boolean): ActiveRun {
    const prev = this.activeFor(ctx.world, p.npc);
    if (prev) this.interrupt(prev, "a new goal arrived");
    const lim = agentLimits(ctx.manifest, ctx.options);
    const run: ActiveRun = {
      runId: shortId("run"),
      npc: p.npc,
      world: ctx.world,
      player: ctx.player,
      goal: p.goal,
      ...(p.context ? { goalContext: p.context } : {}),
      maxSteps: Math.max(1, Math.min(40, p.maxSteps ?? lim.maxSteps)),
      ctx,
      abort: new AbortController(),
      stopReason: null,
      pending: new Map(),
      step: 0,
      tools,
      plan,
    };
    this.runs.set(run.runId, run);
    this.byNpc.set(`${run.world}|${run.npc}`, run.runId);
    ctx.record("lf.agents.run", { runId: run.runId, npc: run.npc, goal: run.goal, state: "running", source: useAi ? "ai" : "rules", player: run.player, plan: plan.steps.map((s) => s.label) });
    ctx.brain({ source: "agents", actor: run.npc, kind: "goal", text: run.goal, ref: run.runId, data: { runId: run.runId, plan: plan.steps.map((s) => s.label), mode: useAi ? "ai" : "rules" } });
    void (useAi ? this.runAi(run) : this.runRules(run, "no AI configured")).catch((e) => {
      ctx.log.error("agent run crashed", { runId: run.runId, error: e as Error });
      this.finish(run, "failed", `crashed: ${(e as Error).message}`.slice(0, 300));
    });
    return run;
  }

  // ------------------------------------------------------------------ results from the game

  /** A tool result arrived (signal or route). Returns false for unknown / finished calls. */
  resolve(runId: string, callId: string, ok: boolean, output: unknown): boolean {
    const pc = this.runs.get(runId)?.pending.get(callId);
    if (!pc) return false;
    pc.settle({ ok, output });
    return true;
  }

  /** A long tool is still working: re-arm its timeout and show it in the Brain feed (at most every 2 s). */
  progress(runId: string, callId: string, text: string | undefined): boolean {
    const run = this.runs.get(runId);
    const pc = run?.pending.get(callId);
    if (!run || !pc) return false;
    pc.arm();
    const now = Date.now();
    if (text && now - pc.lastProgressBrain > 2000) {
      pc.lastProgressBrain = now;
      run.ctx.brain({ source: "agents", actor: run.npc, kind: "tool_result", text: `${pc.tool}: ${short(text, 200)}`, ref: run.runId, data: { callId, progress: true } });
    }
    return true;
  }

  /** Stop a run: pending calls resolve as interrupted, the LLM call is aborted, the loop finishes "interrupted". */
  interrupt(run: ActiveRun, reason: string): void {
    if (run.abort.signal.aborted) return;
    run.stopReason = reason;
    run.abort.abort();
    for (const pc of [...run.pending.values()]) pc.settle({ ok: false, output: `interrupted: ${reason}`, interrupted: true });
  }

  /** Interrupt by runId or by (world, npc). Returns the interrupted run ids. */
  interruptWhere(q: { world?: string; npc?: string; runId?: string }, reason: string): string[] {
    const hits: ActiveRun[] = [];
    if (q.runId) {
      const r = this.runs.get(q.runId);
      if (r) hits.push(r);
    } else if (q.npc && q.world) {
      const r = this.activeFor(q.world, q.npc);
      if (r) hits.push(r);
    }
    for (const r of hits) this.interrupt(r, reason);
    return hits.map((r) => r.runId);
  }

  // ------------------------------------------------------------------ tool calls

  private waitFor(run: ActiveRun, callId: string, tool: string, timeoutMs: number): Promise<ToolOutcome> {
    return new Promise((resolve) => {
      const pc: PendingCall = {
        tool,
        timeoutMs,
        timer: null,
        lastProgressBrain: 0,
        arm: () => {
          if (pc.timer) clearTimeout(pc.timer);
          pc.timer = setTimeout(() => pc.settle({ ok: false, output: `no result after ${Math.round(timeoutMs / 1000)}s (timed out)`, timedOut: true }), timeoutMs);
        },
        settle: (o) => {
          if (!run.pending.has(callId)) return;
          if (pc.timer) clearTimeout(pc.timer);
          run.pending.delete(callId);
          resolve(o);
        },
      };
      run.pending.set(callId, pc);
      pc.arm();
      if (run.abort.signal.aborted) pc.settle({ ok: false, output: "interrupted", interrupted: true });
    });
  }

  private recordStep(run: ActiveRun, d: Record<string, unknown>): void {
    run.ctx.record("lf.agents.step", { runId: run.runId, i: run.step++, ...d });
  }

  /** Push one tool call to the game and wait for its result. */
  private async callTool(run: ActiveRun, tool: string, input: Record<string, unknown>, model: BrainModel, modelId: string): Promise<ToolOutcome> {
    const lim = agentLimits(run.ctx.manifest, run.ctx.options);
    const callId = shortId("call");
    const started = Date.now();
    const waiting = this.waitFor(run, callId, tool, lim.toolTimeoutMs);
    const d = run.ctx.emit({
      kind: "agent.tool_call",
      target: `npc:${run.npc}`,
      args: { agent: run.npc, runId: run.runId, callId, tool, input, timeoutMs: lim.toolTimeoutMs, step: run.step },
      why: `${run.npc}: ${tool} for "${short(run.goal, 120)}"`.slice(0, 200),
    });
    this.recordStep(run, { kind: "tool_call", tool, callId, input: capValue(input), model: modelId });
    run.ctx.brain({ source: "agents", actor: run.npc, kind: "tool_call", text: `${tool}(${short(input, 160)})`, ref: run.runId, model, data: { callId, tool, input } });
    if (!d) run.pending.get(callId)?.settle({ ok: false, output: "the directive was rejected (bad tool input)" });
    const outcome = await waiting;
    const ms = Date.now() - started;
    this.recordStep(run, { kind: "tool_result", tool, callId, ok: outcome.ok, output: capValue(outcome.output), ms, model: "game" });
    run.ctx.brain({ source: "agents", actor: run.npc, kind: "tool_result", text: `${tool} ${outcome.ok ? "ok" : "failed"}: ${short(outcome.output ?? "", 200)}`, ref: run.runId, ms, data: { callId, tool, ok: outcome.ok, output: outcome.output } });
    return outcome;
  }

  // ------------------------------------------------------------------ AI loop

  private async runAi(run: ActiveRun): Promise<void> {
    const ctx = run.ctx;
    const llm = ctx.llm;
    if (!llm || !llm.supportsTools) return this.runRules(run, "no tool-capable LLM");
    const m = ctx.manifest;
    const lim = agentLimits(m, ctx.options);
    const tools = toLlmTools(run.tools);
    const toolNames = new Set(tools.map((t) => t.name));
    const system = agentSystem(m, run.npc, run.maxSteps, toolNames.has("say"));
    let sentContext = contextFor(ctx, run.world, run.npc);
    const messages: LlmMessage[] = [{ role: "user", content: agentUser(run.goal, goalStack(ctx, run.world, run.npc), sentContext, run.goalContext) }];
    let lastText = "";
    let calls = 0;
    for (let step = 0; step < run.maxSteps; step++) {
      if (run.abort.signal.aborted) return this.finish(run, "interrupted", run.stopReason ?? "interrupted");
      const budget = ctx.budgets.check(run.player);
      // past the game/player budget the scripted rules plan drives the same tools (no more LLM spend)
      if (!budget.ok) return this.runRules(run, `budget: ${budget.reason}`);
      let res;
      try {
        res = await llm.tools({ system, messages, tools, tier: "rich", maxTokens: lim.maxTokens, timeoutMs: lim.stepTimeoutMs, task: "agents.step", player: run.player, signal: run.abort.signal });
      } catch (e) {
        if (run.abort.signal.aborted) return this.finish(run, "interrupted", run.stopReason ?? "interrupted");
        if (e instanceof BudgetExceededError) return this.runRules(run, `budget: ${e.message}`.slice(0, 200));
        ctx.log.warn("agent LLM step failed; switching to the rules plan", { runId: run.runId, error: (e as Error).message });
        this.recordStep(run, { kind: "error", text: `AI step failed (${(e as Error).message.slice(0, 160)}); rules plan takes over`, model: "rules" });
        return this.runRules(run, "the AI step failed");
      }
      const model = brainModel(res.model, res.source);
      messages.push({ role: "assistant", content: res.content });
      const texts = res.content.filter((b) => b.type === "text" && typeof b.text === "string" && b.text.trim()).map((b) => (b.text as string).trim());
      for (const t of texts) {
        lastText = t;
        this.recordStep(run, { kind: "thought", text: t.slice(0, 1000), model: res.model, ms: res.ms });
        ctx.brain({ source: "agents", actor: run.npc, kind: "thought", text: t, ref: run.runId, model, ms: res.ms });
      }
      const uses = res.content.filter((b) => b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string");
      if (!uses.length || res.stopReason === "end_turn" || res.stopReason === "max_tokens") {
        if (uses.length && res.stopReason !== "max_tokens") ctx.log.debug("tool_use with end_turn ignored", { runId: run.runId });
        return this.finish(run, "done", lastText || (calls ? "Done." : "Nothing to do."));
      }
      const results: LlmContentBlock[] = [];
      for (const u of uses) {
        const name = u.name as string;
        const input = (u.input && typeof u.input === "object" && !Array.isArray(u.input) ? u.input : {}) as Record<string, unknown>;
        let outcome: ToolOutcome;
        if (!toolNames.has(name)) outcome = { ok: false, output: `unknown tool "${name}"` };
        else if (run.abort.signal.aborted) outcome = { ok: false, output: "interrupted", interrupted: true };
        else {
          calls++;
          outcome = await this.callTool(run, name, input, model, res.model);
        }
        results.push({ type: "tool_result", tool_use_id: u.id as string, content: toolText(outcome), ...(outcome.ok ? {} : { is_error: true }) });
      }
      if (run.abort.signal.aborted) return this.finish(run, "interrupted", run.stopReason ?? "interrupted");
      const now = contextFor(ctx, run.world, run.npc);
      if (now && now !== sentContext) {
        sentContext = now;
        results.push({ type: "text", text: `World update:\n${now}` });
      }
      messages.push({ role: "user", content: results });
    }
    return this.finish(run, "done", lastText ? `${lastText} (step budget reached)` : `Stopped after ${run.maxSteps} steps.`);
  }

  // ------------------------------------------------------------------ rules loop

  private async runRules(run: ActiveRun, why: string): Promise<void> {
    const ctx = run.ctx;
    const plan = run.plan.steps.length ? run.plan : planAgentGoal(run.goal, { tools: run.tools.length ? run.tools : undefined });
    const labels = plan.steps.map((s) => s.label);
    this.recordStep(run, { kind: "plan", text: `${plan.template} plan (${why}): ${labels.join(" -> ")}`, model: "rules" });
    ctx.brain({ source: "agents", actor: run.npc, kind: "plan", text: labels.length ? labels.join(" → ") : "nothing I can do with my tools", ref: run.runId, model: "rules", data: { template: plan.template, why } });
    let ok = true;
    for (const s of plan.steps.slice(0, run.maxSteps)) {
      if (run.abort.signal.aborted) return this.finish(run, "interrupted", run.stopReason ?? "interrupted");
      const o = await this.callTool(run, s.tool, s.input, "rules", "rules");
      if (o.interrupted) return this.finish(run, "interrupted", run.stopReason ?? "interrupted");
      ok &&= o.ok;
    }
    if (!plan.steps.length) return this.finish(run, "failed", "No registered tool fits this goal.");
    return this.finish(run, ok ? "done" : "failed", ok ? `Done: ${short(run.goal, 200)}` : `Tried: ${short(run.goal, 200)} (some steps failed)`);
  }

  // ------------------------------------------------------------------ end

  private finish(run: ActiveRun, state: Exclude<AgentRunState, "running">, summary: string): void {
    if (!this.runs.has(run.runId)) return;
    this.runs.delete(run.runId);
    if (this.byNpc.get(`${run.world}|${run.npc}`) === run.runId) this.byNpc.delete(`${run.world}|${run.npc}`);
    for (const pc of [...run.pending.values()]) pc.settle({ ok: false, output: "run ended", interrupted: true });
    const text = summary.replace(/\s+/g, " ").trim().slice(0, 300) || state;
    const ctx = run.ctx;
    if (state === "done") popGoal(ctx, run.world, run.npc, run.goal);
    ctx.record("lf.agents.run", { runId: run.runId, npc: run.npc, goal: run.goal, state, summary: text });
    this.recordStep(run, { kind: "done", text, ok: state === "done", model: "rules" });
    ctx.emit({ kind: "agent.done", target: `npc:${run.npc}`, args: { runId: run.runId, npc: run.npc, ok: state === "done", summary: text, state }, why: `${run.npc} ${state}: ${short(run.goal, 120)}`.slice(0, 200) });
    ctx.brain({ source: "agents", actor: run.npc, kind: "decision", text: `${state === "done" ? "Done" : state === "interrupted" ? "Interrupted" : "Gave up"}: ${text}`, ref: run.runId, data: { runId: run.runId, state } });
  }
}

/** tool_result content for the model: strings as-is, everything else JSON, capped. */
function toolText(o: ToolOutcome): string {
  const v = o.output;
  const s = v === undefined || v === null ? (o.ok ? "ok" : "failed") : typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 4000 ? `${s.slice(0, 3999)}…` : s || (o.ok ? "ok" : "failed");
}

/** RunManager per game (module state). */
export const managers = new Map<string, RunManager>();
export const managerFor = (game: string): RunManager => {
  let m = managers.get(game);
  if (!m) managers.set(game, (m = new RunManager()));
  return m;
};

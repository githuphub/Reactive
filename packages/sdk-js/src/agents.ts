// `lf.agents`: register NPC tools, give goals, interrupt, feed world context. The server runs the loop and pushes
// `agent.tool_call` directives; this client runs the matching tool and posts the result (route, with a signal as the
// fallback). Offline (or when the server is unreachable) `goal()` runs the same keyless goal templates locally
// through the registered tools, so the game demos without a server.
import {
  planAgentGoal,
  type AskResult,
  type BrainEntry,
  type Directive,
  type DirectiveArgs,
  type TypedDirective,
} from "@liveforge/protocol";
import type { BrainFeed } from "./brain.js";
import { Emitter, type Unsubscribe } from "./emitter.js";
import { LiveforgeError, isLiveforgeError } from "./errors.js";
import type { HttpRequest, HttpResponse } from "./http.js";
import { randomId } from "./util.js";

/** What a tool's `run` receives besides its input. */
export interface AgentToolContext {
  npc: string;
  runId: string;
  callId: string;
  /** Report progress on long tools (build, gather): keeps the server waiting and shows in the Brain feed. */
  progress(text: string): void;
  /** Aborted when the run is interrupted or ends. */
  signal: AbortSignal;
}

/**
 * A tool the NPC can use. `schema` is a JSON Schema (type "object") for `input`; `description` is what the model
 * reads, so say what it does and when to use it. Return any JSON-able value; throw to report a failure.
 */
export interface AgentTool<I = any> {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  run(input: I, ctx: AgentToolContext): unknown | Promise<unknown>;
}

/** `agents.goal()` options. */
export interface AgentGoalOptions {
  /** Situation text for this goal ("the player stands at the plot by the well"). */
  context?: string;
  /** Step budget (default: manifest agents.maxSteps, 12). */
  maxSteps?: number;
}

/** `agents.goal()` result. `local: true` = run by the SDK's offline runner. */
export type AgentGoalResult = AskResult<"agent.goal"> & { local?: boolean };

/** A finished run (server `agent.done` directive or a local run). */
export type AgentDone = DirectiveArgs<"agent.done"> & { local?: boolean };

/** @internal wiring from the client. */
export interface AgentsDeps {
  request<T>(req: HttpRequest): Promise<HttpResponse<T>>;
  identity(): { world: string; player: string; session: string };
  on(kind: string, fn: (d: Directive) => void): Unsubscribe;
  signal(type: string, data: Record<string, unknown>): void;
  brain: BrainFeed;
  offline: boolean;
}

interface LocalRun {
  runId: string;
  abort: AbortController;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^\[liveforge\] /, "").slice(0, 500);
const jsonable = (v: unknown): unknown => {
  if (v === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
};

export class AgentsApi {
  private readonly tools = new Map<string, Map<string, AgentTool>>();
  private readonly handled = new Set<string>();
  private readonly handledOrder: string[] = [];
  private readonly inflight = new Map<string, Set<AbortController>>();
  private readonly localRuns = new Map<string, LocalRun>();
  private readonly events = new Emitter<{ done: (d: AgentDone) => void }>();

  constructor(private readonly deps: AgentsDeps) {
    deps.on("agent.tool_call", (d) => void this.onToolCall(d as unknown as TypedDirective<"agent.tool_call">));
    deps.on("agent.done", (d) => {
      const args = (d as unknown as TypedDirective<"agent.done">).args;
      for (const ac of this.inflight.get(args.runId) ?? []) ac.abort();
      this.inflight.delete(args.runId);
      this.events.emit("done", args);
    });
  }

  /**
   * Registers an NPC's tools ("*" = every NPC) and tells the server about them (validated against the manifest
   * allow-list). Resolves with the server's verdict, or null when offline / unreachable (the tools still run locally).
   *
   * ```ts
   * lf.agents.register("bram", [
   *   { name: "walk_to", description: "Walk to a named place or 'player'.", schema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
   *     run: async ({ target }) => (await bram.walkTo(target)) ? "arrived" : "path blocked" },
   * ]);
   * ```
   */
  async register(npc: string, tools: AgentTool[]): Promise<{ registered: string[]; rejected: { name: string; reason: string }[] } | null> {
    if (typeof npc !== "string" || !npc) throw new LiveforgeError("invalid_input", "agents.register(npc, tools): npc is required");
    const map = this.tools.get(npc) ?? new Map<string, AgentTool>();
    for (const t of tools) {
      if (!t || typeof t.name !== "string" || typeof t.run !== "function") throw new LiveforgeError("invalid_input", `agents.register: every tool needs {name, description, schema, run} (got ${JSON.stringify(t?.name)})`);
      map.set(t.name, t);
    }
    this.tools.set(npc, map);
    if (this.deps.offline) return null;
    try {
      const r = await this.deps.request<{ registered: string[]; rejected: { name: string; reason: string }[] }>({
        method: "POST",
        path: "/v1/m/agents/register",
        json: { npc, tools: [...map.values()].map((t) => ({ name: t.name, description: t.description ?? "", schema: t.schema ?? { type: "object", properties: {} } })) },
      });
      const res = r.data ?? null;
      if (res?.rejected.length) console.warn(`[liveforge] agents.register(${npc}): rejected ${res.rejected.map((x) => `${x.name} (${x.reason})`).join("; ")}`);
      return res;
    } catch (err) {
      if (isLiveforgeError(err) && err.retryable) return null;
      throw err;
    }
  }

  /** Tools registered on this client for an NPC (its own + "*"). */
  toolsFor(npc: string): AgentTool[] {
    return [...new Map([...(this.tools.get("*") ?? new Map()), ...(this.tools.get(npc) ?? new Map())]).values()];
  }

  /**
   * Gives an NPC a goal. The server plans and acts (AI with tools, or its rules plan); every step comes back as a
   * tool call this client runs. Offline / unreachable: a local rules run through the registered tools.
   *
   * ```ts
   * const { runId, plan } = await lf.agents.goal("bram", "build me a cosy house with a tower", { context: "plot at the well" });
   * ```
   */
  async goal(npc: string, goal: string, opts: AgentGoalOptions = {}): Promise<AgentGoalResult> {
    if (!npc || !goal) throw new LiveforgeError("invalid_input", "agents.goal(npc, goal): both are required");
    if (!this.deps.offline) {
      try {
        const id = this.deps.identity();
        const r = await this.deps.request<{ result: AgentGoalResult }>({
          method: "POST",
          path: "/v1/ask/agent.goal",
          json: { world: id.world, player: id.player, session: id.session, upgrade: false, params: { npc, goal, ...(opts.context ? { context: opts.context } : {}), ...(opts.maxSteps ? { maxSteps: opts.maxSteps } : {}) } },
        });
        const res = r.data?.result;
        if (res?.accepted) {
          this.stopLocal(npc, "the server took over");
          return res;
        }
        if (res && !/disabled/.test(res.reason ?? "")) return res;
      } catch (err) {
        if (!isLiveforgeError(err) || !err.retryable) throw err;
      }
    }
    return this.runLocal(npc, goal, opts);
  }

  /** Stops the NPC's current run (server and local). */
  async interrupt(npc: string, reason = "interrupted by the game"): Promise<void> {
    this.stopLocal(npc, reason);
    if (this.deps.offline) return;
    try {
      await this.deps.request({ method: "POST", path: "/v1/m/agents/interrupt", json: { world: this.deps.identity().world, npc, reason } });
    } catch (err) {
      if (!isLiveforgeError(err) || !err.retryable) throw err;
      this.deps.signal("agent.interrupt", { npc, reason });
    }
  }

  /**
   * The game's latest situation text for an NPC, or "*" for everyone in this world ("night; zombies near the gate").
   * The server injects it into the agent's prompt; later changes ride along with tool results. Empty text clears it.
   */
  async setContext(npc: string | "*", text: string): Promise<void> {
    if (this.deps.offline) return;
    try {
      await this.deps.request({ method: "POST", path: "/v1/m/agents/context", json: { world: this.deps.identity().world, npc, text } });
    } catch (err) {
      if (!isLiveforgeError(err) || !err.retryable) throw err;
    }
  }

  /** Every agent step (goal, thought, tool call, tool result, plan, done) as Brain entries; optionally one NPC. */
  onStep(cb: (step: BrainEntry) => void, npc?: string): Unsubscribe {
    return this.deps.brain.subscribe(cb, { source: "agents", ...(npc ? { actor: npc } : {}) });
  }

  /** A run ended (server or local). */
  onDone(cb: (done: AgentDone) => void): Unsubscribe {
    return this.events.on("done", cb);
  }

  // ------------------------------------------------------------------ tool calls from the server

  private async onToolCall(d: TypedDirective<"agent.tool_call">): Promise<void> {
    const { agent, runId, callId, tool, input } = d.args;
    if (this.handled.has(callId)) return;
    this.handled.add(callId);
    this.handledOrder.push(callId);
    if (this.handledOrder.length > 500) this.handled.delete(this.handledOrder.shift() as string);
    const t = this.tools.get(agent)?.get(tool) ?? this.tools.get("*")?.get(tool);
    if (!t) {
      await this.postResult(runId, callId, false, `this game has no "${tool}" tool for ${agent}`);
      return;
    }
    const ac = new AbortController();
    let set = this.inflight.get(runId);
    if (!set) this.inflight.set(runId, (set = new Set()));
    set.add(ac);
    let last = 0;
    const progress = (text: string) => {
      const now = Date.now();
      if (now - last < 1000) return;
      last = now;
      this.deps.request({ method: "POST", path: "/v1/m/agents/progress", json: { runId, callId, text: String(text).slice(0, 300) } }).catch(() => this.deps.signal("agent.tool_progress", { runId, callId, text: String(text).slice(0, 300) }));
    };
    let ok = true;
    let output: unknown;
    try {
      output = await t.run(input, { npc: agent, runId, callId, progress, signal: ac.signal });
    } catch (err) {
      ok = false;
      output = errText(err);
    } finally {
      set.delete(ac);
      if (!set.size) this.inflight.delete(runId);
    }
    if (ac.signal.aborted) return;
    await this.postResult(runId, callId, ok, output);
  }

  private async postResult(runId: string, callId: string, ok: boolean, output: unknown): Promise<void> {
    const out = jsonable(output);
    try {
      await this.deps.request({ method: "POST", path: "/v1/m/agents/result", json: { runId, callId, ok, output: out } });
    } catch {
      // the route failed: the signal path is batched and retried
      this.deps.signal("agent.tool_result", { runId, callId, ok, output: out });
    }
  }

  // ------------------------------------------------------------------ offline runner

  private stopLocal(npc: string, _reason: string): void {
    const r = this.localRuns.get(npc);
    if (!r) return;
    r.abort.abort();
    this.localRuns.delete(npc);
  }

  private runLocal(npc: string, goal: string, opts: AgentGoalOptions): AgentGoalResult {
    this.stopLocal(npc, "a new goal arrived");
    const tools = this.toolsFor(npc);
    const plan = planAgentGoal(goal, { tools: tools.map((t) => ({ name: t.name, schema: t.schema })) });
    const runId = randomId("lrun");
    const run: LocalRun = { runId, abort: new AbortController() };
    this.localRuns.set(npc, run);
    const brain = this.deps.brain;
    const labels = plan.steps.map((s) => s.label);
    brain.add({ source: "agents", actor: npc, kind: "goal", text: goal, ref: runId, data: { runId, local: true } });
    brain.add({ source: "agents", actor: npc, kind: "plan", text: labels.join(" → ") || "nothing I can do with my tools", ref: runId, model: "rules", data: { template: plan.template } });
    const steps = plan.steps.slice(0, Math.max(1, opts.maxSteps ?? 12));
    void (async () => {
      let allOk = steps.length > 0;
      for (const s of steps) {
        if (run.abort.signal.aborted) break;
        const t = tools.find((x) => x.name === s.tool);
        if (!t) continue;
        const callId = randomId("lcall");
        brain.add({ source: "agents", actor: npc, kind: "tool_call", text: `${s.tool}(${JSON.stringify(s.input).slice(0, 160)})`, ref: runId, model: "rules", data: { callId, tool: s.tool, input: s.input } });
        const started = Date.now();
        let ok = true;
        let output: unknown;
        try {
          output = await t.run(s.input, { npc, runId, callId, signal: run.abort.signal, progress: (text) => brain.add({ source: "agents", actor: npc, kind: "tool_result", text: `${s.tool}: ${String(text).slice(0, 200)}`, ref: runId, data: { callId, progress: true } }) });
        } catch (err) {
          ok = false;
          output = errText(err);
        }
        allOk &&= ok;
        brain.add({ source: "agents", actor: npc, kind: "tool_result", text: `${s.tool} ${ok ? "ok" : "failed"}: ${JSON.stringify(jsonable(output)).slice(0, 200)}`, ref: runId, ms: Date.now() - started, data: { callId, tool: s.tool, ok, output: jsonable(output) } });
      }
      const interrupted = run.abort.signal.aborted;
      if (this.localRuns.get(npc) === run) this.localRuns.delete(npc);
      const state = interrupted ? "interrupted" : allOk ? "done" : "failed";
      const summary = interrupted ? "Interrupted." : allOk ? `Done: ${goal}`.slice(0, 300) : steps.length ? `Tried: ${goal} (some steps failed)`.slice(0, 300) : "No registered tool fits this goal.";
      brain.add({ source: "agents", actor: npc, kind: "decision", text: `${state === "done" ? "Done" : state === "interrupted" ? "Interrupted" : "Gave up"}: ${summary}`, ref: runId, data: { runId, state, local: true } });
      this.events.emit("done", { runId, npc, ok: state === "done", summary, state, local: true });
    })();
    return { runId, accepted: true, plan: labels, local: true };
  }
}

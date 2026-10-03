// Agents (Livecraft spec §1.1): server-run, tool-calling NPC loops. The game registers tools (JSON Schema), asks
// `agent.goal`, executes each pushed `agent.tool_call` directive and posts `agent.tool_result`. This file holds the
// wire shapes (tool specs, the agents.runs projection) and the keyless goal planner shared by the server rules
// fallback and the SDK's offline runner.
import { z } from "zod";
import { Timestamp } from "./common.js";

/** Tool names follow the Anthropic tool-name rule. */
export const AGENT_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** A tool the game implements: name, what it does (the model reads it) and a JSON Schema for its input. */
export const AgentToolSpec = z.object({
  name: z.string().regex(AGENT_TOOL_NAME, "tool names are letters, digits, _ and - (1-64 chars)"),
  description: z.string().max(1000).default(""),
  /** JSON Schema (type "object") for the tool input. */
  schema: z.record(z.string(), z.unknown()).default({ type: "object", properties: {} }),
});
export type AgentToolSpec = z.infer<typeof AgentToolSpec>;
export type AgentToolSpecInput = z.input<typeof AgentToolSpec>;

export const AGENT_RUN_STATES = ["running", "done", "failed", "interrupted"] as const;
export type AgentRunState = (typeof AGENT_RUN_STATES)[number];
export const AGENT_STEP_KINDS = ["plan", "thought", "tool_call", "tool_result", "error", "done"] as const;
export type AgentStepKind = (typeof AGENT_STEP_KINDS)[number];

/** One loop step (event lf.agents.step). */
export const AgentStep = z.object({
  i: z.number().int(),
  kind: z.enum(AGENT_STEP_KINDS),
  ts: Timestamp,
  tool: z.string().optional(),
  callId: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  ok: z.boolean().optional(),
  text: z.string().optional(),
  /** Model id, or "rules". */
  model: z.string().optional(),
  ms: z.number().optional(),
});
export type AgentStep = z.infer<typeof AgentStep>;

/** One run (events lf.agents.run + lf.agents.step). */
export const AgentRun = z.object({
  runId: z.string(),
  npc: z.string(),
  goal: z.string(),
  state: z.enum(AGENT_RUN_STATES),
  /** ai = model loop, rules = scripted goal template. */
  source: z.enum(["ai", "rules"]).default("rules"),
  player: z.string().nullable().default(null),
  startedAt: Timestamp,
  endedAt: Timestamp.optional(),
  plan: z.array(z.string()).default([]),
  summary: z.string().optional(),
  steps: z.array(AgentStep).default([]),
});
export type AgentRun = z.infer<typeof AgentRun>;

/** Projection "agents.runs" (scope world) - owner K6: the last 20 runs with their steps, newest last. */
export const AgentRuns = z.object({ runs: z.array(AgentRun).default([]) });
export type AgentRuns = z.infer<typeof AgentRuns>;

// ---------------------------------------------------------------- keyless goal planner

/** Goal templates of the rules fallback (keyword-matched, in this priority). */
export const AGENT_GOAL_TEMPLATES = ["build", "fetch", "follow", "guard", "trade", "go_to", "say"] as const;
export type AgentGoalTemplate = (typeof AGENT_GOAL_TEMPLATES)[number];

export interface AgentPlanStep {
  tool: string;
  input: Record<string, unknown>;
  /** Human line for the plan list / Brain View ("build: a cosy house"). */
  label: string;
}

export interface AgentPlan {
  template: AgentGoalTemplate | "default";
  steps: AgentPlanStep[];
}

const PATTERNS: [AgentGoalTemplate, RegExp][] = [
  ["build", /\b(build|construct|make|erect|raise|put up|repair|fix|rebuild|restore)\b/],
  ["fetch", /\b(fetch|gather|collect|get|bring|mine|chop|harvest|find|dig)\b/],
  ["follow", /\b(follow|come with|accompany|escort|join)\b/],
  ["guard", /\b(guard|protect|defend|watch over|keep watch|patrol)\b/],
  ["trade", /\b(trade|sell|buy|barter|swap|deal)\b/],
  ["go_to", /\b(go|walk|head|move|run|travel|return)\s+(to|towards?|back to|into|over to)\b/],
  ["say", /\b(say|tell|announce|greet|shout|sing|warn)\b/],
];

const STOP = new Set(["me", "us", "him", "her", "them", "some", "a", "an", "the", "few", "of", "please", "more", "my", "your", "our", "and", "now"]);
const PREPS = /\b(for|to|from|at|in|into|near|by|with|and|then|before|after)\b/;

function afterVerb(goal: string, re: RegExp): string {
  const m = re.exec(goal);
  return (m ? goal.slice(m.index + m[0].length) : goal).trim();
}

/** "10 oak logs for the house" -> {count: 10, item: "oak_logs"}. */
function itemOf(rest: string): { item: string; count: number } {
  const head = rest.split(PREPS)[0] ?? rest;
  const words = head.toLowerCase().replace(/[^a-z0-9\s_]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
  let count = 1;
  const num = words.findIndex((w) => /^\d+$/.test(w));
  if (num >= 0) { count = Math.max(1, Math.min(64, Number(words[num]))); words.splice(num, 1); }
  return { item: words.slice(0, 2).join("_") || "wood", count };
}

function placeOf(rest: string): string {
  const w = rest.toLowerCase().replace(/[^a-z0-9\s_'-]/g, " ").split(/\s+/).filter((x) => x && !STOP.has(x));
  return w.slice(0, 4).join(" ") || "here";
}

const shortGoal = (g: string) => (g.length > 80 ? `${g.slice(0, 77)}...` : g);

function rawPlan(goal: string): AgentPlan {
  const g = goal.trim();
  const low = g.toLowerCase();
  const tpl = PATTERNS.find(([, re]) => re.test(low))?.[0];
  const step = (tool: string, input: Record<string, unknown>, label?: string): AgentPlanStep => ({ tool, input, label: label ?? `${tool}: ${Object.values(input).map(String).join(", ")}` });
  switch (tpl) {
    case "build":
      return { template: "build", steps: [step("say", { text: "Right, let me plan this out." }), step("build", { prompt: g }, `build: ${shortGoal(g)}`), step("say", { text: "There we are. Built to last!" })] };
    case "fetch": {
      const { item, count } = itemOf(afterVerb(low, PATTERNS[1][1]));
      return { template: "fetch", steps: [step("say", { text: `I'll fetch ${count > 1 ? `${count} ` : "some "}${item.replace(/_/g, " ")}.` }), step("gather", { item, count }), step("walk_to", { target: "player" }), step("give", { to: "player", item, count })] };
    }
    case "follow":
      return { template: "follow", steps: [step("say", { text: "Lead the way." }), step("follow", { target: "player" })] };
    case "guard": {
      const target = placeOf(afterVerb(low, PATTERNS[3][1]));
      return { template: "guard", steps: [step("say", { text: `Nothing gets past me.` }), step("guard", { target })] };
    }
    case "trade":
      return { template: "trade", steps: [step("walk_to", { target: "player" }), step("trade", { with: "player" })] };
    case "go_to": {
      const target = placeOf(afterVerb(low, PATTERNS[5][1]));
      return { template: "go_to", steps: [step("walk_to", { target })] };
    }
    case "say": {
      const text = afterVerb(g, /\b(say|tell|announce|greet|shout|sing|warn)\b/i).replace(/^(that|to\s+\w+\s+that)\s+/i, "") || g;
      return { template: "say", steps: [step("say", { text: text.slice(0, 200) })] };
    }
    default:
      return { template: "default", steps: [step("say", { text: `I'll see what I can do: ${shortGoal(g)}` })] };
  }
}

/** Fill required schema properties the template did not set (string -> the goal / "player", number -> 1, boolean -> true). */
function fitInput(input: Record<string, unknown>, schema: unknown, goal: string): Record<string, unknown> {
  const s = schema as { properties?: Record<string, { type?: string | string[] }>; required?: string[] } | undefined;
  if (!s || typeof s !== "object") return input;
  const out = { ...input };
  const props = s.properties ?? {};
  const strings = Object.values(input).filter((v) => typeof v === "string") as string[];
  for (const key of s.required ?? []) {
    if (out[key] !== undefined) continue;
    const t = props[key]?.type;
    const type = Array.isArray(t) ? t[0] : t;
    if (type === "number" || type === "integer") out[key] = 1;
    else if (type === "boolean") out[key] = true;
    else if (type === "array") out[key] = [];
    else if (type === "object") out[key] = {};
    else out[key] = strings[0] ?? (/target|to|who|with/.test(key) ? "player" : goal);
  }
  return out;
}

/**
 * Keyless plan for a goal: the first matching template (build, fetch, follow, guard, trade, go_to, say; else a
 * polite "say"). With `tools` (the registered tool specs), steps whose tool is missing are dropped and required
 * inputs are filled from each tool's schema. Deterministic.
 */
export function planAgentGoal(goal: string, opts: { tools?: readonly { name: string; schema?: unknown }[] } = {}): AgentPlan {
  const plan = rawPlan(goal);
  if (!opts.tools) return plan;
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const steps = plan.steps.filter((s) => byName.has(s.tool)).map((s) => ({ ...s, input: fitInput(s.input, byName.get(s.tool)!.schema, goal) }));
  return { template: plan.template, steps };
}

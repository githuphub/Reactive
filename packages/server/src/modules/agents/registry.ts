// Agent tool registry + world context. Tools come from runtime registrations (POST /v1/m/agents/register, stored in
// kv per NPC, "*" = every NPC) validated against the manifest allow-list `agents.tools` when it is non-empty; with
// no registrations the allow-list itself is the tool set. World context (the game's latest situation text) is kept
// in kv per (world, npc | "*").
import { AgentToolSpec, type AgentToolSpecInput } from "@liveforge/protocol";
import type { Manifest } from "@liveforge/manifest";
import type { ModuleContext } from "../../module.js";
import type { LlmToolDef } from "../../providers/index.js";

const toolsKey = (npc: string) => `tools:${npc}`;
const contextKey = (world: string, npc: string) => `context:${world}:${npc}`;
const goalsKey = (world: string, npc: string) => `goals:${world}:${npc}`;

export interface RegisterResult {
  npc: string;
  registered: string[];
  rejected: { name: string; reason: string }[];
}

/** Validate + store a game's tools for an NPC ("*" = all NPCs). Replaces that NPC's earlier registration. */
export function registerTools(ctx: Pick<ModuleContext, "kv" | "manifest">, npc: string, raw: unknown): RegisterResult {
  const allow = ctx.manifest.agents.tools;
  const allowNames = new Set(allow.map((t) => t.name));
  const out: RegisterResult = { npc, registered: [], rejected: [] };
  const keep: AgentToolSpec[] = [];
  for (const t of Array.isArray(raw) ? raw.slice(0, 64) : []) {
    const parsed = AgentToolSpec.safeParse(t as AgentToolSpecInput);
    const name = typeof (t as { name?: unknown })?.name === "string" ? (t as { name: string }).name : "?";
    if (!parsed.success) {
      out.rejected.push({ name, reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      continue;
    }
    const spec = parsed.data;
    if (allowNames.size && !allowNames.has(spec.name)) {
      out.rejected.push({ name: spec.name, reason: `not in the manifest agents.tools allow-list (${[...allowNames].join(", ")})` });
      continue;
    }
    if (spec.schema.type !== undefined && spec.schema.type !== "object") {
      out.rejected.push({ name: spec.name, reason: "schema must be a JSON Schema with type: object" });
      continue;
    }
    if (keep.some((k) => k.name === spec.name)) continue;
    keep.push(spec);
    out.registered.push(spec.name);
  }
  ctx.kv.set(toolsKey(npc), keep);
  return out;
}

/** The tools an NPC can use: its registrations + "*" registrations (filtered by the allow-list), else the allow-list. */
export function toolsFor(ctx: Pick<ModuleContext, "kv" | "manifest">, npc: string): AgentToolSpec[] {
  const m = ctx.manifest;
  const allow = new Map(m.agents.tools.map((t) => [t.name, t]));
  const mine = ctx.kv.get<AgentToolSpec[]>(toolsKey(npc)) ?? [];
  const shared = npc === "*" ? [] : ctx.kv.get<AgentToolSpec[]>(toolsKey("*")) ?? [];
  const merged = new Map<string, AgentToolSpec>();
  for (const t of [...shared, ...mine]) merged.set(t.name, t);
  let list = [...merged.values()];
  if (allow.size) {
    list = list.filter((t) => allow.has(t.name)).map((t) => ({ ...t, description: t.description || allow.get(t.name)!.description }));
    if (!list.length) list = [...allow.values()].map((t) => ({ name: t.name, description: t.description, schema: t.schema }));
  }
  return list;
}

/** Anthropic tool definitions (input_schema always an object schema). */
export function toLlmTools(specs: readonly AgentToolSpec[]): LlmToolDef[] {
  return specs.map((t) => {
    const s = { ...t.schema } as Record<string, unknown>;
    if (s.type === undefined) s.type = "object";
    if (s.type === "object" && s.properties === undefined) s.properties = {};
    return { name: t.name, description: t.description || t.name.replace(/_/g, " "), input_schema: s };
  });
}

/** Store the game's latest situation text for one NPC (or "*" for everyone in the world). Empty text clears it. */
export function setContext(ctx: Pick<ModuleContext, "kv">, world: string, npc: string, text: string): void {
  const t = text.trim().slice(0, 4000);
  if (t) ctx.kv.set(contextKey(world, npc), { text: t, ts: Date.now() });
  else ctx.kv.delete(contextKey(world, npc));
}

/** World context for an NPC: the "*" text then the NPC's own. */
export function contextFor(ctx: Pick<ModuleContext, "kv">, world: string, npc: string): string {
  const all = ctx.kv.get<{ text: string }>(contextKey(world, "*"))?.text ?? "";
  const own = ctx.kv.get<{ text: string }>(contextKey(world, npc))?.text ?? "";
  return [all, own].filter(Boolean).join("\n");
}

/** Goal stack (newest first, max 5): pushed on agent.goal, popped when a run finishes its goal. */
export function goalStack(ctx: Pick<ModuleContext, "kv">, world: string, npc: string): string[] {
  return ctx.kv.get<string[]>(goalsKey(world, npc)) ?? [];
}
export function pushGoal(ctx: Pick<ModuleContext, "kv">, world: string, npc: string, goal: string): string[] {
  const list = [goal, ...goalStack(ctx, world, npc).filter((g) => g !== goal)].slice(0, 5);
  ctx.kv.set(goalsKey(world, npc), list);
  return list;
}
export function popGoal(ctx: Pick<ModuleContext, "kv">, world: string, npc: string, goal: string): void {
  ctx.kv.set(goalsKey(world, npc), goalStack(ctx, world, npc).filter((g) => g !== goal));
}

/** Manifest agent limits with module option overrides (`modules.agents: {options: {stepTimeoutMs}}`). */
export function agentLimits(m: Manifest, options: Record<string, unknown>) {
  return {
    maxSteps: m.agents.maxSteps,
    toolTimeoutMs: m.agents.toolTimeoutMs,
    maxTokens: m.agents.maxTokens,
    stepTimeoutMs: typeof options.stepTimeoutMs === "number" ? Math.max(5000, Math.min(120_000, options.stepTimeoutMs)) : 30_000,
  };
}

// Brain feed + Livecraft-era shapes the new panels read (Agents, Builds, Brain, cassette badge).
// TODO(merge): K6 adds `BrainEntry`, the `agents.runs` projection and `lf.builder.planned` to @liveforge/protocol.
// Until then these local mirrors are deliberately loose (every field optional except the essentials) so the panels
// render whatever the server sends.
import type { StoredEvent } from "@liveforge/protocol";

export const BRAIN_SOURCES = ["agents", "builder", "factions", "director", "reactions", "forge", "persona"] as const;
export type BrainSource = (typeof BRAIN_SOURCES)[number];
export type BrainModel = "sonnet" | "haiku" | "rules" | "cache" | "replay";

/** Spec §4 BrainEntry. */
export interface BrainEntry {
  id: string;
  ts: number;
  source: BrainSource | string;
  actor: string;
  kind: "goal" | "thought" | "tool_call" | "tool_result" | "plan" | "decision" | "line" | string;
  text: string;
  data?: Record<string, unknown>;
  model?: BrainModel | string;
  ms?: number;
}

/** One step of an agent run (agents.runs projection, lf.agents.step). */
export interface AgentStep {
  i?: number;
  kind?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  ok?: boolean;
  text?: string;
  model?: string;
  ms?: number;
  ts?: number;
}

export interface AgentRun {
  runId: string;
  npc: string;
  goal: string;
  state?: string;
  startedAt?: number;
  updatedAt?: number;
  plan?: string[];
  steps: AgentStep[];
  summary?: string;
}

/** lf.builder.planned {npc?, prompt, plan, summary, source}. */
export interface BuildEntry {
  id: string;
  ts: number;
  player: string | null;
  npc?: string;
  prompt: string;
  summary: string;
  source: string;
  model?: string;
  plan: VoxelPlanLike;
  materials?: Record<string, number>;
}

/** Spec §3 Voxel DSL v1 (loose mirror). */
export interface VoxelPlanLike {
  name?: string;
  palette?: Record<string, string>;
  ops: Record<string, unknown>[];
}

export type CassetteMode = "live" | "record" | "replay";
export interface CassetteInfo {
  mode: CassetteMode;
  count: number;
  liveAvailable: boolean;
  dir?: string;
  stats?: { hits: number; looseHits: number; fuzzyHits: number; misses: number; recorded: number };
  cassettes?: { key: string; model: string; createdAt: number; preview: string; streamed: boolean }[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const badge = (model: unknown, source?: unknown): BrainModel => {
  const m = s(model);
  if (m.startsWith("replay:") || s(source) === "replay") return "replay";
  if (/haiku/i.test(m)) return "haiku";
  if (/sonnet|opus|claude/i.test(m)) return "sonnet";
  if (s(source) === "cache") return "cache";
  if (s(source) === "ai") return "sonnet";
  return "rules";
};

/**
 * Derive a Brain entry from a stored event, so the feed works even before (or without) the K6 `brain` WS message:
 * K6/K7 module events and Director decisions all carry enough to show.
 */
export function brainFromEvent(e: StoredEvent): BrainEntry | null {
  const d = e.data;
  const id = `ev${e.seq}`;
  switch (e.type) {
    case "lf.brain":
    case "lf.brain.entry": {
      const b = (isObj(d.entry) ? d.entry : d) as Partial<BrainEntry>;
      if (!b.text) return null;
      return { id: s(b.id) || id, ts: b.ts ?? e.ts, source: s(b.source) || "agents", actor: s(b.actor) || "?", kind: s(b.kind) || "line", text: s(b.text), ...(isObj(b.data) ? { data: b.data } : {}), ...(b.model ? { model: b.model } : {}), ...(typeof b.ms === "number" ? { ms: b.ms } : {}) };
    }
    case "lf.agents.step": {
      const kind = s(d.kind) || (d.tool ? "tool_call" : "thought");
      const text = s(d.text) || (d.tool ? `${s(d.tool)}(${JSON.stringify(d.input ?? {}).slice(0, 120)})${d.output !== undefined ? ` -> ${JSON.stringify(d.output).slice(0, 120)}` : ""}` : kind);
      return { id, ts: e.ts, source: "agents", actor: s(d.npc) || s(d.agent) || s(d.runId), kind, text, data: d, model: badge(d.model, d.source), ...(typeof d.ms === "number" ? { ms: d.ms } : {}) };
    }
    case "lf.agents.run":
      return { id, ts: e.ts, source: "agents", actor: s(d.npc), kind: "goal", text: `${s(d.state) || "run"}: ${s(d.goal)}`, data: d, model: badge(d.model, d.source) };
    case "lf.builder.planned":
      return { id, ts: e.ts, source: "builder", actor: s(d.npc) || "builder", kind: "plan", text: s(d.summary) || `plan for "${s(d.prompt)}"`, data: d, model: badge(d.model, d.source) };
    case "lf.factions.decision":
      return { id, ts: e.ts, source: "factions", actor: s(d.faction), kind: "decision", text: `${s(d.faction)} → ${s(d.posture)} (prices x${s(d.priceMult)}). ${s(d.announcement)}`, data: d, model: badge(d.model, d.source) };
    case "lf.factions.raid_plan": {
      const plan = isObj(d.plan) ? d.plan : {};
      const waves = Array.isArray(plan.waves) ? (plan.waves as Record<string, unknown>[]) : [];
      return { id, ts: e.ts, source: "factions", actor: s(d.faction), kind: "plan", text: `raid vs ${s(d.player) || e.player}: ${waves.map((w) => `${s(w.count)} ${s(w.mob)} (${s(w.tactic)})`).join(", ")} — ${s(plan.why)}`, data: d, model: badge(d.model, d.source) };
    }
    case "lf.director.decision": {
      const dec = isObj(d.decision) ? d.decision : {};
      if (["faction_posture", "raid_plan"].includes(s(dec.kind))) return null; // already shown from lf.factions.*
      return { id, ts: e.ts, source: "director", actor: s(dec.kind) || "director", kind: "decision", text: `${s(dec.summary)} — ${s(dec.why)}`, data: dec, model: badge((dec.data as Record<string, unknown> | undefined)?.model, dec.source) };
    }
    default:
      return null;
  }
}

/** De-dupe key: the same step can arrive as a WS brain entry and as an event. */
export const brainSig = (b: BrainEntry): string => `${b.source}|${b.kind}|${b.actor}|${b.text.slice(0, 80)}`;

export const MODEL_COLORS: Record<string, string> = { sonnet: "#9085e9", haiku: "#3987e5", rules: "#8a93a6", cache: "#199e70", replay: "#c98500" };
export const BRAIN_SOURCE_COLORS: Record<string, string> = {
  agents: "#ff7a2f", builder: "#c98500", factions: "#d95926", director: "#9085e9", reactions: "#d55181", forge: "#199e70", persona: "#3987e5",
};

/** Tolerant reader for the agents.runs projection: {runs: [...]}, a bare array, or {runs: {id: run}}. */
export function normaliseRuns(st: unknown): AgentRun[] {
  const list: unknown[] = Array.isArray(st) ? st : isObj(st) && Array.isArray(st.runs) ? st.runs : isObj(st) && isObj(st.runs) ? Object.values(st.runs) : [];
  const out: AgentRun[] = [];
  for (const r of list) {
    if (!isObj(r)) continue;
    const steps = (Array.isArray(r.steps) ? r.steps : []).filter(isObj).map((x, i) => ({ i: typeof x.i === "number" ? x.i : i, ...x }) as AgentStep);
    out.push({
      runId: s(r.runId) || s(r.id) || `run${out.length}`,
      npc: s(r.npc) || s(r.agent) || "?",
      goal: s(r.goal) || "",
      state: s(r.state) || s(r.status) || undefined,
      startedAt: typeof r.startedAt === "number" ? r.startedAt : typeof r.ts === "number" ? r.ts : undefined,
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : undefined,
      plan: Array.isArray(r.plan) ? r.plan.map(s) : undefined,
      steps,
      summary: s(r.summary) || undefined,
    });
  }
  return out.sort((a, b) => (b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0));
}

/** lf.builder.planned event -> BuildEntry (null when it carries no plan). */
export function buildFromEvent(e: StoredEvent): BuildEntry | null {
  const d = e.data;
  const plan = isObj(d.plan) && Array.isArray(d.plan.ops) ? (d.plan as unknown as VoxelPlanLike) : null;
  if (!plan) return null;
  return {
    id: `ev${e.seq}`, ts: e.ts, player: e.player, npc: s(d.npc) || undefined, prompt: s(d.prompt), summary: s(d.summary), source: s(d.source) || "rules",
    model: s(d.model) || undefined, plan, ...(isObj(d.materials) ? { materials: d.materials as Record<string, number> } : {}),
  };
}
